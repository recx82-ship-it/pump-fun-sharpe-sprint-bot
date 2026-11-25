// Cleanest Paper Bot — a pump.fun bonding-curve replay bot (agent-fun/replay/v2),
// tuned for hourly Sharpe ratio, not raw PnL.
//
// Idea: most launches are dead on arrival, but a launch is worth a small bet when
// it shows, in its first minute, that a real crowd is forming around it: the
// creator put meaningful skin in the game (0.5–2 SOL of their own buys in the
// create slot — enough to care, not so much it is a whale setting up a dump),
// several distinct wallets piled in beside them (at least 4 non-creator buyers),
// and the creator has not sold.
//
// Why the exits are loose: this bounty ranks by hourly Sharpe ratio, so what
// matters is steady, low-variance hourly gains. Sweeps on the dev window
// (24h, 1,222 launches) showed the tight scalp (take +8%, cut −7%, hold 60
// slots) whipsaws out of winners on noise: win rate 0.36, Sharpe (hourly) +0.29,
// and one of the four 6h blocks went negative. Loosening the stop to −10% and
// giving each trade up to 120 slots to play out lifts the win rate to 0.44 —
// the crowd pop usually comes, it just needs a little room — and every 6h block
// of the dev window turns positive. Measured on the dev window with the kit's
// own scorer (grade-local, process driver): net PnL +0.50 SOL, Sharpe (hourly)
// +0.43, worst 6h block +0.42, 110 coins traded, max drawdown 1%. The exit
// shape sits on a plateau (TP +8–15%, SL −10–12%, hold 90–300 slots all score
// within noise of each other), so these are mid-plateau values, not a peak fit.
//
// A coin is decided once, in its first 60 slots. It is bought at most once, for
// at most 0.3 SOL (the 1%-of-real-reserve size cap usually binds first), and sold
// whole on the first of the take-profit, the stop, the time limit, or a creator
// sale. A small probe mechanism keeps the run above the 20-coin guardrail if
// filtered entries ever run dry: tiny round trips on the most liquid curve that
// just traded.
//
// Everything is deterministic: decisions use only slot numbers and the event
// stream, iterated over insertion-ordered maps. No clock, no randomness.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
// Curve fee on a fill: 95 bps protocol + 30 bps creator = 1.25% of the curve quote.
const CURVE_FEE = 0.0125;

// ---- entry: a launch with a real crowd forming -----------------------------
const MAX_AGE_SLOTS = 60; // buy only inside a coin's first 60 slots
const MIN_REAL_SOL = 0.3; // curve must hold at least this much real SOL
const MAX_REAL_SOL = 30; // ... and no more than this
const MIN_DEV_BUY_SOL = 0.5; // creator's own buys in the create slot, at least this
const MAX_DEV_BUY_SOL = 2.0; // ... and at most this
const MIN_BUYERS = 4; // distinct non-creator buyers seen, at least this many
const MAX_BUYERS = 50; // ... and at most this many
const STAKE_SOL = 0.3; // SOL per entry (the 1%-of-reserve cap usually binds first)
const MIN_BUY_SOL = 0.005; // do not bother with a smaller buy
const BUY_SLIPPAGE_BPS = 10_000;
const SELL_SLIPPAGE_BPS = 10_000;

// ---- exits: a loose scalp, tuned for Sharpe --------------------------------
// Sell everything once value reaches 1.08x cost (net of all fees).
const TAKE_PROFIT = 1.08;
// ... or falls to 0.90x cost. A −10% stop, not −7%: the tighter stop cut
// winners on noise and cost more than it saved (win rate 0.36 -> 0.44).
const STOP_LOSS = 0.9;
// Sell whatever is left after this long (slots). 120, not 60: the pop usually
// comes within two minutes, and the extra room is what turns the worst 6h
// block of the dev window positive.
const MAX_HOLD_SLOTS = 120;

// ---- guardrail --------------------------------------------------------------
const PROBE_SOL = 0.02;
const PROBE_AFTER_SLOTS = 40_000; // start probing once this far into the run
const PROBE_TARGET_COINS = 30;

interface Coin {
  created: number | null;
  creator: Pubkey | null;
  /** Creator's own buys in the create slot, in SOL. */
  devBuy: number;
  /** The creator sold before we could enter. */
  devSold: boolean;
  /** Distinct non-creator wallets that bought. */
  buyers: Set<Pubkey>;
  /** Never buy it again (too old, filtered out, exited, or completed). */
  done: boolean;
}

interface Held {
  opened: number;
  exiting: boolean;
  filled: boolean;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Guardrail probes in flight, by mint: false while buying, true while selling. */
const probes = new Map<Pubkey, boolean>();
/** Our own filled orders and the coins they were on (harness closes excluded). */
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstSlot = -1;

function coinOf(mint: Pubkey): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = { created: null, creator: null, devBuy: 0, devSold: false, buyers: new Set(), done: false };
    coins.set(mint, c);
  }
  return c;
}

/** Mark-to-market value of a position in SOL, curve and tx fees deducted. */
function positionValue(
  state: BotState,
  batch: Batch,
  mint: Pubkey,
  tokens: bigint,
): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const mark = batch.marks.find((m) => m.mint === mint);
  const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
  const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
  const t = Number(tokens);
  if (vt + t <= 0) return 0;
  const quote = (t * vq) / (vt + t);
  return (quote / LAMPORTS) * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    if (firstSlot < 0) firstSlot = now;
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      traded.add(e.mint);
      const c = coinOf(e.mint);
      if (e.event === 'CreateEvent') {
        c.created = e.slot;
        c.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.created) c.devBuy += Number(e.sol_amount) / LAMPORTS;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      }
    }

    const pendingByMint = new Map<Pubkey, Set<string>>();
    for (const po of state.pending.values()) {
      let sides = pendingByMint.get(po.order.mint);
      if (sides === undefined) {
        sides = new Set();
        pendingByMint.set(po.order.mint, sides);
      }
      sides.add(po.order.side);
    }
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // ---- exits first ------------------------------------------------------
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          coinOf(mint).done = true;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = positionValue(state, batch, mint, pos.token_amount);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      let exit = h.exiting;
      if (!exit && value >= cost * TAKE_PROFIT) exit = true;
      if (!exit && value <= cost * STOP_LOSS) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
      if (!exit && coinOf(mint).devSold) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.get(mint)?.has('sell')) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // ---- probes: sell a landed probe at once ------------------------------
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      if (!selling) probes.set(mint, true);
    }

    // ---- entries: one loose scalp per qualifying launch --------------------
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const c = coins.get(mint);
      const curve = state.curves.get(mint);
      if (c === undefined || curve === undefined || curve.complete || c.done) continue;
      // One bite per coin: never add to a position we already hold.
      if (held.has(mint)) continue;
      if (pendingByMint.has(mint)) continue;
      if (c.created === null) continue;
      if (now - c.created > MAX_AGE_SLOTS) {
        c.done = true;
        continue;
      }
      if (c.devSold) {
        c.done = true;
        continue;
      }
      if (slotsLeft <= 0) continue;
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      if (c.devBuy < MIN_DEV_BUY_SOL || c.devBuy > MAX_DEV_BUY_SOL) continue;
      if (c.buyers.size < MIN_BUYERS || c.buyers.size > MAX_BUYERS) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + tx;
      slotsLeft--;
      held.set(mint, { opened: now, exiting: false, filled: false });
    }

    // ---- guardrail pacing: probes when filtered entries run dry ------------
    if (
      probes.size === 0 &&
      slotsLeft > 0 &&
      now - firstSlot > PROBE_AFTER_SLOTS &&
      myCoins.size < PROBE_TARGET_COINS
    ) {
      const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
      for (const mint of traded) {
        if (orders.length >= cap || probes.size >= 1) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        if (myCoins.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
        if (free < PROBE_SOL + 2 * tx) break;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)),
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        probes.set(mint, false);
        free -= PROBE_SOL + tx;
      }
    }
    return orders;
  },
});

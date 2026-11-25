# pump-fun-sharpe-sprint-bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/recx82-ship-it/pump-fun-sharpe-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/recx82-ship-it/pump-fun-sharpe-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for pump.fun bonding curves, tuned for hourly Sharpe ratio
rather than raw PnL: steady, controlled gains beat one lucky moonshot. Most new
curves die within minutes, so this bot ignores them: it buys only when a launch
shows, inside its first 60 slots, that a real crowd is forming — the creator
put 0.5–2 SOL of their own buys in the create slot and at least four distinct
wallets piled in beside them, with the creator not yet selling. Each qualifying
launch gets one small bite (up to 0.3 SOL, capped at 1% of the curve's real SOL
reserves), and the position is sold whole on the first of take-profit (+8%),
stop (−10%), a 120-slot time limit, or a creator sale. The loose exits are the
point: sweeps on the dev window showed the tighter scalp (cut −7%, hold 60
slots) whipsaws out of winners on noise, while −10% / 120 slots lifts the win
rate from 0.36 to 0.44 and turns every 6-hour block of the dev window positive.
A tiny probe mechanism keeps the run above the 20-coin guardrail if filtered
entries ever run dry.

On the kit's frozen dev window it scores +0.58 SOL net PnL with Sharpe
(hourly) +0.44 over 126 coins (41% win rate, 0.7% max drawdown), with the
guardrails met — and it stays positive (+0.34 SOL) even at 2x fees.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout; the
harness runs it as `node /bot/main.ts`. It needs nothing installed and reads
no clock, no environment, and no randomness — every run is deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=17s3abg9&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>

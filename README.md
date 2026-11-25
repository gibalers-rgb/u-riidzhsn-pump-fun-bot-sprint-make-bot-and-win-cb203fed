[![Competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/gibalers-rgb/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/gibalers-rgb/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Strict-momentum paper bot

A paper trading bot for the pump.fun replay (agent-fun/replay/v2): it reads
the replay's market events as they arrive and trades paper SOL on bonding
curves — no live funds, no wallet, no network. It buys only old, crowded,
still-accelerating curves (300–3000 slots old, 3–80 SOL real reserve,
price +5% and at the 60-slot high, buy volume doubling, at least 10
distinct buyers, net inflow at least 3 SOL), sizes in two stages (0.10 SOL
starter + one 0.10 SOL add-on into strength), and sells whole at +60% take
profit, -12% stop loss, a -15% trailing stop once +20% is banked, on
fading flow, a big sell, or a 3000-slot hold limit. Dev-window net PnL
-0.374 SOL over 169 round trips — the best of 13 variants swept on the dev
tape. Run it as `node main.ts` (Node 22); the strategy is in `strategy.ts`.

// Breakout-continuation paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts`. The trading rules live in strategy.ts;
// the wire shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte
// under vendor/. No dependencies, no network, no real money: this is a paper
// sprint on replayed chain data only.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));

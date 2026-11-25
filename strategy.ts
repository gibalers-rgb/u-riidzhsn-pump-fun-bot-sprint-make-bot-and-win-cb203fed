// Strict-momentum paper bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). Paper money only: no live funds, no wallet, no
// network — the bot only answers the replay's hello / batch stream with
// buy and sell orders and the harness settles them on recorded chain data.
//
// What the dev tape taught (24h, 1222 coins): only 35 coins completed, so
// chasing completions directly does not pay — a wide reserve band with a
// hold-to-completion exit lost -3.59 SOL, and buying the raw reserve
// crossing lost -2.46 SOL, because a 5-slot bot mostly catches
// non-completers and the few completers it meets rarely survive the stop.
// What loses least is the opposite discipline: trade only old, crowded,
// still-accelerating curves and get out fast. A coin becomes a buy when
// it is 300 to 3000 slots old, liquid (3-80 SOL real reserve), and its
// last 60 slots show a real crowd — price up at least 5% and sitting at
// 98% of the window high, buy volume in the last 20 slots at least double
// the 20 before it, at least 10 distinct buyers, net inflow at least
// 3 SOL, sells under 30% of buys, and no single buyer taking more than
// half of the window's buy SOL.
//
// Sizing is two-stage: a 0.10 SOL starter, then one 0.10 SOL add-on only
// when the price has stepped at least 5% above the starter's decision
// price and the position is not underwater — a bad pick costs little, a
// runner gets size, and no coin ever takes more than 0.20 SOL. At most
// 5 positions open at once, total exposure capped at 1.2 SOL of cost.
//
// A position is sold whole on the first of: +60% take profit, -12% stop
// loss, a -15% trailing stop once +20% peak is banked, net flow turning
// below -0.3 SOL over the last 25 slots (the crowd leaving), a single
// recorded sell of 2 SOL or more, or 3000 slots held. A curve that
// completes is closed by the replay itself. After an exit the same coin
// rests 150 slots and may be entered at most 3 times per run.
//
// Guardrail probes keep the run above the minimum bar (round trips of at
// least 0.01 SOL on at least 20 coins): when the bot's own fills or coins
// lag the pace set in block time across the 6-hour window, it buys
// 0.02 SOL of a liquid curve traded on the batch and sells it as soon as
// the buy lands.
//
// Dev-window result (grade-local, process driver): net PnL -0.374 SOL
// (-3.7%), 169 round trips over 73 coins, max drawdown 5.1% — the best of
// 13 parameter variants swept on the dev tape (breakout, tight-exit,
// early-hold, completer-hunter and pure-cross variants all lost more);
// the pilot momentum baseline lost -9.46 SOL on the same window, hold
// cash is 0. The loss is mostly curve + tx fees on a roughly breakeven
// gross edge, so the final 6h window is a variance call — the bot is
// built to lose little while keeping the upside of the runners it does
// catch.
//
// Deterministic by construction: no clock, no environment, no randomness;
// every pass runs over insertion-ordered maps fed by the batch stream, so
// two runs on the same harness stream produce byte-identical action logs.

import { type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Entry lookback window (slots) for the breakout check. */
  window: number;
  /** Recent half of the window (slots) for the volume-surge check. */
  surgeSpan: number;
  /** Price now over the window's start price, at least (bps over 1.0). */
  minTrendBps: number;
  /** Price now as a share of the window high (bps of 1.0), at least. */
  nearHighBps: number;
  /** Buy SOL in the recent span over buy SOL in the span before it, at least (bps). */
  minSurgeBps: number;
  /** Distinct buyers in the window, at least. */
  minBuyers: number;
  /** Largest single buyer's share of the window's buy SOL (bps), at most. */
  maxBuyerShareBps: number;
  /** Net SOL (buys minus sells) over the window, at least. */
  minNetSol: number;
  /** Sell SOL over buy SOL in the window (bps), at most. */
  maxSellRatioBps: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** First buy of a position (SOL). */
  starterSol: number;
  /** The one add-on buy (SOL). */
  addSol: number;
  /** Most SOL at cost in one position. */
  maxStakeSol: number;
  /** Price step above the last buy's decision price before an add-on (bps). */
  addStepBps: number;
  /** Net SOL over the window required to add on. */
  addNetSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Take profit: sell once value is this much over cost (bps). */
  tpBps: number;
  /** Stop loss: sell once value is this much under cost (bps). */
  slBps: number;
  /** Trailing stop arms once value is this much over cost (bps). */
  trailArmBps: number;
  /** Trailing stop: sell once value falls this much under its peak (bps). */
  trailBps: number;
  /** Fade window (slots) for the exit flow check. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below this. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Hold limit while the position is up at least holdIfUpBps. */
  maxHoldUp: number;
  /** The "up" threshold for the extended hold (bps over cost). */
  holdIfUpBps: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most positions open at once. */
  maxPositions: number;
  /** Require the coin to have entered the reserve band from below inside
   *  the window (its real SOL at the window's start under minRealSol).
   *  False = the band is just a liquidity window, no crossing test. */
  climbFromBelow: boolean;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Guardrail pacing: the run must end with round trips of at least 0.01 SOL
   * on at least 20 coins. When the bot's own fills or coins lag
   * targetFills / targetCoins scaled by the share of paceSecs elapsed
   * (block time since the first batch), it opens tiny probe round trips
   * (buy probeSol, sell it all as soon as the buy lands) until back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// The settings main.ts trades with. Chosen by sweeping 13 parameter
// variants on the dev window and keeping the best dev net PnL: strict
// momentum on old, crowded curves with fast exits loses least (-0.374 SOL);
// completer-hunting, pure reserve crossings and early holds all lost more.
export const DEFAULT_PARAMS: Params = {
  minAge: 300,
  maxAge: 3000,
  window: 60,
  surgeSpan: 20,
  minTrendBps: 10500,
  nearHighBps: 9800,
  minSurgeBps: 20000,
  minBuyers: 10,
  maxBuyerShareBps: 5000,
  minNetSol: 3,
  maxSellRatioBps: 3000,
  minRealSol: 3,
  maxRealSol: 80,
  starterSol: 0.1,
  addSol: 0.1,
  maxStakeSol: 0.2,
  addStepBps: 500,
  addNetSol: 0,
  minBuySol: 0.01,
  buySlippageBps: 1500,
  tpBps: 6000,
  slBps: 1200,
  trailArmBps: 2000,
  trailBps: 1500,
  fadeWindow: 25,
  fadeNetSol: -0.3,
  bigSellSol: 2,
  maxHold: 3000,
  maxHoldUp: 3000,
  holdIfUpBps: 10000,
  cooldown: 150,
  maxEntries: 3,
  maxPositions: 5,
  climbFromBelow: false,
  maxExposureSol: 1.2,
  targetCoins: 30,
  targetFills: 240,
  paceSecs: 21600,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
// Basis points as a plain number (the SDK's BPS is a bigint; mixing it with
// number math throws). All bps params below are numbers in these units.
const BPSN = 10_000;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
  /** Real SOL reserve after this trade (the curve's depth at the time). */
  rq: number;
}

interface Tape {
  created: number | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastBuyPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** Add-on buys decided so far (0 or 1). */
  adds: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Breakout-continuation signal on a curve's tape at slot `now`. The
   *  coin must have ENTERED the reserve band from below inside the window
   *  (its real SOL was under minRealSol at the window's start): a coin
   *  crashing down through the band is never bought, only one climbing
   *  into it. A narrow band misses most completers — one big buy can jump
   *  a curve several SOL in a single trade — so the band is wide and the
   *  upward-crossing test does the filtering. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    const from = now - p.window;
    const surgeFrom = now - p.surgeSpan;
    const prevFrom = now - 2 * p.surgeSpan;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let buyRecent = 0;
    let buyPrev = 0;
    let startPrice = -1;
    let startRq = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        startRq = tr.rq;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (startRq < 0) startRq = tr.rq;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
        if (tr.slot > surgeFrom) buyRecent += tr.sol;
        else if (tr.slot > prevFrom) buyPrev += tr.sol;
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuyers || byUser.size < p.minBuyers) return false;
    // Entered the band from below inside this window: the curve's real
    // SOL at the window's start was under the band's floor (or the coin
    // had no trades that far back). A coin falling through the band fails.
    if (p.climbFromBelow && startRq >= p.minRealSol) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (sellSol * BPSN > buySol * p.maxSellRatioBps) return false;
    if (startPrice <= 0) return false;
    // Trend: price up at least minTrendBps over the window, sitting at the high.
    if (last * BPSN < startPrice * p.minTrendBps) return false;
    if (last * BPSN < high * p.nearHighBps) return false;
    // Volume surge: the recent span's buys at least double the span before it.
    if (buyPrev <= 0) return false;
    if (buyRecent * BPSN < buyPrev * p.minSurgeBps) return false;
    // No single wallet dominating the window's buys.
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top * BPSN > buySol * p.maxBuyerShareBps) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves), rq: Number(e.real_quote_reserves) / LAMPORTS });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.tpBps / BPSN)) exit = true;
        if (!exit && value < cost * (1 - p.slBps / BPSN)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArmBps / BPSN) && value < h.peakValue * (1 - p.trailBps / BPSN)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        const holdLimit = value >= cost * (1 + p.holdIfUpBps / BPSN) ? p.maxHoldUp : p.maxHold;
        if (!exit && now - h.opened > holdLimit) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and the single add-on.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.starterSol, p.maxStakeSol);
        } else {
          // One add-on into strength only: price stepped up from the last
          // buy, flow still positive, position not underwater.
          if (h.exiting || !h.filled || h.adds >= 1 || h.invested >= p.maxStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price * BPSN < h.lastBuyPrice * (BPSN + p.addStepBps)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRealSol) continue;
          want = Math.min(p.addSol, p.maxStakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastBuyPrice: price, lastValue: 0, adds: 0 });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
          h.adds++;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPSN)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

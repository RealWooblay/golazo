import type { MarketEngine, Market } from "@golazo/core";

/**
 * Simulated bettors.
 *
 * WHY: a brand-new market has no house liquidity in pure parimutuel mode, so
 * demo bots provide crowd volume. They call the real `engine.placeBet`, moving
 * the same pool a human bet uses.
 *
 * Behaviour mirrors the prototype: a handful of bets trickle in over the window,
 * leaning toward the market's model probability (with noise) so favourites
 * attract more YES money.
 */

export interface BotRunner {
  /** Cancel all pending bot bets (call when the market locks or you tear down). */
  stop: () => void;
}

/**
 * Spin up bots for one market. They place between ~3 and ~7 bets spread across
 * the betting window. Each bet is guarded so it no-ops if the market already
 * locked (timer races) — placing on a locked market would throw in the engine.
 *
 * @param engine  the live MarketEngine (offline mode owns one)
 * @param market  the freshly-opened market
 * @param rng     injectable randomness (kept seedable for tests)
 */
export function runBots(
  engine: MarketEngine,
  market: Market,
  rng: () => number = Math.random,
): BotRunner {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const n = 3 + Math.floor(rng() * 5); // 3..7 bots
  const windowMs = market.windowMs;
  const gross = market.pool.yes + market.pool.no;
  const lean = gross > 0 ? market.pool.yes / gross : market.trueProb;

  for (let i = 0; i < n; i++) {
    // Keep the last ~600ms clear so bots don't try to bet as the lock fires.
    const delay = 200 + rng() * Math.max(0, windowMs - 800);
    const t = setTimeout(() => {
      const live = engine.get(market.id);
      if (!live || live.status !== "open") return; // locked/resolved — skip
      const biased = lean + (rng() - 0.5) * 0.3; // add noise around the lean
      const side = rng() < biased ? "YES" : "NO";
      const stake = 10 + Math.floor(rng() * 9) * 10; // $10..$90 in $10 steps
      try {
        engine.placeBet(market.id, `bot_${i}`, side, stake);
      } catch {
        // Race: market locked between the guard and the call. Safe to ignore.
      }
    }, delay);
    timers.push(t);
  }

  return {
    stop: () => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}

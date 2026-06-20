import { BET_DELAY_MS } from "@/lib/config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same anti-latency window the feed applies to off-chain bets — on-chain txs wait
 * here so a faster goal feed can't beat the hold.
 */
export async function holdBeforeChainBet(
  isStillOpen: () => boolean,
): Promise<{ ok: boolean; reason?: string }> {
  await sleep(BET_DELAY_MS);
  if (!isStillOpen()) {
    return { ok: false, reason: "Market closed before your bet cleared" };
  }
  return { ok: true };
}

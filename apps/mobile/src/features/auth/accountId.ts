import { isWalletAccountId } from "@golazo/core";

/** Minimal account surface for resolving a stable per-user key. */
export interface AccountIdInput {
  enabled: boolean;
  authenticated: boolean;
  id: string | null;
  solanaAddress: string | null;
}

/**
 * Stable id for leaderboard, referrals, and per-account display names.
 * Wallet address only — never Privy DID (that fragments one human into many rows).
 */
export function resolveAccountId(
  account: AccountIdInput,
  pointsUserId?: string,
): string | null {
  const embedded =
    account.enabled && account.solanaAddress ? account.solanaAddress : null;
  if (embedded) return `acct_${embedded}`;
  if (pointsUserId?.startsWith("pts_")) return pointsUserId;
  return null;
}

/** Signed-in users need the embedded wallet before public ids (board, referrals) are sent. */
export function isWalletIdentityReady(
  account: AccountIdInput,
  accountId: string | null,
): boolean {
  if (!account.enabled || !account.authenticated) return true;
  return accountId !== null && isWalletAccountId(accountId);
}

/** Same Privy session: DID key in local storage before the embedded wallet address loads. */
export function isWalletIdentityUpgrade(prev: string | null, next: string | null): boolean {
  if (!prev || !next || prev === next) return false;
  return prev.includes("did:privy") && isWalletAccountId(next);
}

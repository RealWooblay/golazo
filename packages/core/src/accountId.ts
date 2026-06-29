/** Base58 Solana address (embedded Privy wallet). */
const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Extract a Solana wallet from `acct_<address>` (or a bare address). */
export function walletAddressFromAccountId(userId: string): string | null {
  const raw = userId.startsWith('acct_') ? userId.slice(5) : userId;
  return SOLANA_BASE58.test(raw) ? raw : null;
}

/** True when the id is a durable wallet-backed account (`acct_<base58>`). */
export function isWalletAccountId(userId: string): boolean {
  return walletAddressFromAccountId(userId) !== null;
}

/** Normalize to `acct_<wallet>` or null when not a wallet id. */
export function canonicalWalletAccountId(userId: string): string | null {
  const addr = walletAddressFromAccountId(userId.trim());
  return addr ? `acct_${addr}` : null;
}

/** Legacy Privy DID ids we must fold into the wallet id once it loads. */
export function isPrivyDidAccountId(userId: string): boolean {
  const body = userId.startsWith('acct_') ? userId.slice(5) : userId;
  return body.includes('did:privy');
}

/** Whether `fromUserId` should merge into wallet `toUserId` (pts_* or acct_did → acct_wallet). */
export function shouldMergeAccountIds(fromUserId: string, toUserId: string): boolean {
  if (!fromUserId || fromUserId === toUserId) return false;
  if (!isWalletAccountId(toUserId)) return false;
  if (fromUserId.startsWith('pts_')) return true;
  return isPrivyDidAccountId(fromUserId);
}

import { useAccount } from "@/features/auth/useAccount";
import { useStore } from "@/state/store";
import { USER_ID } from "@/lib/config";

export interface PointsIdentity {
  /** The id this device sends as `points_hello`/`points_bet` (mode-aware). */
  userId: string;
  /** The paper-mode points id (account-stable when signed in). */
  pointsUserId: string;
  /** Display name to register on the leaderboard. */
  name: string;
  /** True when the id comes from a signed-in account (stable across devices). */
  fromAccount: boolean;
}

/**
 * The ONE source of truth for who you are on the points leaderboard.
 *
 * THE BUG THIS FIXES: the paper points id used to be a per-device random
 * (`pts_<rand>`), so the same account on a phone + laptop became TWO players.
 * When you're signed in we key points off the stable Privy account id instead,
 * so one account is one leaderboard player on every device. Signed out, we fall
 * back to the device-local id (anonymous paper play still works).
 *
 * Real mode keeps the engine `USER_ID` (real bets settle under it), unchanged.
 */
export function usePointsIdentity(): PointsIdentity {
  const { session } = useStore();
  const account = useAccount();
  const playMode = session.moneyMode === "points";

  const accountId =
    account.enabled && account.authenticated && account.id
      ? `acct_${account.id}`
      : null;

  const pointsUserId = accountId ?? session.pointsUserId ?? "pts_anon";
  const userId = playMode ? pointsUserId : USER_ID;
  const name =
    (accountId ? session.displayName || account.handle : session.displayName) ||
    "Player";

  return { userId, pointsUserId, name, fromAccount: accountId !== null };
}

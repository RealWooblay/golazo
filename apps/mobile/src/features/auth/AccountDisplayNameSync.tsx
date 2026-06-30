import { useEffect, useRef } from "react";
import { useAccount } from "./useAccount";
import {
  isWalletIdentityUpgrade,
  resolveAccountId,
} from "./accountId";
import { useStore } from "@/state/store";

/**
 * Keeps session.displayName scoped to the active account. Switching Privy users
 * loads that account's saved name instead of carrying the previous one forward.
 */
export function AccountDisplayNameSync() {
  const account = useAccount();
  const { hydrated, session, setSession } = useStore();
  const activeKeyRef = useRef<string | null>(null);

  const accountKey =
    account.enabled && account.ready
      ? resolveAccountId(account, session.pointsUserId)
      : null;

  useEffect(() => {
    if (!hydrated) return;
    const prev = activeKeyRef.current;
    if (prev === accountKey) return;

    const map = { ...(session.displayNamesByAccount ?? {}) };
    const currentName = session.displayName?.trim() ?? "";

    if (prev && currentName) {
      map[prev] = currentName;
    }

    if (prev && accountKey && isWalletIdentityUpgrade(prev, accountKey) && map[prev] && !map[accountKey]) {
      map[accountKey] = map[prev]!;
    }

    const loaded =
      accountKey && map[accountKey]?.trim().length
        ? map[accountKey]!.trim()
        : "";

    setSession({
      activeAccountKey: accountKey ?? undefined,
      displayNamesByAccount: map,
      displayName: loaded,
    });

    activeKeyRef.current = accountKey;
  }, [accountKey, hydrated, setSession, session.displayName, session.displayNamesByAccount]);

  return null;
}

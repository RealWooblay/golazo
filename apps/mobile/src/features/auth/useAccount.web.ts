import { usePrivy, useLogin } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { privyEnabled } from "./config";

/** A human label for how the user signed in (email / google / wallet…). */
function loginLabel(user: ReturnType<typeof usePrivy>["user"]): string | null {
  if (!user) return null;
  if (user.email?.address) return user.email.address;
  if (user.google?.email) return user.google.email;
  if (user.apple?.email) return user.apple.email;
  if (user.phone?.number) return user.phone.number;
  return "Signed in";
}

/**
 * WEB account hook — the Privy-backed identity + embedded Solana wallet.
 */
export function useAccount() {
  const enabled = privyEnabled();
  const { ready, authenticated, user, logout } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useSolanaWallets();
  const solanaAddress: string | null =
    wallets?.find(
      (w) => w.standardWallet?.features && "privy:" in w.standardWallet.features,
    )?.address ?? null;

  return {
    enabled,
    ready,
    authenticated,
    id: user?.id ?? null,
    handle: loginLabel(user),
    solanaAddress,
    login: () => login(),
    logout,
  };
}

export type AccountState = ReturnType<typeof useAccount>;

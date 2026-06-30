import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { chainConfig, type Cluster } from "@/features/chain/config";
import { defaultSolanaRpcUrl } from "@/lib/config";

export type PrivySolanaChain = "solana:mainnet" | "solana:devnet" | "solana:testnet";

const CLUSTER_WS: Record<Cluster, string> = {
  devnet: "wss://api.devnet.solana.com",
  testnet: "wss://api.testnet.solana.com",
  "mainnet-beta": "wss://api.mainnet-beta.solana.com",
  localnet: "ws://127.0.0.1:8900",
};

const PUBLIC_HTTP: Record<PrivySolanaChain, string> = {
  "solana:mainnet": "https://api.mainnet-beta.solana.com",
  "solana:devnet": "https://api.devnet.solana.com",
  "solana:testnet": "https://api.testnet.solana.com",
};

export function privyChainForCluster(cluster: Cluster = chainConfig.cluster): PrivySolanaChain {
  if (cluster === "mainnet-beta") return "solana:mainnet";
  if (cluster === "testnet") return "solana:testnet";
  return "solana:devnet";
}

function mainnetHttpRpc(): string {
  // Resolve at call time so hosted web always gets same-origin `/rpc` (window is defined).
  try {
    return defaultSolanaRpcUrl();
  } catch {
    return PUBLIC_HTTP["solana:mainnet"];
  }
}

function rpcEntry(chain: PrivySolanaChain) {
  const http =
    chain === "solana:mainnet" ? mainnetHttpRpc() : PUBLIC_HTTP[chain];
  const ws =
    chain === "solana:mainnet"
      ? CLUSTER_WS["mainnet-beta"]
      : chain === "solana:testnet"
        ? CLUSTER_WS.testnet
        : CLUSTER_WS.devnet;
  return {
    rpc: createSolanaRpc(http),
    rpcSubscriptions: createSolanaRpcSubscriptions(ws),
  };
}

/**
 * Privy `signAndSendTransaction({ sponsor: true })` requires `config.solana.rpcs`
 * for the target chain — embedded wallets default to `solana:mainnet`, so that entry
 * must always be present even when the app cluster is devnet.
 */
export function buildPrivySolanaRpcs() {
  return {
    "solana:mainnet": rpcEntry("solana:mainnet"),
    "solana:devnet": rpcEntry("solana:devnet"),
    "solana:testnet": rpcEntry("solana:testnet"),
  };
}

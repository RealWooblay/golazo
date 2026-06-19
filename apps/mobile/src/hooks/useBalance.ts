import { useStore } from "@/state/store";

/**
 * Convenience selector for the play-money balance + its mutators.
 *
 * It's a thin facade over the store so components that only care about money
 * (BalancePill, the bet flow) don't pull in the whole store surface. The actual
 * state lives in the store; this just narrows it.
 */
export function useBalance() {
  const { balance, debit, credit } = useStore();
  return { balance, debit, credit };
}

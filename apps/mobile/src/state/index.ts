/** State barrel — the canonical store + all typed ledger/view-model shapes. */
export { StoreProvider, useStore } from "./store";
export type {
  Store,
  StoreState,
  Session,
  Wallet,
  DepositArgs,
  WithdrawArgs,
} from "./store";
export type {
  FeedMode,
  MarketPhase,
  MarketVM,
  PendingBet,
  RevealVM,
  // ledger
  BetRow,
  TransactionRow,
  HistoryItem,
  DepositMethod,
  WithdrawDestination,
  TransactionStatus,
  // legacy
  HistoryRow,
} from "./types";

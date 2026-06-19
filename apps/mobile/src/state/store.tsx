import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_STAKE, START_BALANCE, defaultLiveUrl } from "@/lib/config";
import type {
  BetRow,
  DepositMethod,
  FeedMode,
  HistoryItem,
  HistoryRow,
  TransactionRow,
  WithdrawDestination,
} from "./types";

/**
 * GLOBAL STORE — the canonical, persisted source of truth for GOLAZO.
 *
 * This is the contract EVERY feature builds against. It owns:
 *   • balance   — the single play-money number used for BOTH betting and wallet.
 *   • session   — first-run, display name, mode (offline/live), sound/haptics.
 *   • wallet    — connection state + which kind of wallet (sandbox/embedded).
 *   • history   — a unified ledger of bets + transactions (newest first).
 *   • stake     — the currently selected stake chip (kept for the match loop).
 *   • liveUrl   — WebSocket URL for LIVE mode.
 *
 * Implementation: React Context + useReducer (zero extra state lib) with
 * AsyncStorage persistence. We hydrate once on boot (web-safe — AsyncStorage
 * has a localStorage backend on web) and write through on every mutation.
 *
 * Money rules:
 *   • debit/credit move the balance for BETS (no ledger row — the bet row is
 *     added separately via addBet when the market settles).
 *   • deposit/withdraw move the balance AND append a TransactionRow atomically.
 *   • balance can never go negative (guards clamp at 0).
 */

// v2: bumped so previously-persisted "offline" state is discarded → live default applies.
const STORAGE_KEY = "golazo:store:v2";
const HISTORY_CAP = 200; // bound the persisted ledger

// ── State shape ──────────────────────────────────────────────────────────────

export interface Session {
  firstRun: boolean;
  displayName?: string;
  mode: FeedMode;
  soundOn: boolean;
  hapticsOn: boolean;
}

export interface Wallet {
  connected: boolean;
  walletKind: "sandbox" | "embedded";
  address?: string;
}

export interface StoreState {
  balance: number;
  stake: number;
  session: Session;
  wallet: Wallet;
  history: HistoryItem[];
  liveUrl: string;
  /** Internal: true once AsyncStorage has been read. UI can show a splash until. */
  hydrated: boolean;
}

// ── Actions ──────────────────────────────────────────────────────────────────

type Action =
  | { type: "hydrate"; state: Partial<StoreState> }
  | { type: "setStake"; stake: number }
  | { type: "credit"; amount: number }
  | { type: "debit"; amount: number }
  | { type: "deposit"; row: TransactionRow }
  | { type: "withdraw"; row: TransactionRow }
  | { type: "addBet"; row: BetRow }
  | { type: "addTransaction"; row: TransactionRow }
  | { type: "setMode"; mode: FeedMode }
  | { type: "setName"; name: string }
  | { type: "setWallet"; wallet: Partial<Wallet> }
  | { type: "setSession"; session: Partial<Session> }
  | { type: "setLiveUrl"; url: string }
  | { type: "completeFirstRun" }
  | { type: "reset" };

const clamp0 = (n: number) => (n < 0 ? 0 : n);
const pushHistory = (history: HistoryItem[], row: HistoryItem) =>
  [row, ...history].slice(0, HISTORY_CAP);

function reducer(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case "hydrate":
      return { ...state, ...action.state, hydrated: true };
    case "setStake":
      return { ...state, stake: action.stake };
    case "credit":
      return { ...state, balance: state.balance + action.amount };
    case "debit":
      return { ...state, balance: clamp0(state.balance - action.amount) };
    case "deposit":
      return {
        ...state,
        balance: state.balance + action.row.amount,
        history: pushHistory(state.history, action.row),
      };
    case "withdraw":
      return {
        ...state,
        balance: clamp0(state.balance - action.row.amount),
        history: pushHistory(state.history, action.row),
      };
    case "addBet":
      return { ...state, history: pushHistory(state.history, action.row) };
    case "addTransaction":
      return { ...state, history: pushHistory(state.history, action.row) };
    case "setMode":
      return { ...state, session: { ...state.session, mode: action.mode } };
    case "setName":
      return {
        ...state,
        session: { ...state.session, displayName: action.name },
      };
    case "setSession":
      return { ...state, session: { ...state.session, ...action.session } };
    case "setWallet":
      return { ...state, wallet: { ...state.wallet, ...action.wallet } };
    case "setLiveUrl":
      return { ...state, liveUrl: action.url };
    case "completeFirstRun":
      return { ...state, session: { ...state.session, firstRun: false } };
    case "reset":
      return { ...initialState(), hydrated: true };
    default:
      return state;
  }
}

function initialState(): StoreState {
  return {
    balance: START_BALANCE,
    stake: DEFAULT_STAKE,
    session: {
      firstRun: true,
      displayName: undefined,
      mode: "live", // LIVE by default — show the real game from the feed service; falls back to sim offline only if the feed is unreachable
      soundOn: true,
      hapticsOn: true,
    },
    wallet: {
      connected: false,
      walletKind: "sandbox",
      address: undefined,
    },
    history: [],
    liveUrl: defaultLiveUrl(),
    hydrated: false,
  };
}

// Only persist the durable slice (never `hydrated`).
const PERSIST_KEYS: (keyof StoreState)[] = [
  "balance",
  "stake",
  "session",
  "wallet",
  "history",
  "liveUrl",
];

function pickPersistable(state: StoreState): Partial<StoreState> {
  const out: Partial<StoreState> = {};
  for (const k of PERSIST_KEYS) (out as Record<string, unknown>)[k] = state[k];
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Arguments to {@link Store.deposit}. */
export interface DepositArgs {
  amount: number;
  method: DepositMethod;
}
/** Arguments to {@link Store.withdraw}. */
export interface WithdrawArgs {
  amount: number;
  destination: WithdrawDestination;
}

/** The store surface exposed to the whole app via {@link useStore}. */
export interface Store extends StoreState {
  // money — bets
  credit: (amount: number) => void;
  debit: (amount: number) => void;
  // money — wallet (each appends a ledger transaction)
  deposit: (args: DepositArgs) => TransactionRow;
  withdraw: (args: WithdrawArgs) => TransactionRow;
  // ledger
  addBet: (row: BetRow) => void;
  addTransaction: (row: TransactionRow) => void;
  /** @deprecated legacy match-loop path; wraps addBet. */
  addHistory: (row: HistoryRow) => void;
  // session / wallet
  setStake: (stake: number) => void;
  setMode: (mode: FeedMode) => void;
  setName: (name: string) => void;
  setSession: (session: Partial<Session>) => void;
  setWallet: (wallet: Partial<Wallet>) => void;
  setLiveUrl: (url: string) => void;
  completeFirstRun: () => void;
  reset: () => void;
  // selectors / derived
  /** Convenience mirror of session.mode (top-level, for the match feed). */
  mode: FeedMode;
  /** Only bet rows (for the match-loop history strip). */
  bets: BetRow[];
  /** Only transaction rows (for the wallet activity list). */
  transactions: TransactionRow[];
}

const StoreContext = createContext<Store | null>(null);

let _seq = 0;
const rowId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // ── Hydration (once) ──
  const hydratedOnce = useRef(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (alive && raw) {
          const parsed = JSON.parse(raw) as Partial<StoreState>;
          dispatch({ type: "hydrate", state: parsed });
        } else if (alive) {
          dispatch({ type: "hydrate", state: {} });
        }
      } catch {
        if (alive) dispatch({ type: "hydrate", state: {} });
      } finally {
        hydratedOnce.current = true;
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ── Write-through persistence (after first hydrate, debounced via microtask) ──
  useEffect(() => {
    if (!state.hydrated) return;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(pickPersistable(state)),
    ).catch(() => {
      /* best-effort; play money, not critical */
    });
  }, [state]);

  // ── Stable action callbacks ──
  const credit = useCallback(
    (amount: number) => dispatch({ type: "credit", amount }),
    [],
  );
  const debit = useCallback(
    (amount: number) => dispatch({ type: "debit", amount }),
    [],
  );

  const deposit = useCallback(
    ({ amount, method }: DepositArgs): TransactionRow => {
      const row: TransactionRow = {
        kind: "transaction",
        id: rowId("dep"),
        type: "deposit",
        amount,
        delta: amount,
        method,
        status: "complete",
        at: Date.now(),
      };
      dispatch({ type: "deposit", row });
      return row;
    },
    [],
  );

  const withdraw = useCallback(
    ({ amount, destination }: WithdrawArgs): TransactionRow => {
      const row: TransactionRow = {
        kind: "transaction",
        id: rowId("wd"),
        type: "withdraw",
        amount,
        delta: -amount,
        destination,
        status: "complete",
        at: Date.now(),
      };
      dispatch({ type: "withdraw", row });
      return row;
    },
    [],
  );

  const addBet = useCallback(
    (row: BetRow) => dispatch({ type: "addBet", row }),
    [],
  );
  const addTransaction = useCallback(
    (row: TransactionRow) => dispatch({ type: "addTransaction", row }),
    [],
  );

  // Legacy bridge: the current match loop calls addHistory(HistoryRow). Map it to
  // a BetRow so old + new ledgers stay unified until the match agent migrates.
  const addHistory = useCallback((row: HistoryRow) => {
    const bet: BetRow = {
      kind: "bet",
      id: rowId("bet"),
      marketId: row.id,
      label: row.label,
      side: row.label.startsWith("NO") ? "NO" : "YES",
      stake: Math.abs(row.delta),
      payoutMult: 0,
      outcome: row.outcome,
      won: row.won,
      delta: row.delta,
      at: Date.now(),
    };
    dispatch({ type: "addBet", row: bet });
  }, []);

  const setStake = useCallback(
    (stake: number) => dispatch({ type: "setStake", stake }),
    [],
  );
  const setMode = useCallback(
    (mode: FeedMode) => dispatch({ type: "setMode", mode }),
    [],
  );
  const setName = useCallback(
    (name: string) => dispatch({ type: "setName", name }),
    [],
  );
  const setSession = useCallback(
    (session: Partial<Session>) => dispatch({ type: "setSession", session }),
    [],
  );
  const setWallet = useCallback(
    (wallet: Partial<Wallet>) => dispatch({ type: "setWallet", wallet }),
    [],
  );
  const setLiveUrl = useCallback(
    (url: string) => dispatch({ type: "setLiveUrl", url }),
    [],
  );
  const completeFirstRun = useCallback(
    () => dispatch({ type: "completeFirstRun" }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  // ── Derived selectors (memoized) ──
  const bets = useMemo(
    () => state.history.filter((h): h is BetRow => h.kind === "bet"),
    [state.history],
  );
  const transactions = useMemo(
    () =>
      state.history.filter(
        (h): h is TransactionRow => h.kind === "transaction",
      ),
    [state.history],
  );

  const value = useMemo<Store>(
    () => ({
      ...state,
      credit,
      debit,
      deposit,
      withdraw,
      addBet,
      addTransaction,
      addHistory,
      setStake,
      setMode,
      setName,
      setSession,
      setWallet,
      setLiveUrl,
      completeFirstRun,
      reset,
      mode: state.session.mode,
      bets,
      transactions,
    }),
    [
      state,
      credit,
      debit,
      deposit,
      withdraw,
      addBet,
      addTransaction,
      addHistory,
      setStake,
      setMode,
      setName,
      setSession,
      setWallet,
      setLiveUrl,
      completeFirstRun,
      reset,
      bets,
      transactions,
    ],
  );

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

/** Access the global store. Throws if used outside the provider (a wiring bug). */
export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within <StoreProvider>");
  return ctx;
}

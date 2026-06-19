/**
 * PROFILE FEATURE — barrel. The Profile tab composes:
 *   • ProfileHero  — identity (editable name) + lifetime stat tiles
 *   • LedgerRow    — one unified history row (bet | transaction)
 *   • settings.*   — grouped settings rows (toggle, segment, link, field)
 *   • stats.*      — pure derivations over the ledger (+ filter / relative time)
 */
export { ProfileHero } from "./ProfileHero";
export { LedgerRow } from "./LedgerRow";
export {
  SettingsGroup,
  ToggleRow,
  SegmentRow,
  LinkRow,
  FieldRow,
} from "./settings";
export {
  lifetimeStats,
  winRatePct,
  streakLabel,
  filterLedger,
  relativeTime,
} from "./stats";
export type { LifetimeStats, LedgerFilter } from "./stats";

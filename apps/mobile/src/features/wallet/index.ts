/**
 * WALLET FEATURE — barrel.
 *
 * The Wallet tab + the deposit/withdraw modals build entirely from these
 * exports. Everything is web-safe (no native/chain lib imported at module load —
 * the platform shims lazy-require behind fallbacks, and the deposit address is
 * resolved through the store contract rather than importing the chain stack).
 *
 *   import { useWallet, WalletHero, AmountInput } from '@/features/wallet'
 *
 * Layers:
 *   • Logic   — useWallet (on/off-ramp flow brain), useDepositAddress, the ramp
 *               adapter (getRamp / RampAdapter — see RAMP.md for adding real keys),
 *               and the pure address/QR helpers.
 *   • UI      — WalletHero, AmountInput, MethodOption, ActivityRow, ActivityList,
 *               FlowStatus, DepositAddressCard, SectionHeader, Surface.
 */

// ── Logic / hooks ─────────────────────────────────────────────────────────────
export { useWallet } from "./useWallet";
// `FlowStatus` (the status union) is re-exported as `FlowStatusKind` so it doesn't
// collide with the <FlowStatus> component below.
export type {
  UseWallet,
  FlowKind,
  FlowStatus as FlowStatusKind,
  FlowState,
} from "./useWallet";
export { useDepositAddress } from "./useDepositAddress";
export type { ResolvedAddress } from "./useDepositAddress";

// ── Ramp adapter (swappable provider; see RAMP.md) ────────────────────────────
export { getRamp, isRampLive } from "./ramp";
export type {
  RampAdapter,
  RampProvider,
  RampMode,
  RampUrl,
  RampSigner,
  BuyRequest,
  SellRequest,
} from "./ramp";

// ── Pure helpers ──────────────────────────────────────────────────────────────
export { sandboxAddress, shortenAddress, solanaPayUri } from "./address";
export { openExternal, copyToClipboard } from "./platform";

// ── Components ────────────────────────────────────────────────────────────────
export { WalletHero } from "./components/WalletHero";
export type { WalletHeroProps } from "./components/WalletHero";
export { ChainWalletHero } from "./components/ChainWalletHero";
export { AmountInput } from "./components/AmountInput";
export type { AmountInputProps } from "./components/AmountInput";
export { MethodOption } from "./components/MethodOption";
export type { MethodOptionProps, MethodTint } from "./components/MethodOption";
export { ActivityRow } from "./components/ActivityRow";
export { ActivityList } from "./components/ActivityList";
export { FlowStatus } from "./components/FlowStatus";
export type { FlowStatusProps } from "./components/FlowStatus";
export { DepositAddressCard } from "./components/DepositAddressCard";
export type { DepositAddressCardProps } from "./components/DepositAddressCard";
export { SectionHeader } from "./components/SectionHeader";
export { ModalHeader } from "./components/ModalHeader";
export { MethodHeaderTabs } from "./components/MethodHeaderTabs";
export type { TabItem } from "./components/MethodHeaderTabs";
export { QRCode } from "./qr/QRCode";

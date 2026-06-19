import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

/**
 * HAPTICS — a thin, safe wrapper over expo-haptics.
 *
 * Why wrap it:
 *   • expo-haptics is a no-op on web but importing/calling it directly from
 *     dozens of components is noisy. This gives one tactile vocabulary.
 *   • Every call is fire-and-forget and guarded — a rejected promise (e.g. on a
 *     device without a Taptic Engine) must never bubble into the UI.
 *   • Respect the user's `hapticsOn` preference: pass `enabled` from the store
 *     where you have it, or use the `*If(enabled)` helpers.
 *
 * Vocabulary (when to fire what):
 *   tap     → light press on any tappable (chip, icon button)
 *   select  → medium — committing a stake / selecting a side
 *   lock    → rigid/heavy — bet locked in, market locks
 *   win     → success notification (+ confetti)
 *   lose    → warning notification
 *   error   → error notification (rejected bet, insufficient balance)
 */

const web = Platform.OS === "web";
const swallow = () => {};

function impact(style: Haptics.ImpactFeedbackStyle) {
  if (web) return;
  Haptics.impactAsync(style).catch(swallow);
}
function notify(type: Haptics.NotificationFeedbackType) {
  if (web) return;
  Haptics.notificationAsync(type).catch(swallow);
}

export const haptics = {
  tap: () => impact(Haptics.ImpactFeedbackStyle.Light),
  select: () => impact(Haptics.ImpactFeedbackStyle.Medium),
  heavy: () => impact(Haptics.ImpactFeedbackStyle.Heavy),
  lock: () =>
    impact(
      // Rigid exists on newer SDKs; fall back to Heavy.
      (Haptics.ImpactFeedbackStyle as { Rigid?: Haptics.ImpactFeedbackStyle })
        .Rigid ?? Haptics.ImpactFeedbackStyle.Heavy,
    ),
  selection: () => {
    if (web) return;
    Haptics.selectionAsync().catch(swallow);
  },
  win: () => notify(Haptics.NotificationFeedbackType.Success),
  lose: () => notify(Haptics.NotificationFeedbackType.Warning),
  error: () => notify(Haptics.NotificationFeedbackType.Error),
} as const;

export type HapticName = keyof typeof haptics;

/** Fire a named haptic only if the user has haptics enabled. */
export function hapticIf(enabled: boolean | undefined, name: HapticName) {
  if (enabled !== false) haptics[name]();
}

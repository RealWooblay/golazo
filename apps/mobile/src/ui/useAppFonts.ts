import { useFonts } from "expo-font";
import {
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from "@expo-google-fonts/space-grotesk";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";

/**
 * useAppFonts — loads the two GOLAZO families and reports readiness.
 *
 *   • DISPLAY: Space Grotesk (Medium/SemiBold/Bold) — odds, scores, balances,
 *     market questions. Has tabular numerals so tickers don't jitter.
 *   • BODY:    Inter (Regular/Medium/SemiBold/Bold) — labels, copy, captions.
 *
 * The registered keys MUST match `fontFamily.*` in theme/typography.ts. The root
 * layout holds the splash until `ready` is true, so users never see a font swap.
 *
 * @returns [ready, error] — render the app once `ready` (or on error, to avoid a
 *          permanent splash; the system font is an acceptable last resort).
 */
export function useAppFonts(): [boolean, Error | null] {
  const [loaded, error] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  return [loaded, error ?? null];
}

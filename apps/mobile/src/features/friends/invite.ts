import { Platform } from "react-native";

/**
 * INVITE LINK — turn a room code into a shareable deep link.
 *
 * Web   → an absolute URL on the current origin: `https://app/join/ABCD`. This is
 *         what a friend pastes into a browser tab to join.
 * Native→ an Expo deep link: `Linking.createURL('/join/ABCD')` → `golazo://join/ABCD`
 *         (or the dev `exp://…/--/join/ABCD`), which expo-router resolves to the
 *         `/join/[code]` route on the device.
 *
 * WHY guarded `require` instead of a top-level `import`:
 *   expo-linking is a native-flavoured module; importing it at module load can
 *   throw on the web bundle. We only touch it on native, inside a try/catch, so
 *   the web build stays clean and a missing module degrades to a sensible string
 *   rather than crashing the bundle. (Mirrors features/wallet/platform.ts.)
 */

const isWeb = Platform.OS === "web";

/* eslint-disable @typescript-eslint/no-var-requires */

/** Build a shareable join link for a room code (web URL or native deep link). */
export function buildInviteLink(code: string): string {
  const path = `/join/${encodeURIComponent(code)}`;

  if (isWeb) {
    // Prefer the live origin so the link is copy-pasteable as-is. Fall back to a
    // relative path if we somehow run without a window (SSR / tests).
    try {
      if (
        typeof window !== "undefined" &&
        window.location &&
        typeof window.location.origin === "string"
      ) {
        return window.location.origin + path;
      }
    } catch {
      /* fall through to the relative path */
    }
    return path;
  }

  // Native: expo-linking knows the app scheme + dev host.
  try {
    const Linking = require("expo-linking") as {
      createURL: (p: string) => string;
    };
    return Linking.createURL(path);
  } catch {
    // expo-linking unavailable — return the bare path so the UI still has
    // something to show/share.
    return path;
  }
}

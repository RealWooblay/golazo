import { Platform } from "react-native";

/**
 * PLATFORM SHIMS — tiny, crash-proof wrappers over the optional native modules
 * the wallet flows touch (the external browser for ramp widgets, and clipboard
 * for copying a deposit address).
 *
 * WHY guarded `require` instead of top-level `import`:
 *   The app MUST keep rendering on Expo Web even if an optional native module
 *   isn't present. A top-level `import 'expo-web-browser'` would run at module
 *   load; if the package resolves to a native-only stub on web it can throw and
 *   take the whole screen down. Loading lazily inside a try/catch means a missing
 *   or web-incompatible module degrades gracefully (we fall back to `window.open`
 *   / `navigator.clipboard`) instead of crashing the bundle.
 *
 * Everything here is fire-and-forget and returns a boolean "did it work" so
 * callers can show a friendly fallback ("address copied" vs "couldn't copy").
 */

const isWeb = Platform.OS === "web";

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

/**
 * Open a URL in an in-app browser (native) or a new tab (web). Used to launch
 * the fiat on/off-ramp provider widget. Returns true if a browser was opened.
 */
export async function openExternal(url: string): Promise<boolean> {
  // Web: a new tab is the right UX for a hosted ramp widget.
  if (isWeb) {
    try {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }

  // Native: prefer the themed in-app browser, fall back to Linking.
  try {
    const WebBrowser = require("expo-web-browser") as {
      openBrowserAsync: (
        u: string,
        opts?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    await WebBrowser.openBrowserAsync(url, {
      // Match the stadium-night chrome.
      toolbarColor: "#0a0b0f",
      controlsColor: "#00e58a",
      enableBarCollapsing: true,
    });
    return true;
  } catch {
    /* expo-web-browser unavailable — try Linking */
  }

  try {
    const Linking = require("expo-linking") as {
      openURL: (u: string) => Promise<unknown>;
    };
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a string to the clipboard. Returns true on success. Uses expo-clipboard
 * on native and the async Clipboard API (with a legacy execCommand fallback) on
 * web.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (isWeb) {
    try {
      const nav =
        typeof navigator !== "undefined" ? (navigator as any) : undefined;
      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(text);
        return true;
      }
      // Legacy fallback for older browsers / non-secure contexts.
      if (typeof document !== "undefined") {
        const el = document.createElement("textarea");
        el.value = text;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(el);
        return ok;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  try {
    const Clipboard = require("expo-clipboard") as {
      setStringAsync: (t: string) => Promise<boolean>;
    };
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

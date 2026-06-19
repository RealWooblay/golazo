import React from "react";

/**
 * BottomSheetProviderSafe — wraps the app in @gorhom/bottom-sheet's
 * BottomSheetModalProvider so any screen can present a {@link Sheet} as a modal.
 *
 * Lazy-required + web-safe: if the lib (or its native deps) can't resolve at
 * module load it falls back to a pass-through, so the Expo WEB build never breaks
 * (the Sheet itself already has a web spring-up fallback that doesn't need this
 * provider).
 */
let Provider: React.ComponentType<{ children?: React.ReactNode }> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Provider = require("@gorhom/bottom-sheet").BottomSheetModalProvider ?? null;
} catch {
  Provider = null;
}

export function BottomSheetProviderSafe({
  children,
}: {
  children: React.ReactNode;
}) {
  if (Provider) return <Provider>{children}</Provider>;
  return <>{children}</>;
}

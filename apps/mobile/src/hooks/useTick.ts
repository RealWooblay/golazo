import { useEffect, useRef, useState } from "react";

/**
 * A render heartbeat. Returns `Date.now()` and re-renders the caller every
 * `intervalMs`.
 *
 * WHY a hook: the countdown ring and the offline feed loop are driven by wall
 * clock, but @golazo/core is intentionally timer-free (pure + testable). Each
 * tick we read the clock and recompute "how much window is left" / "what's due".
 * This is the ONE place we own the clock on the device.
 *
 * @param intervalMs cadence (default 80ms — smooth ring like the prototype)
 * @param running    pause the heartbeat when false (e.g. screen unfocused)
 */
export function useTick(intervalMs = 80, running = true): number {
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), intervalRef.current);
    return () => clearInterval(id);
  }, [running, intervalMs]);

  return now;
}

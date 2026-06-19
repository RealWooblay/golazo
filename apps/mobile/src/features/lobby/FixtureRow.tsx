import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Crest } from "./Crest";
import { PressableScale, PulseDot } from "../_shared/primitives";
import { formatCountdown, type Fixture } from "./fixtures";

/**
 * FixtureRow — a compact match row for the live + upcoming lists.
 *
 *   LIVE      → tappable (PressableScale → match loop), pulsing "X live" chip.
 *   UPCOMING  → NOT tappable (plain View, no onPress). Shows a live countdown to
 *               kickoff when we know the scheduled time, else the schedule label
 *               ("Sat 16:00"). You can't open a match that hasn't kicked off.
 */
export function FixtureRow({
  fixture,
  hapticsEnabled,
  onPress,
}: {
  fixture: Fixture;
  hapticsEnabled: boolean;
  /** Only wired for live fixtures; ignored for non-live (non-tappable) rows. */
  onPress?: () => void;
}) {
  const isLive = fixture.status === "live";

  const content = (
    <>
      <View pointerEvents="none" style={styles.topHighlight} />

      <View style={styles.teams}>
        <View style={styles.teamLine}>
          <Crest team={fixture.home} size={28} />
          <Text style={styles.teamName} numberOfLines={1}>
            {fixture.home.name}
          </Text>
          {isLive ? (
            <Text style={styles.scoreNum}>{fixture.scoreHome}</Text>
          ) : null}
        </View>
        <View style={styles.teamLine}>
          <Crest team={fixture.away} size={28} />
          <Text style={styles.teamName} numberOfLines={1}>
            {fixture.away.name}
          </Text>
          {isLive ? (
            <Text style={styles.scoreNum}>{fixture.scoreAway}</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.meta}>
        <Text style={styles.league} numberOfLines={1}>
          {fixture.league}
        </Text>
        {isLive ? (
          <View style={styles.liveChip}>
            <PulseDot color={colors.yes} size={6} />
            <Text style={styles.liveText}>
              {fixture.liveMarkets} live · {fixture.clock}
            </Text>
          </View>
        ) : (
          <CountdownChip fixture={fixture} />
        )}
      </View>
    </>
  );

  // Live rows are tappable; upcoming rows are deliberately a plain View so they
  // cannot navigate before kickoff.
  if (!isLive) {
    return (
      <View accessibilityRole="summary" style={styles.row}>
        {content}
      </View>
    );
  }

  return (
    <PressableScale
      depth="subtle"
      haptic="tap"
      hapticsEnabled={hapticsEnabled}
      onPress={onPress}
      style={styles.row}
    >
      {content}
    </PressableScale>
  );
}

/**
 * CountdownChip — ticks a live countdown toward the fixture's kickoff. Reading
 * the wall clock here (new Date()) is fine: this is component runtime, not a
 * shared pure module. When there's no real kickoff time, or kickoff has passed,
 * it falls back to the fixture's existing schedule label.
 */
function CountdownChip({ fixture }: { fixture: Fixture }) {
  const hasKickoff = typeof fixture.kickoff === "number";
  const [label, setLabel] = useState(() => countdownLabel(fixture));

  useEffect(() => {
    if (!hasKickoff) {
      setLabel(fixture.clock || "TBD");
      return;
    }
    setLabel(countdownLabel(fixture));
    const id = setInterval(() => setLabel(countdownLabel(fixture)), 1000);
    return () => clearInterval(id);
  }, [fixture, hasKickoff]);

  return (
    <View style={styles.soonChip}>
      <Text style={styles.soonText}>{label}</Text>
    </View>
  );
}

/** Build the chip label from the wall clock (runtime-only). */
function countdownLabel(fixture: Fixture): string {
  const fallback = fixture.clock || "TBD";
  if (typeof fixture.kickoff !== "number") return fallback;
  const countdown = formatCountdown(fixture.kickoff - new Date().getTime());
  // Kickoff passed (or not formattable) → schedule label rather than 00:00.
  return countdown ?? fallback;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.md,
    overflow: "hidden",
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
  },
  teams: { flex: 1, gap: spacing.sm },
  teamLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  teamName: {
    ...type.bodyStrong,
    color: colors.textPrimary,
    fontSize: 14,
    flex: 1,
  },
  scoreNum: { ...type.mono, color: colors.textPrimary, fontSize: 16 },
  meta: { alignItems: "flex-end", gap: 6, maxWidth: 132 },
  league: {
    ...type.caption,
    color: colors.textFaint,
    fontSize: 10,
    textAlign: "right",
  },
  liveChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.alpha.yes,
    borderColor: "rgba(0,229,138,0.34)",
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  liveText: { ...type.overline, color: colors.yes, fontSize: 9 },
  soonChip: {
    backgroundColor: colors.alpha.white06,
    borderColor: colors.hairlineSoft,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  soonText: { ...type.overline, color: colors.textMuted, fontSize: 9 },
});

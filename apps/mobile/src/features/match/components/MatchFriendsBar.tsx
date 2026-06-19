// MATCH FRIENDS BAR — the social choice on the live match: keep betting the
// PUBLIC pool (you + the crowd, with a live head-count) or break off into a
// PRIVATE room and bet your friends on the same match.
//
// The public head-count is REAL: it's the number of distinct bettors in the
// current market's pool (you + the crowd), passed down from the engine/feed —
// never a fabricated "online" number. Between markets there's no open pool, so
// it rests on a neutral "live game" label rather than inventing a figure.
import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { PressableScale, PulseDot } from "@/features/_shared/primitives";

export function MatchFriendsBar({
  playerCount,
  onJoinPublic,
  onPrivate,
  hapticsEnabled,
}: {
  /** Distinct bettors in the current public market (0 = no open market). */
  playerCount: number;
  /** Optional — you're already in the public game, so this is a haptic confirm. */
  onJoinPublic?: () => void;
  onPrivate: () => void;
  hapticsEnabled: boolean;
}) {
  const hasCrowd = playerCount > 0;
  return (
    <View style={styles.row}>
      {/* PUBLIC — the game you're already in, with a live head-count. */}
      <PressableScale
        haptic="tap"
        hapticsEnabled={hapticsEnabled}
        onPress={onJoinPublic}
        style={[styles.card, styles.public]}
      >
        <View style={styles.top}>
          <PulseDot color={colors.yes} size={7} />
          <Text style={[styles.eyebrow, { color: colors.yes }]}>PUBLIC</Text>
        </View>
        <Text style={styles.title}>Join public</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {hasCrowd
            ? `${playerCount} playing now`
            : "Open game · live"}
        </Text>
      </PressableScale>

      {/* PRIVATE — spin up / join a room and bet your friends on this match. */}
      <PressableScale
        haptic="tap"
        hapticsEnabled={hapticsEnabled}
        onPress={onPrivate}
        style={[styles.card, styles.private]}
      >
        <View style={styles.top}>
          <View style={[styles.dot, { backgroundColor: colors.cyan }]} />
          <Text style={[styles.eyebrow, { color: colors.cyan }]}>PRIVATE</Text>
          <Text style={styles.arrow}>›</Text>
        </View>
        <Text style={styles.title}>Private room</Text>
        <Text style={styles.sub} numberOfLines={1}>
          Bet your friends
        </Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.sm },
  card: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1,
    backgroundColor: colors.surface1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: 4,
    overflow: "hidden",
  },
  public: { borderColor: "rgba(0,229,138,0.34)", backgroundColor: colors.alpha.yes },
  private: { borderColor: colors.glow.cyanSoft },
  top: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  eyebrow: { ...type.overline, fontSize: 9, letterSpacing: 1.4 },
  arrow: { ...type.subtitle, color: colors.textFaint, marginLeft: "auto", fontSize: 18, lineHeight: 18 },
  title: { ...type.subtitle, fontSize: 15, color: colors.textPrimary },
  sub: { ...type.caption, fontSize: 11.5, color: colors.textMuted },
});

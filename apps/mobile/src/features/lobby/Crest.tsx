import React from "react";
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, fontFamily } from "@/theme";
import type { FixtureTeam } from "./fixtures";

/**
 * Crest — a team badge. For a NATIONAL team (has a flag) the FLAG IS the badge:
 * a rounded tile with the flag filling it — no gradient card, no abbreviation,
 * no corner chip. For a club (no flag) we fall back to an asset-free gradient
 * tile built from the team's brand colors with the abbreviation overlaid.
 *
 * The team's text label (abbr / name) is rendered by the PARENT next to the
 * crest, so the crest never repeats it.
 */
export function Crest({
  team,
  size = 40,
  style,
  /** Use the country flag as the badge (national teams). Default on. */
  showFlag = true,
}: {
  team: FixtureTeam;
  size?: number;
  style?: StyleProp<ViewStyle>;
  showFlag?: boolean;
}) {
  const radius = Math.round(size * 0.32);

  // National team → the flag fills the badge.
  if (showFlag && team.flag) {
    return (
      <View
        style={[
          styles.flagTile,
          { width: size, height: size, borderRadius: radius },
          style,
        ]}
      >
        <Text
          style={[styles.flagGlyph, { fontSize: Math.round(size * 0.7) }]}
          allowFontScaling={false}
        >
          {team.flag}
        </Text>
      </View>
    );
  }

  // Club / no flag → a FLAT tile with the abbreviation (no gradient, no gloss). A thin
  // accent in the team's primary colour keeps a hint of identity without the silver sheen.
  const fontSize = size <= 32 ? 11 : size <= 44 ? 13 : 15;
  const accent = team.colors?.[0] ?? colors.textSecondary;
  return (
    <View
      style={[
        styles.crest,
        { width: size, height: size, borderRadius: radius },
        style,
      ]}
    >
      <Text
        style={[styles.abbr, { fontSize, color: accent }]}
        numberOfLines={1}
        allowFontScaling={false}
      >
        {team.abbr}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flagTile: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.alpha.white10,
  },
  flagGlyph: { textAlign: "center", lineHeight: undefined },
  crest: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  abbr: {
    fontFamily: fontFamily.display,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
});

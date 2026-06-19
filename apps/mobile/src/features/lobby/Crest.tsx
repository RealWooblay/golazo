import React from "react";
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, fontFamily } from "@/theme";
import { GradientFill } from "../_shared/primitives";
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

  // Club / no flag → gradient tile with the abbreviation.
  const fontSize = size <= 32 ? 11 : size <= 44 ? 13 : 15;
  return (
    <View
      style={[
        styles.crest,
        { width: size, height: size, borderRadius: radius },
        style,
      ]}
    >
      <GradientFill
        colors={team.colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      <View style={styles.sheen} pointerEvents="none" />
      <Text
        style={[styles.abbr, { fontSize }]}
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
    borderWidth: 1,
    borderColor: colors.alpha.white10,
  },
  sheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "45%",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  abbr: {
    fontFamily: fontFamily.display,
    fontWeight: "900",
    color: "#0a0b0f",
    letterSpacing: 0.4,
    textShadowColor: "rgba(255,255,255,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
});

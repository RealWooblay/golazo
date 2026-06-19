import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing } from "@/theme";
import { Skeleton } from "../_shared/primitives";

/**
 * LobbySkeleton — the loading state for the Play tab. Mirrors the real layout
 * (a big hero block, then a couple of fixture rows) so the screen doesn't jump
 * when the slate "loads". Pure shimmer blocks, web-safe.
 */
export function LobbySkeleton() {
  return (
    <View style={styles.wrap}>
      {/* hero */}
      <View style={styles.hero}>
        <View style={styles.heroHead}>
          <Skeleton width={92} height={22} rounded={radius.pill} />
          <Skeleton width={120} height={12} rounded={radius.sm} />
        </View>
        <View style={styles.heroScore}>
          <Skeleton width={56} height={56} rounded={radius.md} />
          <Skeleton width={96} height={48} rounded={radius.sm} />
          <Skeleton width={56} height={56} rounded={radius.md} />
        </View>
        <Skeleton
          width="100%"
          height={56}
          rounded={radius.md}
          style={{ marginTop: spacing.lg }}
        />
        <Skeleton
          width="100%"
          height={52}
          rounded={radius.md}
          style={{ marginTop: spacing.md }}
        />
      </View>

      {/* section header */}
      <Skeleton
        width={140}
        height={18}
        rounded={radius.sm}
        style={{ marginTop: spacing.xl, marginBottom: spacing.md }}
      />

      {/* rows */}
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.row}>
          <View style={{ flex: 1, gap: spacing.sm }}>
            <Skeleton width="70%" height={14} rounded={radius.sm} />
            <Skeleton width="55%" height={14} rounded={radius.sm} />
          </View>
          <Skeleton width={84} height={24} rounded={radius.pill} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%" },
  hero: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface1,
    padding: spacing.xl,
  },
  heroHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  heroScore: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
});

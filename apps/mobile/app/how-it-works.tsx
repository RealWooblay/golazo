// Shared modal: the plain-language explainer for the mechanic. Linked from the
// Profile screen (and onboarding). Informational only — no engine wiring.
import React from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Text, Card, Banner, IconButton, IconClose } from "@/ui";
import { colors, spacing } from "@/theme";

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "1",
    title: "A moment kicks off",
    body: "The feed catches a live moment and pops a 10-second YES/NO market.",
  },
  {
    n: "2",
    title: "Tap a side — see the live estimate",
    body: "Your quote moves with the pool until betting closes. More money on your side means a smaller share.",
  },
  {
    n: "3",
    title: "It resolves in seconds",
    body: "Winners split the final net pool. Bad timing? VOID refunds your stake.",
  },
];

export default function HowItWorks() {
  const router = useRouter();
  return (
    <Screen>
      <View style={styles.head}>
        <Text preset="title" style={styles.title}>
          How it works
        </Text>
        <IconButton
          accessibilityLabel="Close"
          onPress={() => router.back()}
          haptic="tap"
        >
          <IconClose size={20} color={colors.textMuted} />
        </IconButton>
      </View>

      <View style={{ gap: spacing.md }}>
        {STEPS.map((s) => (
          <Card key={s.n} style={styles.step}>
            <View style={styles.badge}>
              <Text preset="bodyStrong" color={colors.onPrimary}>
                {s.n}
              </Text>
            </View>
            <View style={styles.stepBody}>
              <Text preset="subtitle">{s.title}</Text>
              <Text preset="body" muted>
                {s.body}
              </Text>
            </View>
          </Card>
        ))}
      </View>

      <Banner
        tone="info"
        title="Play money"
        message="This build runs a simulated match by default. Point it at a live feed from Profile → settings."
        style={{ marginTop: spacing.lg }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  title: { color: colors.textPrimary },
  step: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  badge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBody: { flex: 1, gap: 4 },
});

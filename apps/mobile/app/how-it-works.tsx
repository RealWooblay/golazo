// Shared modal: the plain-language explainer for the mechanic. Linked from the
// Profile screen (and onboarding). Informational only — no engine wiring.
import React from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Text, Card } from "@/ui";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { colors, spacing } from "@/theme";

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "1",
    title: "A moment kicks off",
    body: "The feed catches a live moment and opens a short YES/NO market. Betting closes early to stop late snipes.",
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
      <UnifiedHeader
        variant="slim"
        title="How it works"
        onClose={() => router.back()}
      />

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
    </Screen>
  );
}

const styles = StyleSheet.create({
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

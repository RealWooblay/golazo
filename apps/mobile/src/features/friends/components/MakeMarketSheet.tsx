import React, { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { FRIEND_MARKET_WINDOW_MS, type Team } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import { Button, Chip, Sheet, Text } from "@/ui";
import { haptics } from "@/ui/haptics";

/** Quick private-market shortcuts friends can fire in one tap. */
const SHORTCUTS: { label: string; question: string; team?: Team }[] = [
  { label: "⚽ Goal", question: "Will this attack end in a GOAL?" },
  { label: "🟨 Yellow", question: "Will there be a YELLOW card?" },
  { label: "🟥 Red", question: "Will there be a RED card?" },
  { label: "📺 VAR pen", question: "Will VAR award a PENALTY?" },
  { label: "🚩 Corner goal", question: "GOAL from this corner?", team: "home" },
  { label: "🎯 FK goal", question: "GOAL from this free kick?" },
];

export function MakeMarketSheet({
  open,
  onClose,
  onSubmit,
  hapticsEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (question: string, opts?: { team?: Team }) => void;
  hapticsEnabled?: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [team, setTeam] = useState<Team | undefined>(undefined);

  const trimmed = question.trim();
  const canSubmit = trimmed.length >= 3;
  const seconds = Math.round(FRIEND_MARKET_WINDOW_MS / 1000);

  const reset = () => {
    setQuestion("");
    setTeam(undefined);
  };

  const submit = (q?: string, t?: Team) => {
    const text = (q ?? trimmed).trim();
    if (text.length < 3) return;
    if (hapticsEnabled) haptics.win();
    onSubmit(text, (t ?? team) ? { team: (t ?? team)! } : undefined);
    reset();
    onClose();
  };

  const pickTeam = (t: Team) => {
    if (hapticsEnabled) haptics.selection();
    setTeam((cur) => (cur === t ? undefined : t));
  };

  return (
    <Sheet open={open} onClose={onClose} snapPoints={["72%"]}>
      <View style={styles.wrap}>
        <View style={styles.head}>
          <Text style={styles.title}>Make a market</Text>
          <Text style={styles.sub}>
            Private to your room — real SOL parimutuel against friends only.
          </Text>
        </View>

        <Text style={styles.label}>QUICK SHORTCUTS</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.shortcutRow}>
            {SHORTCUTS.map((s) => (
              <Chip
                key={s.label}
                label={s.label}
                tone="info"
                onPress={() => submit(s.question, s.team)}
              />
            ))}
          </View>
        </ScrollView>

        <View style={styles.field}>
          <Text style={styles.label}>OR TYPE YOUR OWN</Text>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder="e.g. Will Morocco score from this corner?"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            maxLength={80}
            autoCapitalize="sentences"
            returnKeyType="done"
            onSubmitEditing={() => submit()}
            selectionColor={colors.yes}
            multiline
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>TAG A SIDE (OPTIONAL)</Text>
          <View style={styles.teamRow}>
            <Chip
              label="HOME"
              tone="info"
              selected={team === "home"}
              onPress={() => pickTeam("home")}
            />
            <Chip
              label="AWAY"
              tone="info"
              selected={team === "away"}
              onPress={() => pickTeam("away")}
            />
            <Chip
              label="NEUTRAL"
              tone="neutral"
              selected={team === undefined}
              onPress={() => setTeam(undefined)}
            />
          </View>
        </View>

        <View style={styles.terms}>
          <Chip label="PRIVATE · FRIENDS ONLY" tone="win" />
          <Chip label={`${seconds}s WINDOW`} tone="neutral" />
        </View>

        <Text style={styles.resolveNote}>
          You or the host tap YES / NO / VOID when it lands — real on-chain market,
          same wallet as the main game.
        </Text>

        <Button
          label="Open the market"
          onPress={() => submit()}
          variant="primary"
          size="lg"
          fullWidth
          glow
          disabled={!canSubmit}
          haptic={null}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.lg, paddingBottom: spacing.md },
  head: { gap: spacing.xs },
  title: { ...type.title, fontSize: 22, color: colors.textPrimary },
  sub: { ...type.body, fontSize: 13.5, color: colors.textMuted },
  field: { gap: spacing.sm },
  label: {
    ...type.overline,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 1.6,
  },
  shortcutRow: { flexDirection: "row", gap: spacing.sm, paddingBottom: spacing.xs },
  input: {
    ...type.subtitle,
    fontSize: 17,
    color: colors.textPrimary,
    backgroundColor: colors.surface0,
    borderWidth: 1,
    borderColor: colors.glow.yesSoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 56,
    textAlignVertical: "top",
  },
  teamRow: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  terms: { flexDirection: "row", gap: spacing.sm },
  resolveNote: { ...type.caption, fontSize: 12, color: colors.textMuted },
});

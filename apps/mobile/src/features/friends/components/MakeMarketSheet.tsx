import React, { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { FRIEND_MARKET_WINDOW_MS, type Team } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import { Button, Chip, Sheet, Text } from "@/ui";
import { haptics } from "@/ui/haptics";

/**
 * MakeMarketSheet — the "bet this moment" composer. A player types a YES/NO
 * question ("Free kick scored?"), optionally tags a side, and fires it into the
 * room as a parimutuel friend market. The host (or the author) resolves it by
 * hand later.
 *
 * NO fixed odds: a friend market is real-$ parimutuel — you and your friends set
 * the line by betting into the shared pool. The only fixed term is the betting
 * window (a core constant), surfaced as a read-only chip so the author knows how
 * long the market stays open. Controlled by the parent (`open` / `onClose`); on
 * submit we call `onSubmit` and close.
 */
export function MakeMarketSheet({
  open,
  onClose,
  onSubmit,
  hapticsEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  /** Create the market. windowMs is omitted → the hook uses the friend default. */
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

  const submit = () => {
    if (!canSubmit) return;
    if (hapticsEnabled) haptics.win();
    onSubmit(trimmed, team ? { team } : undefined);
    reset();
    onClose();
  };

  const pickTeam = (t: Team) => {
    if (hapticsEnabled) haptics.selection();
    setTeam((cur) => (cur === t ? undefined : t));
  };

  return (
    <Sheet open={open} onClose={onClose} snapPoints={["62%"]}>
      <View style={styles.wrap}>
        <View style={styles.head}>
          <Text style={styles.title}>Make a market</Text>
          <Text style={styles.sub}>
            Pose a YES/NO call on the next moment. You and your friends set the
            line by betting; you (or the host) settle it.
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>YOUR QUESTION</Text>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder="e.g. Corner taken short?"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            maxLength={80}
            autoFocus
            autoCapitalize="sentences"
            returnKeyType="done"
            onSubmitEditing={submit}
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
          <Chip label="PARIMUTUEL · YOU SET THE LINE" tone="win" />
          <Chip label={`${seconds}s WINDOW`} tone="neutral" />
        </View>

        <Button
          label="Open the market"
          onPress={submit}
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
});

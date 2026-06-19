import React, { useState } from "react";
import { Platform, Share, StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Button, Chip, Pressable, Surface, Text } from "@/ui";
import { haptics } from "@/ui/haptics";
import { copyToClipboard } from "@/features/wallet";

/**
 * RoomInviteCard — the "invite your friends" hero. Shown while a room has
 * only the host in it. It makes the room JOINABLE in one move:
 *
 *   • the big spaced-out CODE (the thing you read aloud / type on the join screen),
 *   • a primary "Share invite" button → the native share sheet (or copy-link on web),
 *   • a secondary "Copy code" tap with an inline "copied!" confirmation,
 *   • a soft pulsing "waiting…" line so the screen still feels alive.
 *
 * Pure presentation: the parent passes the `code` + the `inviteLink` from the hook
 * (built via buildInviteLink). We never compute the link ourselves.
 */
export function RoomInviteCard({
  code,
  inviteLink,
  hapticsEnabled = true,
}: {
  code: string;
  /** Shareable deep link for the room (from the hook). */
  inviteLink?: string;
  hapticsEnabled?: boolean;
}) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const flash = (what: "code" | "link") => {
    setCopied(what);
    if (hapticsEnabled) haptics.tap();
    setTimeout(() => setCopied(null), 1600);
  };

  const copyCode = async () => {
    const ok = await copyToClipboard(code);
    if (ok) flash("code");
  };

  const share = async () => {
    const message = inviteLink
      ? `Join my GOLAZO room — code ${code}\n${inviteLink}`
      : `Join my GOLAZO room — code ${code}`;
    if (hapticsEnabled) haptics.tap();

    // Native: the OS share sheet. Web: no RN Share — fall back to copying the link
    // (or the code) so the button always does something useful.
    if (Platform.OS === "web") {
      const ok = await copyToClipboard(inviteLink ?? code);
      if (ok) flash("link");
      return;
    }
    try {
      await Share.share({ message });
    } catch {
      /* user dismissed the share sheet — nothing to do */
    }
  };

  return (
    <Surface
      radius={radius.xl}
      glow="cyan"
      borderColor={colors.glow.cyanSoft}
      style={styles.card}
    >
      <Chip label="INVITE FRIENDS" tone="info" dot />

      <View style={styles.codeBlock}>
        <Text style={styles.codeLabel}>ROOM CODE</Text>
        <Pressable onPress={copyCode} haptic={null} scaleTo={0.97}>
          <Text style={styles.code} allowFontScaling={false}>
            {code.split("").join(" ")}
          </Text>
        </Pressable>
        <Text style={styles.hint}>
          {copied === "code"
            ? "Code copied!"
            : copied === "link"
              ? "Invite link copied!"
              : "They enter this on the join screen."}
        </Text>
      </View>

      <View style={styles.actions}>
        <Button
          label={Platform.OS === "web" ? "Copy invite link" : "Share invite"}
          onPress={share}
          variant="secondary"
          size="md"
          fullWidth
          glow
          haptic={null}
        />
        <Button
          label={copied === "code" ? "Copied!" : "Copy code"}
          onPress={copyCode}
          variant="ghost"
          size="md"
          fullWidth
          haptic={null}
        />
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.xl, gap: spacing.lg, alignItems: "center" },
  codeBlock: { alignItems: "center", gap: spacing.xs },
  codeLabel: {
    ...type.overline,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 2,
  },
  code: {
    ...type.display,
    fontSize: 44,
    color: colors.cyan,
    letterSpacing: 4,
    textShadowColor: colors.glow.cyan,
    textShadowRadius: 18,
  },
  hint: {
    ...type.caption,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center",
  },
  actions: { alignSelf: "stretch", gap: spacing.sm },
});

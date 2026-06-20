// OWNED BY: app-ui agent (friends mode).
//
// The friends-mode entry. Two ways in:
//   • CREATE — pick a handle, spin up a fresh room (host), land in /friends/[code].
//   • JOIN   — pick a handle + type a 4-char code, join an existing room.
//
// We connect to the SAME feed the whole app uses via useFriendsRoom; this screen
// just collects a name (+ code) and fires createRoom / joinRoom. The hook is
// authoritative for the room code, so we navigate to /friends/[code] off the
// hook's `code` once the server assigns it (see the effect below).
import React, { useEffect, useState } from "react";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ROOM_CODE_LEN } from "@golazo/core";
import { useStore } from "@/state/store";
import { colors, radius, spacing, type } from "@/theme";
import { Banner, Button, Chip, Screen, Text } from "@/ui";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { useFriendsRoomContext } from "@/features/friends";

type Tab = "create" | "join";

export default function FriendsEntryScreen() {
  const router = useRouter();
  const store = useStore();

  const room = useFriendsRoomContext();
  const [tab, setTab] = useState<Tab>("create");
  // Seed the handle from the player's saved display name so they don't retype it.
  const [name, setName] = useState(store.session.displayName ?? "");
  const [code, setCode] = useState("");
  // Which action we fired, so the effect only navigates after THIS screen acted
  // (not if the hook happened to already hold a stale room).
  const [submitting, setSubmitting] = useState(false);

  // Once the server assigns/confirms a room code, jump into the room screen.
  useEffect(() => {
    if (submitting && room.code) {
      router.replace(`/friends/${room.code}`);
    }
  }, [submitting, room.code, router]);

  const handle = name.trim();
  const cleanCode = code.trim().toUpperCase();
  const canCreate = handle.length >= 2 && room.conn !== "connecting";
  const canJoin =
    handle.length >= 2 &&
    cleanCode.length === ROOM_CODE_LEN &&
    room.conn !== "connecting";

  const onCreate = () => {
    if (!canCreate) return;
    Keyboard.dismiss();
    if (handle) store.setName(handle);
    setSubmitting(true);
    room.createRoom(handle);
  };

  const onJoin = () => {
    if (!canJoin) return;
    Keyboard.dismiss();
    if (handle) store.setName(handle);
    setSubmitting(true);
    room.joinRoom(cleanCode, handle);
  };

  return (
    <Screen>
      <UnifiedHeader
        variant="slim"
        title="Play with friends"
        onBack={() => router.back()}
      />

      <Text style={styles.blurb}>
        Same live match, private on-chain session with up to 8 friends — real
        devnet SOL parimutuel pools, session net on the leaderboard, and custom
        markets you settle by hand.
      </Text>

      {/* tab toggle */}
      <View style={styles.tabs}>
        <Chip
          label="CREATE A ROOM"
          tone="live"
          selected={tab === "create"}
          onPress={() => setTab("create")}
        />
        <Chip
          label="JOIN WITH A CODE"
          tone="info"
          selected={tab === "join"}
          onPress={() => setTab("join")}
        />
      </View>

      {/* name (shared by both tabs) */}
      <View style={styles.field}>
        <Text style={styles.label}>YOUR NAME</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Pick a handle"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          maxLength={20}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType={tab === "create" ? "done" : "next"}
          selectionColor={colors.yes}
          onSubmitEditing={tab === "create" ? onCreate : undefined}
        />
      </View>

      {tab === "join" ? (
        <View style={styles.field}>
          <Text style={styles.label}>ROOM CODE</Text>
          <TextInput
            value={code}
            onChangeText={(t) =>
              setCode(t.replace(/[^a-zA-Z0-9]/g, "").toUpperCase())
            }
            placeholder={"X".repeat(ROOM_CODE_LEN)}
            placeholderTextColor={colors.textFaint}
            style={[styles.input, styles.codeInput]}
            maxLength={ROOM_CODE_LEN}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="go"
            selectionColor={colors.cyan}
            onSubmitEditing={onJoin}
          />
        </View>
      ) : null}

      {room.error ? (
        <Banner tone="danger" message={room.error} style={styles.banner} />
      ) : null}

      <View style={styles.cta}>
        {tab === "create" ? (
          <Button
            label="Create room"
            onPress={onCreate}
            variant="primary"
            size="lg"
            fullWidth
            glow
            disabled={!canCreate}
            loading={submitting && room.conn === "connecting"}
            haptic="win"
          />
        ) : (
          <Button
            label="Join room"
            onPress={onJoin}
            variant="secondary"
            size="lg"
            fullWidth
            glow
            disabled={!canJoin}
            loading={submitting && room.conn === "connecting"}
            haptic="win"
          />
        )}
      </View>

      <Banner
        tone="info"
        title="Your own private pool"
        message="Bet your friends with real devnet SOL in a private room (2% fee) — session PnL on the leaderboard, up to 8 players. Your main wallet funds each bet."
        style={styles.note}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  blurb: {
    ...type.body,
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  tabs: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  field: { gap: spacing.sm, marginBottom: spacing.lg },
  label: {
    ...type.overline,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 1.6,
  },
  input: {
    ...type.subtitle,
    fontSize: 18,
    color: colors.textPrimary,
    backgroundColor: colors.surface0,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 54,
  },
  codeInput: {
    ...type.mono,
    fontSize: 26,
    letterSpacing: 8,
    textAlign: "center",
  },
  banner: { marginBottom: spacing.md },
  cta: { marginTop: spacing.xs },
  note: { marginTop: spacing.xl },
});

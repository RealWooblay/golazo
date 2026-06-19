// OWNED BY: app-ui agent (friends mode).
//
// DEEP-LINK JOIN TARGET. Both `golazo://join/ABCD` (native) and the web
// `/join/ABCD` URL resolve here via expo-router's file route. The code is already
// in the path — we just collect a handle and join, then hand off to the room
// screen. (Buildable as a shareable link via buildInviteLink in features/friends.)
import React, { useEffect, useState } from "react";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useStore } from "@/state/store";
import { colors, radius, spacing, type } from "@/theme";
import { Banner, Button, IconBack, IconButton, Screen, Text } from "@/ui";
import { useFriendsRoomContext } from "@/features/friends";

export default function JoinByCodeScreen() {
  const router = useRouter();
  const store = useStore();
  const params = useLocalSearchParams<{ code: string }>();
  const code = (params.code ?? "").toUpperCase();

  const room = useFriendsRoomContext();
  const [name, setName] = useState(store.session.displayName ?? "");
  const [submitting, setSubmitting] = useState(false);

  // Once we're actually in the room (the hook confirms our code), swap to the
  // room screen. replace() so Back doesn't bounce through this join prompt.
  useEffect(() => {
    if (submitting && room.code === code) {
      router.replace(`/friends/${code}`);
    }
  }, [submitting, room.code, code, router]);

  const handle = name.trim();
  const canJoin = handle.length >= 2 && !!code && room.conn !== "connecting";

  const onJoin = () => {
    if (!canJoin) return;
    Keyboard.dismiss();
    if (handle) store.setName(handle);
    setSubmitting(true);
    room.joinRoom(code, handle);
  };

  return (
    <Screen>
      <View style={styles.head}>
        <IconButton
          accessibilityLabel="Back"
          onPress={() => router.replace("/friends")}
        >
          <IconBack size={20} color={colors.textPrimary} />
        </IconButton>
        <Text style={styles.title}>Join the room</Text>
        <View style={styles.headSpacer} />
      </View>

      <View style={styles.codeBlock}>
        <Text style={styles.codeLabel}>YOU'RE JOINING ROOM</Text>
        <Text style={styles.code} allowFontScaling={false}>
          {code ? code.split("").join(" ") : "—"}
        </Text>
      </View>

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
          autoFocus
          returnKeyType="go"
          selectionColor={colors.cyan}
          onSubmitEditing={onJoin}
        />
      </View>

      {room.error ? (
        <Banner tone="danger" message={room.error} style={styles.banner} />
      ) : null}

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
  title: { ...type.title, fontSize: 20, color: colors.textPrimary },
  headSpacer: { width: 40 },
  codeBlock: { alignItems: "center", gap: spacing.xs, marginBottom: spacing.xl },
  codeLabel: {
    ...type.overline,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 2,
  },
  code: {
    ...type.display,
    fontSize: 40,
    color: colors.cyan,
    letterSpacing: 4,
    textShadowColor: colors.glow.cyan,
    textShadowRadius: 16,
  },
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
  banner: { marginBottom: spacing.md },
});

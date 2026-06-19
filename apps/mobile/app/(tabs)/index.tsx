// OWNED BY: home agent (Play / Lobby).
//
// The live lobby — the app's home. A brand + balance top bar, a cinematic LIVE
// "now playing" hero (tap → the real match loop), the live + upcoming slate as
// rich tappable rows, and a trending-parlay teaser for flair. Brief skeleton on
// first paint + pull-to-refresh, a thoughtful empty state if nothing's live.
// Everything is play-data (src/features/lobby/fixtures) and web-safe.
import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useStore } from "@/state/store";
import { colors, MAX_WIDTH, radius, spacing, type } from "@/theme";
import { GrainOverlay, Pressable, Surface, Text, Vignette } from "@/ui";
import { haptics } from "@/ui/haptics";
import {
  FixtureRow,
  LiveHero,
  LobbySkeleton,
  LobbyTopBar,
  liveFixtures,
  upcomingFixtures,
  type Fixture,
} from "@/features/lobby";
import { useLobbyFixtures } from "@/features/lobby/useEspnFixtures";
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";
import {
  Entrance,
  EmptyLobby,
  HowItWorksNudge,
  NextMatch,
  SectionHeader,
} from "@/features/lobby/parts";

export default function PlayTab() {
  const router = useRouter();
  const store = useStore();
  const insets = useSafeAreaInsets();
  const hx = store.session.hapticsOn;

  // The lobby shows REAL games only (ESPN) — never the sim/demo. Empty when
  // nothing's live; the demo is loaded explicitly from Profile → Demo match.
  // Returning here always resets to LIVE (real) mode — the lobby is the real
  // home, and a demo excursion (offline mode) shouldn't linger once you're back.
  useFocusEffect(
    React.useCallback(() => {
      if (store.mode !== "live") store.setMode("live");
    }, [store]),
  );
  const bal = useDisplayBalance(); // real SOL in chain mode, play $ otherwise
  const { fixtures, loading, refresh } = useLobbyFixtures();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    if (hx) haptics.selection();
    refresh();
    const id = setTimeout(() => setRefreshing(false), 700);
    return () => clearTimeout(id);
  }, [hx, refresh]);

  const live = liveFixtures(fixtures);
  const upcoming = upcomingFixtures(fixtures);
  // Hero = the real live game, if any. No sim/demo fallback → empty lobby otherwise.
  const hero = live[0] ?? null;
  const restLive = live.filter((f) => f.id !== hero?.id);
  // When nothing's live, the soonest upcoming match becomes the "up next"
  // centrepiece (in place of a dead empty box). It's then dropped from the
  // "Coming up" list below so it isn't shown twice.
  const next = !hero ? (upcoming[0] ?? null) : null;
  const restUpcoming = next ? upcoming.filter((f) => f.id !== next.id) : upcoming;

  const openMatch = (f: Fixture) => {
    // Lobby = real games only → ensure LIVE mode so the match connects to the
    // live feed + real on-chain betting (not the local sim).
    store.setMode("live");
    router.push(`/match/${f.id}`);
  };

  const addCash = () => {
    if (hx) haptics.tap();
    router.push("/(modals)/deposit");
  };

  const playWithFriend = () => {
    if (hx) haptics.tap();
    router.push("/friends");
  };

  return (
    <View style={styles.root}>
      <Vignette tint="yes" intensity={0.42} />

      {/* Top bar pinned above the scroll, under the status bar. */}
      <View
        style={[styles.topBarWrap, { paddingTop: insets.top + spacing.xs }]}
      >
        <View style={styles.column}>
          <LobbyTopBar
            balance={bal.amount}
            format={bal.format}
            hapticsEnabled={hx}
            onAddCash={addCash}
            onOpenProfile={() => router.push("/(tabs)/profile")}
          />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: 110 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.yes}
            colors={[colors.yes]}
            progressBackgroundColor={colors.surface2}
          />
        }
      >
        <View style={styles.column}>
          <View style={styles.body}>
            {loading ? (
              <LobbySkeleton />
            ) : (
              <>
                {hero ? (
                  <LiveHero
                    fixture={hero}
                    hapticsEnabled={hx}
                    onPress={() => openMatch(hero)}
                  />
                ) : next ? (
                  // Nothing live, but a match is coming → show the next game.
                  <Entrance>
                    <NextMatch
                      fixture={next}
                      onHowItWorks={() => router.push("/how-it-works")}
                    />
                  </Entrance>
                ) : (
                  <EmptyLobby
                    onHowItWorks={() => router.push("/how-it-works")}
                  />
                )}

                {/* Friends mode sits up top — it's a real, primary feature, not
                    a footer afterthought. Directly under the hero so it's one of
                    the first things you see. */}
                <View style={styles.section}>
                  <SectionHeader
                    title="Play with friends"
                    caption="PRIVATE ROOM"
                    tone="gold"
                  />
                  <Entrance delay={40}>
                    <FriendsEntry onPress={playWithFriend} />
                  </Entrance>
                </View>

                {restLive.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader
                      title="Live now"
                      caption={`${restLive.length} more in play`}
                      tone="live"
                    />
                    <View style={styles.list}>
                      {restLive.map((f, i) => (
                        <Entrance key={f.id} delay={60 + i * 50}>
                          <FixtureRow
                            fixture={f}
                            hapticsEnabled={hx}
                            onPress={() => openMatch(f)}
                          />
                        </Entrance>
                      ))}
                    </View>
                  </View>
                ) : null}

                {restUpcoming.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader
                      title="Coming up"
                      caption={`${restUpcoming.length} ${
                        restUpcoming.length === 1 ? "fixture" : "fixtures"
                      }`}
                      tone="info"
                    />
                    <View style={styles.list}>
                      {/* Upcoming rows are NOT tappable (no onPress) — they show
                          a countdown to kickoff, not a way into a match. */}
                      {restUpcoming.map((f, i) => (
                        <Entrance key={f.id} delay={80 + i * 50}>
                          <FixtureRow fixture={f} hapticsEnabled={hx} />
                        </Entrance>
                      ))}
                    </View>
                  </View>
                ) : null}

                <View style={styles.section}>
                  <Entrance delay={200}>
                    <HowItWorksNudge
                      onPress={() => router.push("/how-it-works")}
                      hapticsEnabled={hx}
                    />
                  </Entrance>
                </View>
              </>
            )}
          </View>
        </View>
      </ScrollView>

      <GrainOverlay opacity={0.035} />
    </View>
  );
}

/**
 * FriendsEntry — the lobby's tasteful door into friends mode. A
 * single tappable Surface row (matches the slate's visual weight, no fake data):
 * a versus glyph, a one-line pitch, and a chevron into /friends.
 */
function FriendsEntry({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} haptic={null} scaleTo={0.98}>
      <Surface
        radius={radius.lg}
        glow="cyan"
        borderColor={colors.glow.cyanSoft}
        style={friendStyles.row}
      >
        <View style={friendStyles.icon}>
          <Text style={friendStyles.iconGlyph}>VS</Text>
        </View>
        <View style={friendStyles.text}>
          <Text preset="bodyStrong">Play with friends</Text>
          <Text preset="caption" muted>
            Same live match — bet your friends for real, settle up at full time.
            Create a room or join a code.
          </Text>
        </View>
        <View style={friendStyles.arrow} />
      </Surface>
    </Pressable>
  );
}

const friendStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.alpha.cyan,
    borderWidth: 1,
    borderColor: "rgba(22,198,255,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: {
    ...type.subtitle,
    fontSize: 13,
    color: colors.cyan,
    letterSpacing: 1,
  },
  text: { flex: 1, gap: 1 },
  arrow: {
    width: 8,
    height: 8,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: colors.textFaint,
    transform: [{ rotate: "45deg" }],
  },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBarWrap: {
    zIndex: 10,
    backgroundColor: colors.bg,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  column: { width: "100%", maxWidth: MAX_WIDTH, alignSelf: "center" },
  scroll: { alignItems: "center", flexGrow: 1 },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  section: { marginTop: spacing.xxl },
  list: { gap: spacing.sm },
});

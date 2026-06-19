// OWNED BY: app-ui agent (friends mode).
//
// THE FRIENDS ROOM. A room overlays the feed's CURRENT live match: the
// friends bet REAL $ into a private, low-fee parimutuel pool against each other
// — AI markets mirrored from the feed resolve in lockstep, and either player can
// author a "bet this moment" friend market that the host/author settles by hand.
// It's a private $ session: each market resolves into a running balance and the
// whole thing settles once at full time.
//
// The SERVER is authoritative for balances + room state; this screen renders
// whatever the latest RoomState says (via useFriendsRoom) and only ANIMATES
// reveals for flavour. Visual language matches app/match/[id].tsx — same
// scoreboard, commentary ticker, market + reveal cards — so friends mode feels
// like the main loop, just scored for two.
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import type { Outcome, RoomMarket } from "@golazo/core";
import { impliedOdds, indicativeQuote } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import {
  Banner,
  Button,
  Chip,
  Confetti,
  IconBack,
  IconButton,
  Screen,
  Surface,
  Text,
  Toast,
} from "@/ui";
import { haptics } from "@/ui/haptics";
import { useStore } from "@/state/store";
import { useTick } from "@/hooks";
import { resolveTeams } from "@/features/match/teams";
import {
  CommentaryTicker,
  LiveScoreboard,
  MarketCard,
  RevealCard,
  WaitingCard,
} from "@/features/match/components";
import type { MarketVM, RevealVM } from "@/state/types";
import { money } from "@/lib/format";
import {
  useFriendsRoomContext,
  type FriendsRoomReveal,
} from "@/features/friends";
import {
  Leaderboard,
  MakeMarketSheet,
  RoomInviteCard,
} from "@/features/friends/components";

/**
 * RoomMarket → MarketVM. The market card is reused verbatim; we flatten the
 * room market's parimutuel pool into the VM it expects:
 *   • pool       = the gross pool (yes + no), 0 before any bet,
 *   • yesShare   = the YES portion of that pool (50 when empty, so the split bar
 *                  rests centered instead of snapping to a side),
 *   • oddsYes/No = the pool-implied multiples (core impliedOdds, rake 0) — these
 *                  are only fallbacks, since MarketCard recomputes stake-aware
 *                  pool odds itself once the card has a live pool + stake,
 *   • phase      = the card's lifecycle from the market status,
 *   • NO onChain — room markets are never on-chain.
 */
function toMarketVM(m: RoomMarket): MarketVM {
  const pool = m.pool.yes + m.pool.no;
  const yesShare = pool > 0 ? (100 * m.pool.yes) / pool : 50;
  const odds = impliedOdds(m.pool, 0);
  const phase =
    m.status === "open"
      ? "open"
      : m.status === "locked"
        ? "locked"
        : "resolved";
  const subtitle =
    m.source === "friend"
      ? "Friend market · you set the line"
      : "From the live feed";
  return {
    id: m.id,
    question: m.question,
    subtitle,
    team: m.team,
    phase,
    oddsYes: odds.yes,
    oddsNo: odds.no,
    pool,
    yesShare,
    participants: new Set(m.bets.map((b) => b.userId)).size,
    openedAt: m.openedAt,
    lockAt: m.lockAt,
    windowMs: m.windowMs,
  };
}

/**
 * FriendsRoomReveal → RevealVM. The reveal card speaks WIN/MISS/VOID; the room
 * reveal speaks the raw outcome + a won flag. Map: WIN if won, VOID if the
 * outcome voided, else MISS.
 */
function toRevealVM(r: FriendsRoomReveal): RevealVM {
  // RevealCard derives WIN from `won`, VOID from `outcome === 'VOID'`, and MISS
  // otherwise — so we carry `won` + the raw outcome straight through. (RevealCard
  // shows the side in the MISS copy, so `side` matters too.)
  return {
    marketId: r.marketId,
    question: r.question,
    team: r.team,
    side: r.side,
    stake: r.stake,
    payoutMult: r.payoutMult,
    outcome: r.outcome,
    won: r.won,
    payout: r.payout,
  };
}

export default function FriendsRoomScreen() {
  const { code: routeCode } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const store = useStore();
  const hapticsOn = store.session.hapticsOn;

  const room = useFriendsRoomContext();

  // Deep-link / cold-load guard: if we landed on /friends/CODE without an active
  // room membership (e.g. opened the link directly or reloaded the page), bounce
  // to the join screen to collect a handle and actually join. The host who just
  // created — and a friend who just joined — both already have room.code set, so
  // this never fires for them.
  React.useEffect(() => {
    if (routeCode && !room.code && room.conn === "idle") {
      router.replace(`/join/${routeCode}`);
    }
  }, [routeCode, room.code, room.conn, router]);

  const {
    state,
    game,
    commentary,
    players,
    me,
    opponent,
    isHost,
    openMarkets,
    myBetByMarket,
    reveals,
    placeBet,
    makeMarket,
    resolveMarket,
    acknowledgeReveal,
    leaveRoom,
    inviteLink,
  } = room;

  const code = state?.code ?? routeCode ?? "";
  const phase = state?.phase ?? "lobby";
  const waiting = !opponent; // no friends yet → show the invite hero
  const roomFull = players.length >= 8; // mirrors the server cap (MAX_ROOM_PLAYERS)

  // Local stake selector ($), independent of the global $ stake chip. Room bets
  // are real-$ parimutuel — chips are $10 / $25 / $50 / $100.
  const [stake, setStake] = useState(25);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confetti, setConfetti] = useState(0);
  // Toggle to re-show the invite card once friends are in (keep adding up to 8).
  const [showInvite, setShowInvite] = useState(false);

  // Tick the market countdowns while focused and something is open.
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    React.useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const ticking = focused && openMarkets.length > 0;
  const now = useTick(80, ticking);

  const teams = useMemo(() => resolveTeams(game?.gameId, game ?? null), [game]);

  const leave = () => {
    if (hapticsOn) haptics.tap();
    leaveRoom();
    router.replace("/(tabs)");
  };

  const onBet = (m: RoomMarket, side: "YES" | "NO") => {
    placeBet(m.id, side, stake);
  };

  const onReveal = (r: FriendsRoomReveal) => {
    acknowledgeReveal(r.marketId);
    if (r.won) setConfetti((n) => n + 1);
  };

  const onMakeMarket = (question: string, opts?: { team?: "home" | "away" }) => {
    makeMarket(question, opts);
  };

  // I can resolve a friend market I authored, or any friend market if I'm host.
  const canResolve = (m: RoomMarket) =>
    m.source === "friend" &&
    (isHost || m.authorId === room.userId) &&
    (m.status === "open" || m.status === "locked");

  const fulltime = phase === "fulltime";
  const winner = useMemo(() => {
    if (!fulltime || players.length === 0) return undefined;
    const top = players[0];
    const tie = players.length > 1 && players[1].balance === top.balance;
    return tie ? undefined : top;
  }, [fulltime, players]);

  return (
    <Screen scroll padded={false} vignette={fulltime ? "gold" : "yes"}>
      {/* slim header: room code + leave */}
      <View style={styles.header}>
        <IconButton accessibilityLabel="Leave room" onPress={leave}>
          <IconBack size={20} color={colors.textPrimary} />
        </IconButton>
        <View style={styles.headerCenter}>
          <Text style={styles.brand}>FRIENDS</Text>
          <Chip label={`ROOM ${code}`} tone="info" />
        </View>
        <Button
          label="Leave"
          onPress={leave}
          variant="ghost"
          size="sm"
          haptic="tap"
        />
      </View>

      <View style={styles.body}>
        {/* connection / error state */}
        {room.conn === "error" || room.error ? (
          <View style={styles.gutter}>
            <Banner
              tone="danger"
              message={room.error ?? "Lost the room connection."}
            />
          </View>
        ) : null}

        {/* live match scoreboard + commentary (from the global feed frames) */}
        <View style={styles.gutter}>
          <LiveScoreboard
            home={teams.home}
            away={teams.away}
            scoreHome={game?.scoreHome ?? 0}
            scoreAway={game?.scoreAway ?? 0}
            clock={game?.clock ?? "0'"}
            momentum={openMarkets[0]?.team}
            live={!fulltime}
          />
        </View>

        {commentary ? (
          <View style={styles.gutter}>
            <CommentaryTicker text={commentary} />
          </View>
        ) : null}

        {/* ── FULL TIME: winner banner + final standings ───────────────── */}
        {fulltime ? (
          <View style={styles.gutter}>
            <Surface
              radius={radius.xl}
              glow="gold"
              borderColor={colors.glow.goldSoft}
              style={styles.finalCard}
            >
              <Chip label="FULL TIME" tone="win" />
              <Text style={styles.finalTitle}>
                {winner
                  ? winner.userId === room.userId
                    ? "You won! 🏆"
                    : `${winner.name} wins`
                  : "Dead heat"}
              </Text>
              <Text style={styles.finalSub} center>
                {winner
                  ? `${money(winner.balance)} vs ${money(
                      players[1]?.balance ?? 0,
                    )}`
                  : "You finished level on the money."}
              </Text>
            </Surface>
          </View>
        ) : null}

        {/* leaderboard (both players, leader highlighted) */}
        <View style={styles.gutter}>
          <Leaderboard
            players={players}
            meId={room.userId}
            compact={fulltime}
          />
        </View>

        {/* ── invite friends: hero while alone, toggleable once friends are in ── */}
        {!fulltime && (waiting || showInvite) ? (
          <View style={styles.gutter}>
            <RoomInviteCard
              code={code}
              inviteLink={inviteLink}
              hapticsEnabled={hapticsOn}
            />
          </View>
        ) : null}

        {/* ── live: reveals (animate the result), then open markets ────── */}
        {!fulltime
          ? reveals.map((r) => (
              <View key={r.marketId} style={styles.gutter}>
                <RevealCard
                  reveal={toRevealVM(r)}
                  onAcknowledge={() => onReveal(r)}
                  hapticsEnabled={hapticsOn}
                />
              </View>
            ))
          : null}

        {!fulltime && !waiting
          ? openMarkets.map((m) => {
              const myBet = myBetByMarket[m.id];
              const pending = myBet
                ? {
                    marketId: m.id,
                    side: myBet.side,
                    stake: myBet.stake,
                    // Parimutuel has no fixed multiple — show the indicative
                    // quote my stake earned from the pool at bet time (rake 0).
                    estimatedMult: indicativeQuote(
                      m.pool,
                      myBet.side,
                      myBet.stake,
                      0,
                    ).multiple,
                  }
                : null;
              return (
                <View key={m.id} style={styles.gutter}>
                  <MarketCard
                    market={toMarketVM(m)}
                    now={now}
                    stake={stake}
                    onStakeChange={setStake}
                    pending={pending}
                    balance={me?.balance ?? 0}
                    formatStake={money}
                    onBet={(side) => onBet(m, side)}
                    hapticsEnabled={hapticsOn}
                  />
                  {canResolve(m) ? (
                    <ResolveControls
                      onResolve={(o) => resolveMarket(m.id, o)}
                      hapticsEnabled={hapticsOn}
                    />
                  ) : null}
                </View>
              );
            })
          : null}

        {/* idle: nothing open, nothing revealing, opponent present */}
        {!fulltime &&
        !waiting &&
        openMarkets.length === 0 &&
        reveals.length === 0 ? (
          <View style={styles.gutter}>
            <WaitingCard
              title="Next moment loading…"
              body="A market pops for everyone in the room the second the match heats up."
            />
          </View>
        ) : null}

        {/* make-a-market + invite-more CTAs (live + friends present) */}
        {!fulltime && !waiting ? (
          <View style={[styles.gutter, styles.ctaStack]}>
            <Button
              label="＋ Make a market"
              onPress={() => {
                if (hapticsOn) haptics.tap();
                setSheetOpen(true);
              }}
              variant="secondary"
              size="md"
              fullWidth
              glow={false}
              haptic={null}
            />
            {!roomFull ? (
              <Button
                label={showInvite ? "Hide invite" : "＋ Invite more friends"}
                onPress={() => {
                  if (hapticsOn) haptics.tap();
                  setShowInvite((v) => !v);
                }}
                variant="ghost"
                size="md"
                fullWidth
                glow={false}
                haptic={null}
              />
            ) : null}
          </View>
        ) : null}

        {/* full-time: back to lobby */}
        {fulltime ? (
          <View style={styles.gutter}>
            <Button
              label="Back to lobby"
              onPress={leave}
              variant="primary"
              size="lg"
              fullWidth
              glow
              haptic="tap"
            />
          </View>
        ) : null}
      </View>

      <MakeMarketSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSubmit={onMakeMarket}
        hapticsEnabled={hapticsOn}
      />

      <Toast
        message={room.conn === "connecting" ? "Connecting…" : null}
        tone="info"
        onHide={() => {}}
      />
      <Confetti trigger={confetti} count={36} />
    </Screen>
  );
}

/**
 * ResolveControls — the host/author's by-hand settle buttons for a friend market.
 * Three calls: it landed YES, it landed NO, or VOID (no result / scrap it).
 */
function ResolveControls({
  onResolve,
  hapticsEnabled = true,
}: {
  onResolve: (outcome: Outcome) => void;
  hapticsEnabled?: boolean;
}) {
  const fire = (o: Outcome) => {
    if (hapticsEnabled) haptics.selection();
    onResolve(o);
  };
  return (
    <View style={styles.resolveWrap}>
      <Text style={styles.resolveLabel}>YOU SETTLE THIS ONE</Text>
      <View style={styles.resolveRow}>
        <Button
          label="YES"
          onPress={() => fire("YES")}
          variant="primary"
          size="sm"
          glow={false}
          haptic={null}
          style={styles.resolveBtn}
        />
        <Button
          label="NO"
          onPress={() => fire("NO")}
          variant="danger"
          size="sm"
          glow={false}
          haptic={null}
          style={styles.resolveBtn}
        />
        <Button
          label="VOID"
          onPress={() => fire("VOID")}
          variant="ghost"
          size="sm"
          haptic={null}
          style={styles.resolveBtn}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  headerCenter: { alignItems: "center", gap: 5 },
  brand: {
    ...type.overline,
    fontSize: 10,
    color: colors.textFaint,
    letterSpacing: 2,
  },
  body: { gap: spacing.md, marginTop: spacing.xs },
  gutter: { paddingHorizontal: spacing.lg },
  ctaStack: { gap: spacing.sm },
  finalCard: { padding: spacing.xl, gap: spacing.sm, alignItems: "center" },
  finalTitle: { ...type.display, fontSize: 28, color: colors.gold },
  finalSub: { ...type.body, fontSize: 14, color: colors.textMuted },
  resolveWrap: { marginTop: spacing.sm, gap: spacing.xs },
  resolveLabel: {
    ...type.overline,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 1.6,
    paddingHorizontal: spacing.xs,
  },
  resolveRow: { flexDirection: "row", gap: spacing.sm },
  resolveBtn: { flex: 1 },
});

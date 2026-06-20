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
import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import type { Outcome, RoomMarket } from "@golazo/core";
import { impliedOdds, indicativeQuote, ROOM_RAKE } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import {
  Banner,
  Button,
  Chip,
  Confetti,
  Screen,
  Surface,
  Text,
  Toast,
} from "@/ui";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { haptics } from "@/ui/haptics";
import { useStore } from "@/state/store";
import { useTick } from "@/hooks";
import { useChain } from "@/features/chain/useChain";
import { useRoomChainBets } from "@/features/friends/useRoomChainBets";
import {
  useDisplayBalance,
  makeStakeFormatter,
  SOL_PER_UNIT,
} from "@/features/chain/useDisplayBalance";
import { bettingSafetyBufferMs } from "@/lib/config";
import { resolveTeams } from "@/features/match/teams";
import {
  CommentaryTicker,
  LiveScoreboard,
  MarketCard,
  RevealCard,
  WaitingCard,
} from "@/features/match/components";
import type { MarketVM, RevealVM } from "@/state/types";
import {
  useFriendsRoomContext,
  type FriendsRoomReveal,
} from "@/features/friends";
import {
  Leaderboard,
  MakeMarketSheet,
  RoomInviteCard,
  FriendsChainPanel,
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
 *   • onChain    — per-room on-chain twin when chain mode is active.
 */
function toMarketVM(m: RoomMarket, now?: number): MarketVM {
  const pool = m.pool.yes + m.pool.no;
  const yesShare = pool > 0 ? (100 * m.pool.yes) / pool : 50;
  const odds = impliedOdds(m.pool, ROOM_RAKE);
  const expired = now != null && m.status === "open" && now > m.lockAt;
  const phase =
    m.status === "open" && !expired
      ? "open"
      : m.status === "open" || m.status === "locked"
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
    // Friend markets settle by hand (host/author) — no fixed resolve clock; 0s
    // let MarketCard fall back to its own defaults for the post-lock countdown.
    resolveWindowMs: 0,
    resolveAt: 0,
    ...(m.onChain ? { onChain: m.onChain } : {}),
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
  const chain = useChain();
  const bal = useDisplayBalance();
  const stakeFormat = makeStakeFormatter(bal.chain);

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
    activeMarkets,
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
  const waiting = players.length < 2;
  const roomFull = players.length >= 8;
  const chainMode =
    chain.ready && store.session.moneyMode === "real" && bal.chain;

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
  const ticking = focused && activeMarkets.length > 0;
  const now = useTick(80, ticking);

  const activeMarketVMs = useMemo(
    () => activeMarkets.map((m) => toMarketVM(m, now)),
    [activeMarkets, now],
  );
  const roomChain = useRoomChainBets(
    chain,
    store.stake,
    chainMode,
    activeMarketVMs,
  );

  const resolvedMarketIds = useMemo(
    () =>
      new Set(
        (state?.markets ?? [])
          .filter((m) => m.status === "resolved" || m.status === "void")
          .map((m) => m.id),
      ),
    [state?.markets],
  );
  useEffect(() => {
    if (chainMode) roomChain.markResolved(resolvedMarketIds);
  }, [chainMode, resolvedMarketIds, roomChain.markResolved]);

  const teams = useMemo(() => resolveTeams(game?.gameId, game ?? null), [game]);

  const leave = () => {
    if (hapticsOn) haptics.tap();
    leaveRoom();
    router.replace("/(tabs)");
  };

  const onBet = async (m: RoomMarket, side: "YES" | "NO") => {
    if (!chainMode) return;
    const vm = toMarketVM(m, now);
    if (!vm.onChain) return;
    const ok = await roomChain.placeBet(vm, side, store.stake);
    if (ok) placeBet(m.id, side, store.stake);
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
  const canMakeMarket = activeMarkets.length === 0 && !waiting && !fulltime;

  const winner = useMemo(() => {
    if (!fulltime || players.length === 0) return undefined;
    const top = players[0];
    const tie = players.length > 1 && players[1].balance === top.balance;
    return tie ? undefined : top;
  }, [fulltime, players]);

  return (
    <Screen scroll padded={false} vignette={fulltime ? "gold" : "yes"}>
      {/* slim header: FRIENDS title, leave on the back glyph, the room code chip
          + wallet pill in the right slot. */}
      <UnifiedHeader
        variant="slim"
        title="FRIENDS"
        onBack={leave}
        style={styles.header}
        right={
          <View style={styles.headerRight}>
            <Chip label={`ROOM ${code}`} tone="info" />
            <View style={styles.walletPill}>
              <Text style={styles.walletValue}>{bal.format(bal.amount)}</Text>
              <Text style={styles.walletLabel}>WALLET</Text>
            </View>
          </View>
        }
      />

      <View style={styles.body}>
        {/* connection / error state */}
        {room.conn === "error" && room.error ? (
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
            momentum={activeMarkets[0]?.team}
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
                  ? `${stakeFormat(winner.balance)} vs ${stakeFormat(
                      players[1]?.balance ?? 0,
                    )}`
                  : "You finished level on session net."}
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
            format={stakeFormat}
            balanceLabel="NET"
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

        {chainMode && chain.configured ? (
          <View style={styles.gutter}>
            <FriendsChainPanel
              bets={roomChain.bets}
              error={roomChain.error}
              onClaim={roomChain.claim}
            />
          </View>
        ) : null}

        {!fulltime && !waiting && !chainMode ? (
          <View style={styles.gutter}>
            <Banner
              tone="info"
              title="Wallet required"
              message="Switch to real money and connect your wallet to bet with friends."
            />
          </View>
        ) : null}

        {!fulltime && !waiting
          ? activeMarkets.map((m) => {
              const myBet = myBetByMarket[m.id];
              const vm = toMarketVM(m, now);
              const chainBet = roomChain.getBet(m.id);
              const liveOdds = roomChain.getLiveOdds(m.id);
              const displayMarket =
                chainMode && liveOdds
                  ? {
                      ...vm,
                      oddsYes: liveOdds.oddsYes,
                      oddsNo: liveOdds.oddsNo,
                      pool: liveOdds.poolSol / SOL_PER_UNIT,
                      yesShare: liveOdds.yesShare,
                    }
                  : vm;
              const chainLocked =
                chainMode && (roomChain.placing || !!chainBet);
              const chainPreparing =
                chainMode &&
                !!m.onChain &&
                !roomChain.isTwinReady(m.id) &&
                !chainBet;
              const marketClosing =
                vm.phase === "open" &&
                now >= vm.lockAt - bettingSafetyBufferMs(vm.windowMs);
              const pending =
                chainMode && chainBet
                  ? {
                      marketId: m.id,
                      side: chainBet.side,
                      stake: store.stake,
                      estimatedMult: chainBet.estimatedMultiple,
                    }
                  : myBet
                    ? {
                        marketId: m.id,
                        side: myBet.side,
                        stake: myBet.stake,
                        estimatedMult: indicativeQuote(
                          m.pool,
                          myBet.side,
                          myBet.stake,
                          ROOM_RAKE,
                        ).multiple,
                      }
                    : null;
              return (
                <View key={m.id} style={styles.gutter}>
                  {chainPreparing ? (
                    <Banner
                      tone="info"
                      message="On-chain market preparing — bet buttons unlock in a moment."
                    />
                  ) : null}
                  <MarketCard
                    market={displayMarket}
                    now={now}
                    stake={store.stake}
                    onStakeChange={store.setStake}
                    pending={pending}
                    balance={bal.balanceInUnits}
                    formatStake={stakeFormat}
                    onBet={(side) => void onBet(m, side)}
                    hapticsEnabled={hapticsOn}
                    betDisabled={
                      !chainMode ||
                      chainPreparing ||
                      chainLocked ||
                      marketClosing
                    }
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
        activeMarkets.length === 0 &&
        reveals.length === 0 ? (
          <View style={styles.gutter}>
            <WaitingCard
              title="Next moment loading…"
              body="A market pops for everyone in the room the second the match heats up."
            />
          </View>
        ) : null}

        {/* make-a-market + invite-more CTAs (live + friends present) */}
        {!fulltime && !waiting && canMakeMarket ? (
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
        message={
          room.conn === "connecting"
            ? room.code
              ? "Reconnecting to room…"
              : "Connecting…"
            : null
        }
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
      <Text style={styles.resolveLabel}>YOU SETTLE THIS ONE · REAL ON-CHAIN</Text>
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
  header: { paddingBottom: spacing.sm },
  headerRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  walletPill: { minWidth: 78, alignItems: "flex-end", paddingVertical: 4 },
  walletValue: { ...type.mono, fontSize: 14, color: colors.textPrimary },
  walletLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    marginTop: 1,
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

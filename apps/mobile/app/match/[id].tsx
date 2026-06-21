// OWNED BY: match agent (the live "bet the play" loop).
//
// The hero of the app: a cinematic live header + scoreboard, a live commentary
// ticker, the market card (countdown ring, animated odds, pool split-bar, juicy
// YES/NO, stake chips, bet confirmation), the weighty tap-to-reveal with
// WIN confetti / MISS shake / VOID refund, a recent-results rail, and a "waiting
// for the next moment" state that still feels alive. All engine wiring lives in
// src/features/match/useGameFeed.ts; visuals are composed from '@/ui' + the
// match components.
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { colors, spacing, type } from "@/theme";
import { AnimatedNumber, Banner, Chip, Confetti, Screen, Text, Toast } from "@/ui";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { useStore } from "@/state/store";
import { BET_SAFETY_BUFFER_MS, bettingSafetyBufferMs } from "@/lib/config";
import { useTick } from "@/hooks";
import { useGameFeed } from "@/features/match/useGameFeed";
import { useChainBet } from "@/features/match/useChainBet";
import { useChain } from "@/features/chain/useChain";
import {
  useDisplayBalance,
  makeStakeFormatter,
  SOL_PER_UNIT,
} from "@/features/chain/useDisplayBalance";
import { resolveTeams } from "@/features/match/teams";
import {
  ChainBetPanel,
  ClosedMarketsList,
  CommentaryTicker,
  FullTimeCard,
  LiveScoreboard,
  MarketCard,
  MatchFriendsBar,
  ResultsRail,
  RevealCard,
  WaitingCard,
} from "@/features/match/components";

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const store = useStore();
  const hapticsOn = store.session.hapticsOn;

  const {
    game,
    commentary,
    momentum,
    market,
    pending,
    activeReveal,
    historicMarkets,
    catchingUp,
    effectiveMode,
    fallbackNotice,
    placeBet,
    acknowledgeReveal,
    toast,
    clearToast,
  } = useGameFeed();

  // Drive the countdown ring + smooth progress only while a market is on screen
  // and the screen is focused (pause the heartbeat otherwise to save cycles).
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    React.useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const ticking = focused && !!market && market.phase === "open";
  const now = useTick(80, ticking);

  // Team identity (crests + colors) — from the lobby fixture we came through, or
  // synthesised from the live game state.
  const teams = useMemo(() => resolveTeams(id, game), [id, game]);
  // Full time: the game has ended — there are no more markets, so the stage shows
  // a clean end state (final score + settle) instead of the idle "reading the
  // game" radar. (Friends rooms have their own full-time standings.)
  const finished = game?.status === "final";
  // Half time: a brief mid-match pause — betting's closed, second half moments away.
  const halftime = game?.status === "halftime";
  // Who's pressing: the agent's live momentum read (server-driven) wins; fall back
  // to the open market's team for offline/sim where there's no momentum feed.
  const momentumTeam =
    finished || halftime ? undefined : (momentum ?? market?.team ?? undefined);

  // On-chain layer. When the feed runs in chain mode, the current market carries
  // `onChain` and the embedded wallet places REAL bets on it (cb.active). Otherwise
  // this stays inert and the play-money flow below runs unchanged.
  const chain = useChain();
  const cb = useChainBet(market, chain);
  const chainMode = cb.active;
  // Money is real SOL in chain mode, play $ in sandbox — for the header balance
  // AND the stake chips / over-balance check (so nothing reads "$" while you bet SOL).
  const bal = useDisplayBalance();
  const stakeFormat = makeStakeFormatter(bal.points);
  // Once a real bet is placed (or is mid-flight) on this market, lock the card so
  // the program's one-bet-per-market rule isn't tripped by a double tap.
  const chainLocked =
    chainMode &&
    (cb.placing || cb.bet?.offChainMarketId === market?.id);
  const chainPreparing = chainMode && market && !cb.chainTwinReady && !cb.bet;
  const marketClosing =
    !!market &&
    market.phase === "open" &&
    now >= market.lockAt - bettingSafetyBufferMs(market.windowMs);
  const chainPending =
    chainLocked && market
      ? {
          marketId: market.id,
          side: cb.bet?.side ?? "YES",
          stake: store.stake,
          estimatedMult: cb.bet?.estimatedMultiple ?? 0,
        }
      : null;
  // In chain mode show the REAL on-chain pool estimate, not the bot-inflated
  // off-chain odds, so the card matches the bet receipt.
  const displayMarket =
    chainMode && cb.liveOdds && market
      ? {
          ...market,
          oddsYes: cb.liveOdds.oddsYes,
          oddsNo: cb.liveOdds.oddsNo,
          pool: cb.liveOdds.poolSol / SOL_PER_UNIT,
          yesShare: cb.liveOdds.yesShare,
        }
      : market;

  // ── Win confetti: fire when a reveal is acknowledged as a win ───────────────
  const [confettiTrigger, setConfettiTrigger] = useState(0);

  const onBet = (side: "YES" | "NO") => {
    // Chain mode → REAL on-chain place_bet with the embedded wallet. Play mode →
    // the local play-money engine. The market card's bet UI is identical; only the
    // money rail differs.
    if (chainMode) void cb.placeChainBet(side, store.stake);
    else placeBet(side, store.stake);
  };

  const onReveal = (marketId: string, won: boolean) => {
    // Snapshot the win flag before the hook clears this reveal.
    acknowledgeReveal(marketId);
    if (won) setConfettiTrigger((n) => n + 1);
  };

  // Tint the stage for the live market only. Unopened reveal cards stay neutral
  // until tapped, so the result is not spoiled by gold/red/cyan chrome. Full time
  // gets a calm gold wash to mark the end of the session.
  const vignette: "neutral" | "yes" | "no" | "gold" = finished
    ? "gold"
    : market
      ? "yes"
      : "neutral";

  return (
    <Screen scroll padded={false} vignette={vignette} footerSpace={spacing.xxl}>
      {/* Routed through UnifiedHeader (slim) so the match chrome matches the rest
          of the app. 'slim' keeps the back chevron MatchHeader had; the live/mode
          chip (tap → how-it-works) and the animated count-up balance pill ride in
          the right slot, preserving the old behaviour. */}
      <UnifiedHeader
        variant="slim"
        title="GOLAZO"
        onBack={() => router.back()}
        right={
          <View style={styles.headerRight}>
            <Chip
              label={
                bal.points
                  ? "PAPER TRADE"
                  : effectiveMode === "live"
                    ? "LIVE FEED"
                    : "SANDBOX"
              }
              tone={
                bal.points ? "win" : effectiveMode === "live" ? "live" : "info"
              }
              dot
              onPress={() => router.push("/how-it-works")}
            />
            <View style={styles.balance}>
              <AnimatedNumber
                value={bal.amount}
                format={bal.format}
                style={styles.balValue}
              />
              <Text style={styles.balLabel}>
                {bal.points ? "points" : "balance"}
              </Text>
            </View>
          </View>
        }
      />

      <View style={styles.body}>
        <View style={styles.gutter}>
          <LiveScoreboard
            home={teams.home}
            away={teams.away}
            scoreHome={game?.scoreHome ?? 0}
            scoreAway={game?.scoreAway ?? 0}
            clock={finished ? "FT" : halftime ? "HT" : (game?.clock ?? "0'")}
            momentum={momentumTeam}
            live={!finished && !halftime}
          />
        </View>

        {fallbackNotice ? (
          <View style={styles.gutter}>
            <Banner tone="info" message={fallbackNotice} />
          </View>
        ) : null}

        <View style={styles.gutter}>
          <CommentaryTicker text={commentary} />
        </View>

        {/* Social choice: stay in the public pool (live head-count) or break off
            into a private room for this match. Hidden once the game's over. */}
        {!finished ? (
          <View style={styles.gutter}>
            <MatchFriendsBar
              playerCount={market?.participants ?? 0}
              onPrivate={() => router.push("/friends")}
              hapticsEnabled={hapticsOn}
            />
          </View>
        ) : null}

        {/* On-chain wallet + real-bet receipt (only when chain mode is live). */}
        {chain.configured ? (
          <View style={styles.gutter}>
            <ChainBetPanel chain={chain} cb={cb} />
          </View>
        ) : null}

        {/* ── live stage: at full time the game is over → end state. Otherwise the
            market takes priority; the reveal drops below if a bet is pending, and
            the idle radar fills the gap between moments. ── */}
        {finished ? (
          <View style={styles.gutter}>
            <FullTimeCard
              home={teams.home}
              away={teams.away}
              scoreHome={game?.scoreHome ?? 0}
              scoreAway={game?.scoreAway ?? 0}
              onExit={() => router.back()}
            />
          </View>
        ) : halftime ? (
          <View style={styles.gutter}>
            <WaitingCard
              title="Half time"
              body="Grab a breather — second-half markets are moments away."
            />
          </View>
        ) : market ? (
          <View style={styles.gutter}>
            {chainPreparing ? (
              <Banner
                tone="info"
                message="On-chain market preparing — bet buttons unlock in a moment."
              />
            ) : null}
            <MarketCard
              market={displayMarket ?? market}
              now={now}
              stake={store.stake}
              onStakeChange={store.setStake}
              pending={chainMode ? chainPending : pending}
              balance={bal.balanceInUnits}
              formatStake={stakeFormat}
              onBet={onBet}
              hapticsEnabled={hapticsOn}
              betDisabled={chainPreparing || chainLocked || marketClosing}
            />
          </View>
        ) : !activeReveal ? (
          <View style={styles.gutter}>
            <WaitingCard />
          </View>
        ) : null}

        {activeReveal ? (
          <View style={styles.gutter}>
            <RevealCard
              reveal={activeReveal}
              onAcknowledge={() => onReveal(activeReveal.marketId, activeReveal.won)}
              hapticsEnabled={hapticsOn}
            />
          </View>
        ) : null}

        <View style={styles.gutter}>
          <ClosedMarketsList markets={historicMarkets} catchingUp={catchingUp} />
        </View>

        {/* recent results rail — YOUR bets on this match only */}
        <View style={styles.gutter}>
          <ResultsRail
            bets={
              game ? store.bets.filter((b) => b.gameId === game.gameId) : []
            }
          />
        </View>
      </View>

      {/* overlays */}
      <Toast
        message={toast}
        tone={
          toast?.startsWith("Bet ")
            ? "success"
            : toast === "Not enough balance"
              ? "danger"
              : "info"
        }
        onHide={clearToast}
      />
      <Confetti trigger={confettiTrigger} count={36} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, marginTop: spacing.xs },
  gutter: { paddingHorizontal: spacing.lg },
  // Header right slot — the mode chip + animated balance pill, mirroring the old
  // MatchHeader's right block so the count-up + label read identically.
  headerRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  balance: { alignItems: "flex-end", minWidth: 64 },
  balValue: { ...type.mono, fontSize: 17, color: colors.textPrimary },
  balLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    marginTop: 1,
  },
});

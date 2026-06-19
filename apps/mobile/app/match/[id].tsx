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
import { spacing } from "@/theme";
import { Banner, Confetti, Screen, Toast } from "@/ui";
import { useStore } from "@/state/store";
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
  CommentaryTicker,
  FullTimeCard,
  LiveScoreboard,
  MarketCard,
  MatchFriendsBar,
  MatchHeader,
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
    market,
    pending,
    reveals,
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
  const momentumTeam = finished ? undefined : market?.team; // who's pressing right now

  // On-chain layer. When the feed runs in chain mode, the current market carries
  // `onChain` and the embedded wallet places REAL bets on it (cb.active). Otherwise
  // this stays inert and the play-money flow below runs unchanged.
  const chain = useChain();
  const cb = useChainBet(market, chain);
  const chainMode = cb.active;
  // Money is real SOL in chain mode, play $ in sandbox — for the header balance
  // AND the stake chips / over-balance check (so nothing reads "$" while you bet SOL).
  const bal = useDisplayBalance();
  const stakeFormat = makeStakeFormatter(bal.chain);
  // Once a real bet is placed (or is mid-flight) on this market, lock the card so
  // the program's one-bet-per-market rule isn't tripped by a double tap.
  const chainLocked =
    chainMode &&
    (cb.placing || cb.bet?.offChainMarketId === market?.id);
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
      <MatchHeader
        balance={bal.amount}
        format={bal.format}
        live={effectiveMode === "live"}
        onBack={() => router.back()}
        onHelp={() => router.push("/how-it-works")}
      />

      <View style={styles.body}>
        <View style={styles.gutter}>
          <LiveScoreboard
            home={teams.home}
            away={teams.away}
            scoreHome={game?.scoreHome ?? 0}
            scoreAway={game?.scoreAway ?? 0}
            clock={finished ? "FT" : (game?.clock ?? "0'")}
            momentum={momentumTeam}
            live={!finished}
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
        ) : market ? (
          <View style={styles.gutter}>
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
            />
          </View>
        ) : reveals.length === 0 ? (
          <View style={styles.gutter}>
            <WaitingCard />
          </View>
        ) : null}

        {reveals.map((reveal) => (
          <View key={reveal.marketId} style={styles.gutter}>
            <RevealCard
              reveal={reveal}
              onAcknowledge={() => onReveal(reveal.marketId, reveal.won)}
              hapticsEnabled={hapticsOn}
            />
          </View>
        ))}

        {/* recent results rail — THIS match only (scoped by gameId) */}
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
});

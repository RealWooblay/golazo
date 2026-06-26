// OWNED BY: match agent (the live "bet the play" loop).
//
// The hero of the app: a cinematic live header + scoreboard, a live commentary
// ticker, the market card (countdown ring, animated odds, pool split-bar, juicy
// YES/NO, stake chips, bet confirmation), the weighty tap-to-reveal with
// WIN confetti / MISS shake / VOID refund, a recent-results rail, and a "waiting
// for the next moment" state that still feels alive. All engine wiring lives in
// src/features/match/useGameFeed.ts; visuals are composed from '@/ui' + the
// match components.
import React, { useEffect, useMemo, useState } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { colors, spacing, type } from "@/theme";
import { AnimatedNumber, Banner, Button, Chip, Confetti, MonoStat, Overline, Screen, Text, Toast } from "@/ui";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { useStore } from "@/state/store";
import type { ClosedMarketVM } from "@/state/types";
import { bettingClosesAt, bettingSafetyBufferMs, RAKE } from "@/lib/config";
import { multiple } from "@/lib/format";
import { useTick } from "@/hooks";
import { useGameFeed } from "@/features/match/useGameFeed";
import { useChain } from "@/features/chain/useChain";
import { useChainBets } from "@/features/match/useChainBets";
import {
  useDisplayBalance,
  makeStakeFormatter,
  SOL_PER_UNIT,
} from "@/features/chain/useDisplayBalance";
import { resolveTeams } from "@/features/match/teams";
import { sideDisplayLabel } from "@/features/match/marketMeta";
import {
  ChainBetPanel,
  ClosedMarketsList,
  MarketCard,
  RevealCard,
  WaitingFidget,
} from "@/features/match/components";
import { PitchHero } from "@/features/match/components/PitchHero";
import { StakeBar } from "@/features/match/components/StakeBar";
import { LockedStrip } from "@/features/match/components/LockedStrip";

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const leaveMatch = React.useCallback(() => {
    router.replace("/(tabs)");
  }, [router]);
  const store = useStore();
  const hapticsOn = store.session.hapticsOn;

  const {
    game,
    commentary,
    commentaryLog,
    momentum,
    momentumLean,
    markets,
    market,
    pendingByMarket,
    reveals,
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
  useFocusEffect(
    React.useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        leaveMatch();
        return true;
      });
      return () => sub.remove();
    }, [leaveMatch]),
  );
  // Tick through BOTH open and locked: the locked card shows the resolve-window
  // countdown, so the clock must keep running after lock or it freezes on a
  // static number (the "countdown not counting down" bug).
  const ticking =
    focused &&
    markets.some((m) => m.phase === "open" || m.phase === "locked");
  const now = useTick(80, ticking);

  // Team identity (crests + colors) — from the lobby fixture we came through, or
  // synthesised from the live game state.
  const teams = useMemo(() => resolveTeams(id, game), [id, game]);
  // The sticky custom stake — persists for the whole match (see StakeBar).
  const [customStake, setCustomStake] = useState(0);
  // Open markets are the hero, ordered closing-soonest so the most urgent sits on top;
  // locked markets (can't bet) drop to thin strips below.
  const openMarkets = useMemo(
    () =>
      markets
        .filter((m) => m.phase === "open")
        .sort(
          (a, b) =>
            bettingClosesAt(a.lockAt, a.windowMs) - bettingClosesAt(b.lockAt, b.windowMs),
        ),
    [markets],
  );
  const lockedMarkets = useMemo(
    () => markets.filter((m) => m.phase === "locked"),
    [markets],
  );
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
  // The hero already shows FT + the score, so the old standalone full-time scoreboard is
  // a redundant second scoreline — we drop it and fold the verdict into the hero note.
  const ftVerdict =
    (game?.scoreHome ?? 0) === (game?.scoreAway ?? 0)
      ? "Full time · draw"
      : `${((game?.scoreHome ?? 0) > (game?.scoreAway ?? 0) ? teams.home : teams.away).abbr} win · full time`;

  // On-chain layer. Each live market can carry its own on-chain twin; bets and
  // claims are tracked per market so new cards never hide old receipts.
  const chain = useChain();
  const chainMode =
    chain.ready && store.mode === "live" && store.session.moneyMode === "real";
  const chainBets = useChainBets(chain, store.stake, chainMode, markets);
  // Money is real SOL in chain mode, play $ in sandbox — for the header balance
  // AND the stake chips / over-balance check (so nothing reads "$" while you bet SOL).
  const bal = useDisplayBalance();
  const stakeFormat = makeStakeFormatter(bal.points);
  const resolvedMarketOutcomes = useMemo(
    () =>
      new Map(
        historicMarkets.map((m) => [
          m.marketId,
          m.outcome,
        ] as const),
      ),
    [historicMarkets],
  );
  useEffect(() => {
    if (chainMode) chainBets.markResolved(resolvedMarketOutcomes);
  }, [chainMode, chainBets.markResolved, resolvedMarketOutcomes]);

  // Persisted bets for THIS game (survive leaving + returning to the match — they
  // live in the store, not the ephemeral feed state that resets on remount).
  const gameBets = useMemo(
    () => (game ? store.bets.filter((b) => b.gameId === game.gameId) : []),
    [store.bets, game],
  );

  // The settled-markets list = live session rows MERGED with persisted bets, so a bet
  // placed/settled on a previous visit reappears on return. Live rows win on conflict
  // (richer pool/odds/kind/voidReason); a persistence-only row still renders a clean
  // YES/NO/VOID badge + your side + net via the question.
  const sessionMarkets = useMemo<ClosedMarketVM[]>(() => {
    const byId = new Map<string, ClosedMarketVM>();
    for (const b of gameBets) {
      byId.set(b.marketId, {
        marketId: b.marketId,
        question: b.question ?? b.label,
        outcome: b.outcome,
        oddsYes: 1,
        oddsNo: 1,
        poolYes: 0,
        poolNo: 0,
        poolTotal: 0,
        yesShare: 50,
        settledAt: b.at,
        userSide: b.side,
        userStake: b.stake,
        userDelta: b.delta,
        revealedAt: b.at,
      });
    }
    for (const m of historicMarkets) byId.set(m.marketId, { ...byId.get(m.marketId), ...m });
    return Array.from(byId.values()).sort(
      (a, b) => (b.revealedAt ?? b.settledAt) - (a.revealedAt ?? a.settledAt),
    );
  }, [gameBets, historicMarkets]);

  // ── Win confetti: fire when a reveal is acknowledged as a win ───────────────
  const [confettiTrigger, setConfettiTrigger] = useState(0);

  const onBet = async (m: typeof markets[number], side: "YES" | "NO") => {
    // Chain mode → REAL on-chain place_bet with the embedded wallet. Play mode →
    // the local play-money engine. The market card's bet UI is identical; only the
    // money rail differs.
    if (chainMode && m.onChain) {
      await chainBets.placeBet(m, side, store.stake);
    } else {
      placeBet(side, store.stake, m.id);
    }
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
        onBack={leaveMatch}
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
          <PitchHero
            home={teams.home}
            away={teams.away}
            scoreHome={game?.scoreHome ?? 0}
            scoreAway={game?.scoreAway ?? 0}
            clock={game?.clock ?? "0'"}
            status={finished ? "final" : halftime ? "halftime" : "live"}
            momentumLean={finished || halftime ? null : momentumLean}
            note={finished ? ftVerdict : commentary}
          />
        </View>

        {fallbackNotice ? (
          <View style={styles.gutter}>
            <Banner tone="info" message={fallbackNotice} />
          </View>
        ) : null}

        {/* On-chain wallet + real-bet receipt (only when chain mode is live). */}
        {chain.configured ? (
          <View style={styles.gutter}>
            <ChainBetPanel
              bets={chainBets.bets}
              error={chainBets.error}
              onClaim={chainBets.claim}
            />
          </View>
        ) : null}

        {/* ── live stage: at full time the game is over → end state. Otherwise the
            market takes priority; the reveal drops below if a bet is pending, and
            the idle radar fills the gap between moments. ── */}
        {finished ? (
          <View style={styles.gutter}>
            <Button flat fullWidth label="Back to the lobby" onPress={leaveMatch} />
          </View>
        ) : halftime ? (
          <>
            <View style={styles.gutter}>
              <StakeBar
                stake={store.stake}
                onPick={store.setStake}
                customStake={customStake}
                onCustom={setCustomStake}
                balance={bal.balanceInUnits}
                format={stakeFormat}
                hapticsEnabled={hapticsOn}
              />
            </View>
            <View style={styles.gutter}>
              <WaitingFidget hapticsEnabled={hapticsOn} />
            </View>
          </>
        ) : (
          <>
            <View style={styles.gutter}>
              <StakeBar
                stake={store.stake}
                onPick={store.setStake}
                customStake={customStake}
                onCustom={setCustomStake}
                balance={bal.balanceInUnits}
                format={stakeFormat}
                hapticsEnabled={hapticsOn}
              />
            </View>

            {openMarkets.map((m) => {
              const liveOdds = chainBets.getLiveOdds(m.id);
              const displayMarket =
                chainMode && liveOdds
                  ? {
                      ...m,
                      oddsYes: liveOdds.oddsYes,
                      oddsNo: liveOdds.oddsNo,
                      pool: liveOdds.poolSol / SOL_PER_UNIT,
                      yesShare: liveOdds.yesShare,
                    }
                  : m;
              const chainBet = chainBets.getBet(m.id);
              const chainPreparing =
                chainMode && !!m.onChain && !chainBets.isTwinReady(m.id) && !chainBet;
              const chainLocked = chainMode && (chainBets.placing || !!chainBet);
              const marketClosing =
                m.phase === "open" && now >= bettingClosesAt(m.lockAt, m.windowMs);
              const cardPending =
                chainMode && chainBet
                  ? {
                      marketId: m.id,
                      side: chainBet.side,
                      stake: store.stake,
                      estimatedMult: chainBet.estimatedMultiple,
                    }
                  : (pendingByMarket[m.id] ?? null);
              return (
                <View key={m.id} style={styles.gutter}>
                  {chainPreparing ? (
                    <Banner
                      tone="info"
                      message="On-chain market preparing — bet unlocks in a moment."
                    />
                  ) : null}
                  <MarketCard
                    market={displayMarket}
                    now={now}
                    stake={store.stake}
                    pending={cardPending}
                    balance={bal.balanceInUnits}
                    formatStake={stakeFormat}
                    onBet={(side) => void onBet(m, side)}
                    betDisabled={
                      (chainMode && (!m.onChain || chainPreparing || chainLocked)) ||
                      marketClosing
                    }
                    breakActive={!!game?.breakPaused}
                  />
                </View>
              );
            })}

            {lockedMarkets.map((m) => {
              const chainBet = chainBets.getBet(m.id);
              const pendingBet = pendingByMarket[m.id];
              const betSide = chainBet?.side ?? pendingBet?.side;
              const betStakeStr = chainBet
                ? stakeFormat(chainBet.stakeSol / SOL_PER_UNIT)
                : pendingBet
                  ? stakeFormat(pendingBet.stake)
                  : undefined;
              // Final (locked) multiple from the settled pool — show what you'll actually
              // receive if your side wins, so the locked card matches the payout.
              let betLabel: string | undefined;
              if (betSide && betStakeStr) {
                const yesPool = m.pool * (m.yesShare / 100);
                const sidePool = betSide === "YES" ? yesPool : m.pool - yesPool;
                const mult = sidePool > 0 ? (m.pool * (1 - RAKE)) / sidePool : 0;
                const pick = sideDisplayLabel(betSide, m.kind, m.question);
                betLabel = `You: ${pick} · ${betStakeStr}${mult > 0 ? ` → ${multiple(mult)}` : ""}`;
              }
              return (
                <View key={m.id} style={styles.gutter}>
                  <LockedStrip
                    market={m}
                    now={now}
                    betLabel={betLabel}
                    breakActive={!!game?.breakPaused}
                    breakLabel={game?.breakLabel}
                  />
                </View>
              );
            })}

            {openMarkets.length === 0 &&
            lockedMarkets.length === 0 &&
            reveals.length === 0 ? (
              <View style={styles.gutter}>
                <WaitingFidget hapticsEnabled={hapticsOn} />
              </View>
            ) : null}
          </>
        )}

        {reveals.map((reveal) => (
          <View key={reveal.marketId} style={styles.gutter}>
            <RevealCard
              reveal={reveal}
              onAcknowledge={() => onReveal(reveal.marketId, reveal.won)}
              hapticsEnabled={hapticsOn}
            />
          </View>
        ))}

        {(() => {
          const sb = gameBets;
          if (sb.length === 0) return null;
          const net = sb.reduce((s, b) => s + (b.delta ?? 0), 0);
          const w = sb.filter((b) => b.won).length;
          const l = sb.filter((b) => !b.won && b.outcome !== "VOID").length;
          return (
            <View style={styles.gutter}>
              <View style={styles.pnl}>
                <MonoStat size={28} color={net >= 0 ? colors.yes : colors.no}>
                  {(net >= 0 ? "+" : "−") + stakeFormat(Math.abs(net))}
                </MonoStat>
                <Overline size={11}>{w + "W · " + l + "L"}</Overline>
              </View>
            </View>
          );
        })()}

        <View style={styles.gutter}>
          <ClosedMarketsList
            markets={sessionMarkets}
            userBets={gameBets}
            catchingUp={catchingUp}
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
  pnl: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
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

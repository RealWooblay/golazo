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
import type { BetRow, ClosedMarketVM, RevealVM } from "@/state/types";
import { bettingClosesAt, bettingSafetyBufferMs, RAKE } from "@/lib/config";
import { multiple } from "@/lib/format";
import { useTick } from "@/hooks";
import { useGameFeed } from "@/features/match/useGameFeed";
import { useChain } from "@/features/chain/useChain";
import { useChainBets } from "@/features/match/useChainBets";
import {
  useDisplayBalance,
  makeStakeFormatter,
} from "@/features/chain/useDisplayBalance";
import { resolveTeams } from "@/features/match/teams";
import { sideDisplayLabel } from "@/features/match/marketMeta";
import {
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
    showToast,
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
  const realMoneyLive =
    store.mode === "live" && store.session.moneyMode === "real";
  const chainMode = chain.ready && realMoneyLive;
  const chainBets = useChainBets(chain, store.stake, realMoneyLive, markets);
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
  //
  // DEMO EXCEPTION: the offline sim reuses ONE gameId ("sim-arg-fra") and auto-resets, so
  // store.bets piles up cross-run bets — many VOID'd when a prior run reset with open markets.
  // Seeding those would fill the demo's history with stale VOID rows. The demo never "returns"
  // to a persistent match, so just show THIS run's settled markets (they already carry the
  // user's side/stake/delta). Persistence stays on for live matches, which have unique gameIds.
  const sessionMarkets = useMemo<ClosedMarketVM[]>(() => {
    if (effectiveMode === "offline") return historicMarkets;
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
    // On-chain (real USX) bets render IN this session list too — same rows, with a tx link and
    // tap-to-claim — instead of a separate panel above. Win amount uses the bet-time estimate
    // (the exact on-chain payout isn't on the bet VM yet); void = refund (0), loss = -stake.
    for (const cb of chainBets.bets) {
      const r = cb.resolvedOutcome;
      const stake = cb.stakeUsd;
      const won = cb.won === true;
      const delta = !r
        ? undefined
        : r === "VOID"
          ? 0
          : won
            ? (cb.realizedUsd != null ? cb.realizedUsd - stake : stake * (cb.estimatedMultiple - 1))
            : -stake;
      byId.set(cb.offChainMarketId, {
        ...byId.get(cb.offChainMarketId),
        marketId: cb.offChainMarketId,
        question: cb.question,
        outcome: (r ?? "VOID") as ClosedMarketVM["outcome"],
        oddsYes: 1,
        oddsNo: 1,
        poolYes: 0,
        poolNo: 0,
        poolTotal: 0,
        yesShare: 50,
        settledAt: Date.now(),
        userSide: cb.side,
        userStake: stake,
        userDelta: delta,
        voidReason: r === "VOID" ? "Full refund" : undefined,
        txUrl: cb.betUrl,
        claimUrl: cb.claimUrl,
        claimable: !!cb.claimable && !cb.claimSignature,
        claiming: !!cb.claiming,
        pending: !r,
        userLiveMult: !r ? cb.estimatedMultiple : undefined,
        revealedAt: Date.now(),
      });
    }
    return Array.from(byId.values()).sort(
      (a, b) => (b.revealedAt ?? b.settledAt) - (a.revealedAt ?? a.settledAt),
    );
  }, [effectiveMode, gameBets, historicMarkets, chainBets.bets]);

  const chainReveals = useMemo<RevealVM[]>(() => {
    if (!chainMode) return [];
    const kindByMarket = new Map(
      historicMarkets.map((m) => [m.marketId, m.kind] as const),
    );
    return chainBets.bets
      .filter(
        (cb) =>
          cb.resolvedOutcome &&
          (cb.claiming || (cb.claimable && !cb.claimSignature)),
      )
      .map((cb) => {
        const outcome = cb.resolvedOutcome!;
        const won = outcome !== "VOID" && cb.side === outcome;
        const kind = kindByMarket.get(cb.offChainMarketId);
        const payout =
          outcome === "VOID"
            ? cb.stakeUsd
            : won
              ? (cb.realizedUsd ?? cb.stakeUsd * cb.estimatedMultiple)
              : 0;
        return {
          marketId: cb.offChainMarketId,
          question: cb.question,
          ...(kind ? { kind } : {}),
          team: undefined,
          side: cb.side,
          stake: cb.stakeUsd,
          payoutMult: cb.stakeUsd > 0 ? payout / cb.stakeUsd : 0,
          outcome,
          won,
          payout,
          claiming: cb.claiming,
          claimed: !!cb.claimSignature,
          claimUrl: cb.claimUrl,
        };
      });
  }, [chainMode, chainBets.bets, historicMarkets]);

  useEffect(() => {
    if (!chainMode) return;
    for (const cb of chainBets.bets) {
      const outcome = cb.resolvedOutcome;
      if (!outcome) continue;
      const won = outcome !== "VOID" && cb.side === outcome;
      if ((won || outcome === "VOID") && !cb.claimSignature) continue;

      const id = `bet_chain_${cb.betSignature}`;
      if (store.bets.some((b) => b.id === id)) continue;

      const stake = cb.stakeUsd;
      const payout =
        outcome === "VOID"
          ? stake
          : won
            ? (cb.realizedUsd ?? stake * cb.estimatedMultiple)
            : 0;
      const row: BetRow = {
        kind: "bet",
        rail: "usx",
        id,
        marketId: cb.offChainMarketId,
        gameId: game?.gameId,
        label: sideDisplayLabel(cb.side, undefined, cb.question),
        question: cb.question,
        side: cb.side,
        stake,
        payoutMult: stake > 0 ? payout / stake : 0,
        outcome,
        won,
        delta: outcome === "VOID" ? 0 : won ? payout - stake : -stake,
        at: Date.now(),
      };
      store.addBet(row);
    }
  }, [chainMode, chainBets.bets, store.bets, store.addBet, game?.gameId]);

  // ── Win confetti: fire when a reveal is acknowledged as a win ───────────────
  const [confettiTrigger, setConfettiTrigger] = useState(0);

  const onBet = async (m: typeof markets[number], side: "YES" | "NO") => {
    if (realMoneyLive) {
      if (!chain.ready) {
        showToast("Wallet still loading — try again in a moment.");
        return;
      }
      if (!m.onChain) return;
      await chainBets.placeBet(m, side, store.stake);
      return;
    }
    placeBet(side, store.stake, m.id);
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
            note={finished ? ftVerdict : halftime ? undefined : commentary}
          />
        </View>

        {fallbackNotice ? (
          <View style={styles.gutter}>
            <Banner tone="info" message={fallbackNotice} />
          </View>
        ) : null}

        {/* On-chain bet errors surface here; the bet receipts themselves now live IN the
            session list below (same rows, with a tx link + tap-to-claim) — no panel above. */}
        {chain.configured && chainBets.error ? (
          <View style={styles.gutter}>
            <Banner tone="danger" message={chainBets.error} />
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
              const liveOdds = chainBets.getLiveOdds(m.id, store.stake);
              const displayMarket =
                chainMode && liveOdds
                  ? {
                      ...m,
                      oddsYes: liveOdds.oddsYes,
                      oddsNo: liveOdds.oddsNo,
                      pool: liveOdds.poolUsd,
                      yesShare: liveOdds.yesShare,
                    }
                  : m;
              const chainBet = chainBets.getBet(m.id);
              const heldMult =
                chainBet &&
                (chainBets.getHeldMultiple(m.id, chainBet.side, chainBet.stakeUsd) ??
                  chainBet.estimatedMultiple);
              const chainPreparing =
                chainMode && !!m.onChain && !chainBets.isTwinReady(m.id) && !chainBet;
              const chainLocked =
                chainMode && (chainBets.placingMarketId === m.id || !!chainBet);
              const marketClosing =
                m.phase === "open" && now >= bettingClosesAt(m.lockAt, m.windowMs);
              const cardPending =
                realMoneyLive && chainBet
                  ? {
                      marketId: m.id,
                      side: chainBet.side,
                      stake: chainBet.stakeUsd,
                      estimatedMult: heldMult ?? chainBet.estimatedMultiple,
                    }
                  : !realMoneyLive
                    ? (pendingByMarket[m.id] ?? null)
                    : null;
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
                    heldMultiple={heldMult ?? undefined}
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
              const pendingBet = realMoneyLive ? undefined : pendingByMarket[m.id];
              const betSide = chainBet?.side ?? pendingBet?.side;
              const betStakeStr = chainBet
                ? stakeFormat(chainBet.stakeUsd)
                : pendingBet
                  ? stakeFormat(pendingBet.stake)
                  : undefined;
              let betLabel: string | undefined;
              if (betSide && betStakeStr) {
                const pick = sideDisplayLabel(betSide, m.kind, m.question);
                if (chainBet) {
                  const mult =
                    chainBets.getHeldMultiple(m.id, chainBet.side, chainBet.stakeUsd) ??
                    chainBet.estimatedMultiple;
                  const winUsd = mult > 0 ? chainBet.stakeUsd * mult : 0;
                  betLabel =
                    winUsd > 0
                      ? `You: ${pick} · ${betStakeStr} → win ${stakeFormat(winUsd)} (${multiple(mult)})`
                      : `You: ${pick} · ${betStakeStr}`;
                } else {
                  const yesPool = m.pool * (m.yesShare / 100);
                  const sidePool = betSide === "YES" ? yesPool : m.pool - yesPool;
                  const mult = sidePool > 0 ? (m.pool * (1 - RAKE)) / sidePool : 0;
                  betLabel = `You: ${pick} · ${betStakeStr}${mult > 0 ? ` → ${multiple(mult)}` : ""}`;
                }
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

        {chainReveals.map((reveal) => (
          <View key={`chain_${reveal.marketId}`} style={styles.gutter}>
            <RevealCard
              reveal={reveal}
              onAcknowledge={() => {
                if (reveal.won) setConfettiTrigger((n) => n + 1);
                void chainBets.claim(reveal.marketId);
              }}
              hapticsEnabled={hapticsOn}
            />
          </View>
        ))}

        {(() => {
          // DEMO: scope the P&L to THIS run (markets settled this session) so cross-run bets in
          // the reused "sim-arg-fra" ledger don't inflate it — matches the session list above.
          // LIVE: the full persisted set for this match.
          const sb =
            effectiveMode === "offline"
              ? (() => {
                  const runIds = new Set(historicMarkets.map((m) => m.marketId));
                  return gameBets.filter((b) => runIds.has(b.marketId));
                })()
              : gameBets;
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
            onClaim={chainBets.claim}
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

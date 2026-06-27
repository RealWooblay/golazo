#!/usr/bin/env bash
# Full parimutuel lifecycle test for one market, with state printed at each step.
# Alice always bets YES, Bob always bets NO. Halts on the first error (set -e).
#
#   bash scripts/run-test.sh <seed> <aliceUsd> <bobUsd> <yes|no>
#   e.g. bash scripts/run-test.sh 2 0.2 0.1 yes
set -euo pipefail
export NODE_OPTIONS=--no-deprecation

SEED="${1:?seed}"; ALICE="${2:?alice usd}"; BOB="${3:?bob usd}"; OUT="${4:?yes|no}"
M="node scripts/mkt.mjs"
hr() { echo; echo "════════ $* ════════"; }

hr "BASELINE"
$M balances
$M market "$SEED"

hr "CREATE market $SEED"
$M init "$SEED"
$M market "$SEED"

hr "ALICE bets YES \$$ALICE"
$M bet "$SEED" alice yes "$ALICE"
$M balances && $M market "$SEED"

hr "BOB bets NO \$$BOB"
$M bet "$SEED" bob no "$BOB"
$M balances && $M market "$SEED"

if [ "$OUT" = "void" ]; then
  hr "LOCK + VOID (everyone refunds, no rake)"
  $M lock "$SEED"
  $M void "$SEED"
else
  hr "LOCK + RESOLVE $OUT"
  $M lock "$SEED"
  $M resolve "$SEED" "$OUT"
fi
$M market "$SEED"

hr "ALICE claims"
$M claim "$SEED" alice
$M balances && $M market "$SEED" && $M bet-acct "$SEED" alice

hr "BOB claims"
$M claim "$SEED" bob
$M balances && $M bet-acct "$SEED" bob

if [ "$OUT" = "void" ]; then
  hr "NO SWEEP — void markets take no rake"
  $M balances && $M market "$SEED"
else
  hr "SWEEP rake"
  $M sweep "$SEED"
  $M balances && $M market "$SEED"
fi

hr "DONE — market $SEED fully settled"

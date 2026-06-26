#!/usr/bin/env bash
# Multi-winner split test: Alice + Carol bet YES, Bob bets NO, resolve YES.
# Both YES winners split the net pool proportionally to their stake.
# Requires keys/carol.json funded with SOL + USX first.
#
#   bash scripts/run-test-3way.sh <seed> <aliceYesUsd> <carolYesUsd> <bobNoUsd>
#   e.g. bash scripts/run-test-3way.sh 5 0.1 0.05 0.1
set -euo pipefail
export NODE_OPTIONS=--no-deprecation
SEED="${1:?seed}"; A="${2:?alice yes}"; C="${3:?carol yes}"; B="${4:?bob no}"
M="node scripts/mkt.mjs"
hr() { echo; echo "════════ $* ════════"; }

hr "BASELINE"; $M balances; $M market "$SEED"
hr "CREATE market $SEED"; $M init "$SEED"; $M market "$SEED"
hr "ALICE YES \$$A"; $M bet "$SEED" alice yes "$A"; $M market "$SEED"
hr "CAROL YES \$$C"; $M bet "$SEED" carol yes "$C"; $M market "$SEED"
hr "BOB NO \$$B"; $M bet "$SEED" bob no "$B"; $M balances && $M market "$SEED"
hr "LOCK + RESOLVE YES"; $M lock "$SEED"; $M resolve "$SEED" yes; $M market "$SEED"
hr "ALICE claims (winner)"; $M claim "$SEED" alice; $M balances && $M market "$SEED"
hr "CAROL claims (winner)"; $M claim "$SEED" carol; $M balances && $M market "$SEED"
hr "BOB claims (loser)"; $M claim "$SEED" bob; $M balances
hr "SWEEP rake"; $M sweep "$SEED"; $M balances && $M market "$SEED"
hr "DONE — multi-winner split settled (any leftover vault USX = rounding dust)"

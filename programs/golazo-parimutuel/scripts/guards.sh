#!/usr/bin/env bash
# Negative-test suite: every forbidden action must be REJECTED by the program.
# Legit setup steps (marked "ok") must succeed; banned steps (marked "no") must
# fail. Banned txs are rejected in preflight simulation, so they cost no fee.
#
#   bash scripts/guards.sh [seed]
export NODE_OPTIONS=--no-deprecation
M="node scripts/mkt.mjs"
S="${1:-6}"
PASS=0; LEAK=0

ok() { local d="$1"; shift; echo; echo "── setup: $d"; if "$@" >/tmp/g.out 2>&1; then echo "   ✓"; else echo "   ✗ SETUP FAILED (unexpected):"; sed 's/^/     /' /tmp/g.out; exit 1; fi; }
no() { local d="$1"; shift; echo; echo "── must block: $d"; if "$@" >/tmp/g.out 2>&1; then echo "   ❌ NOT BLOCKED — allowed!"; sed 's/^/     /' /tmp/g.out; LEAK=$((LEAK+1)); else local e; e=$(grep -oE "Error (Code|Number): [A-Za-z0-9]+|0x[0-9a-f]+|already in use|custom program error" /tmp/g.out | head -1); echo "   ✅ blocked (${e:-rejected})"; PASS=$((PASS+1)); fi; }

echo "########## GUARD SUITE on market seed=$S ##########"

ok "create market $S"                    $M init $S
no "duplicate init (same authority+seed)" $M init $S
no "zero-stake bet"                       $M bet $S alice yes 0
ok "alice bets YES 0.05"                  $M bet $S alice yes 0.05
no "alice bets twice (one per market)"    $M bet $S alice yes 0.05
no "claim before resolution"              $M claim $S alice
no "sweep before resolution"              $M sweep $S
ok "bob bets NO 0.05"                     $M bet $S bob no 0.05
no "resolve by non-authority (alice)"     $M resolve $S yes alice
no "lock by non-authority (alice)"        $M lock $S alice
no "void by non-authority (alice)"        $M void $S alice
ok "operator locks"                       $M lock $S
no "bet after lock"                       $M bet $S carol yes 0.05
no "lock again (already locked)"          $M lock $S
ok "operator resolves YES"               $M resolve $S yes
no "resolve again (already resolved)"     $M resolve $S no
no "void after resolved"                  $M void $S
ok "alice claims (winner)"               $M claim $S alice
no "alice double-claim (account gone)"    $M claim $S alice
no "sweep by non-treasury (alice)"        $M sweep $S alice
ok "treasury sweeps rake"                $M sweep $S
no "sweep again (already swept)"          $M sweep $S
no "init rake_bps=10000 (>=100%)"         $M init 7 10000

echo
echo "########## RESULT: $PASS forbidden actions blocked, $LEAK leaked ##########"
if [ "$LEAK" -eq 0 ]; then echo "✅ ALL BANNED BEHAVIORS CORRECTLY REJECTED"; else echo "❌ $LEAK LEAK(S) — investigate"; exit 1; fi

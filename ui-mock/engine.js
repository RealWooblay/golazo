/* ============================================================================
   GOLAZO — UI MOCK · match + market ENGINE (points-simulation of the on-chain
   parimutuel program). Pure logic, no DOM. Mirrors the real money mechanics:
     • each market side has a POOL; multiplier = grossPool*(1-RAKE)/sidePool (dynamic)
     • payout to a winner = stake/winningPool * grossPool*(1-RAKE)  (never shorted)
     • lifecycle: OPEN (betting) → LOCKED (awaiting) → SETTLED (won/lost/void)
     • TIMESTAMP ANTI-ARB: an event whose true time lands inside a market's betting
       window is "tainted". A SET-PIECE market → VOID (refund). A TIME-BASED market
       → IGNORE the event and keep its timer running. (Delayed-feed defence.)
   ========================================================================== */
window.GZ = (function () {
  'use strict';

  var RAKE = 0.06, HOME = 'France', AWAY = 'Algeria';
  var BET_TICKS = 1;     // ticks a market takes bets before it locks
  var LIFE_TICKS = 4;    // ticks from open to its NO/void deadline
  var uid = 0;

  // family = the kind of market. set:true => set-piece (void on tainted), else time-based.
  var FAM = {
    threat:    { lane: 'NEXT',        q: 'Who threatens next?',              set: false, sides: [['home', HOME], ['away', AWAY]], seed: [100, 160], expire: 'VOID', wins: function (e) { return ['shot','corner','goal','danger'].indexOf(e.kind) >= 0 ? e.team : null; } },
    nextgoal:  { lane: 'NEXT',        q: 'Who scores next?',                 set: false, sides: [['home', HOME], ['away', AWAY]], seed: [95, 120], expire: 'VOID', wins: function (e) { return e.kind === 'goal' ? e.team : null; } },
    nextcard:  { lane: 'BOOKING',     q: 'Who gets the next booking?',       set: false, sides: [['home', HOME], ['away', AWAY]], seed: [110, 110], expire: 'VOID', wins: function (e) { return e.kind === 'card' ? e.team : null; } },
    shotcorner:{ lane: 'SPELL',       q: 'A shot or corner this spell?',     set: false, sides: [['yes', 'Yes'], ['no', 'No']],   seed: [150, 120], expire: 'no', wins: function (e) { return ['shot','corner','goal'].indexOf(e.kind) >= 0 ? 'yes' : null; } },
    goalwin:   { lane: 'EITHER TEAM', q: 'A goal in the next few minutes?',  set: false, sides: [['yes', 'Yes'], ['no', 'No']],   seed: [90, 180], expire: 'no', wins: function (e) { return e.kind === 'goal' ? 'yes' : null; } },
    overshots: { lane: 'OVER / UNDER',q: '2+ shots in the next few minutes?',set: false, sides: [['yes', 'Yes'], ['no', 'No']],   seed: [160, 110], expire: 'no', wins: function (e) { return ['shot','goal'].indexOf(e.kind) >= 0 ? 'yes' : null; } },
    cornergoal:{ lane: 'SET PIECE',   q: 'Will this corner be scored?',      set: true,  sides: [['yes', 'Yes'], ['no', 'No']],   seed: [70, 210], expire: 'no', wins: function (e) { return e.kind === 'goal' ? 'yes' : null; } },
    penalty:   { lane: 'SET PIECE',   q: 'Penalty — will it be scored?',     set: true,  sides: [['yes', 'Yes'], ['no', 'No']],   seed: [185, 72], expire: 'no', wins: function (e) { return e.kind === 'goal' ? 'yes' : null; } },
  };
  var FAM_KEYS = Object.keys(FAM);

  var state = {
    mode: 'points',          // 'points' | 'real'
    points: 1284, sol: 0.84,
    clock: 67, sh: 1, sa: 0, tick: 0,
    markets: [],            // open + locked board markets
    results: [],            // recently settled (results rail) — newest first, capped
    bets: [],               // every bet placed
    feed: [],               // event ticker (newest first)
    room: 'Sunday Crew',
  };

  /* ---- money helpers (points and SOL share the same parimutuel math) -------- */
  function bal() { return state.mode === 'points' ? state.points : state.sol; }
  function addBal(v) { if (state.mode === 'points') state.points += v; else state.sol = round(state.sol + v, 4); }
  function unit() { return state.mode === 'points' ? '' : ' SOL'; }
  function fmt(v) { return state.mode === 'points' ? Math.round(v).toLocaleString() : round(v, 3).toString(); }

  function gross(m) { return m.sides.reduce(function (a, s) { return a + s.pool; }, 0); }
  function mult(m, side) { return (gross(m) * (1 - RAKE)) / side.pool; }
  function sideOf(m, k) { return m.sides.filter(function (s) { return s.k === k; })[0]; }

  /* ---- spawn markets ------------------------------------------------------- */
  function spawn(famKey) {
    if (!famKey) {
      var have = state.markets.map(function (m) { return m.fam; });
      var avail = FAM_KEYS.filter(function (k) { return have.indexOf(k) < 0 && k !== 'cornergoal' && k !== 'penalty'; });
      famKey = avail.length ? avail[(Math.random() * avail.length) | 0] : FAM_KEYS[(Math.random() * 6) | 0];
    }
    var f = FAM[famKey];
    var unitScale = state.mode === 'real' ? 0.02 : 1; // pools roughly track stake size
    return {
      id: ++uid, fam: famKey, lane: f.lane, q: f.q, set: f.set,
      sides: f.sides.map(function (s, i) { return { k: s[0], label: s[1], pool: f.seed[i] * unitScale }; }),
      status: 'open', openTick: state.tick, lockTick: state.tick + BET_TICKS, deadTick: state.tick + LIFE_TICKS,
      bet: null, result: null, note: null,
    };
  }
  function refill() { while (state.markets.length < 4) state.markets.push(spawn()); }

  /* ---- betting ------------------------------------------------------------- */
  function placeBet(mId, sideK, stake) {
    var m = state.markets.filter(function (x) { return x.id === Number(mId); })[0];
    if (!m || m.status !== 'open' || m.bet) return false;
    if (bal() < stake) return false;
    var side = sideOf(m, sideK);
    addBal(-stake);
    side.pool += stake;
    m.bet = { sideK: sideK, label: side.label, stake: stake };
    state.bets.unshift({ id: ++uid, mId: m.id, q: m.q, side: side.label, sideK: sideK, stake: stake, mode: state.mode, status: 'open', payout: 0, match: 'FRA v ALG', room: null });
    return true;
  }
  // current projected payout for a position, at live pools
  function projected(m) { var s = sideOf(m, m.bet.sideK); return m.bet.stake * mult(m, s); }

  /* ---- the simulator ------------------------------------------------------- */
  function mkEvent(kind, team) {
    if (kind === 'goal') { if (team === 'home') state.sh++; else state.sa++; }
    return { kind: kind, team: team, clock: state.clock, delayed: false,
      text: kind === 'clear' ? (state.clock + "' Cleared — danger over") : (state.clock + "' " + ({ shot: 'Shot', corner: 'Corner', goal: 'GOAL', card: 'Booking' })[kind] + ' — ' + (team === 'home' ? HOME : AWAY)) };
  }

  // ONE step of the match. Each market walks open → locked(awaiting) → settled across
  // DISTINCT steps: a market that locked this step waits a step before it can resolve, so
  // the locked/awaiting state is always visible.
  function simulate() {
    state.tick++;
    state.clock += 1 + ((Math.random() * 2) | 0);

    // 1) LOCK markets whose betting window has closed (open → locked, stamped lockedAt)
    state.markets.forEach(function (m) { if (m.status === 'open' && state.tick >= m.lockTick) { m.status = 'locked'; m.lockedAt = state.tick; } });

    // 2) bot liquidity into still-open markets so multipliers move (a live book)
    state.markets.forEach(function (m) {
      if (m.status !== 'open') return;
      var s = m.sides[(Math.random() * m.sides.length) | 0];
      s.pool += (state.mode === 'real' ? 0.02 : 1) * (4 + ((Math.random() * 10) | 0));
    });

    // 3) a random feed event
    var r = Math.random();
    var kind = r < 0.34 ? 'shot' : r < 0.5 ? 'corner' : r < 0.64 ? 'goal' : r < 0.76 ? 'card' : 'clear';
    var ev = mkEvent(kind, Math.random() < 0.6 ? 'away' : 'home');
    pushFeed(ev);

    // 4) resolve markets that were LOCKED in a PRIOR step (betting genuinely closed → clean)
    var settledNow = [];
    state.markets.forEach(function (m) {
      if (m.status !== 'locked' || m.lockedAt >= state.tick) return; // just-locked = still awaiting
      var w = FAM[m.fam].wins(ev);
      if (w) { settle(m, w, null); settledNow.push(m); }
    });

    // 5) locked markets past their deadline with no clean event → NO / void (one-NO-writer)
    state.markets.forEach(function (m) {
      if (m.status === 'locked' && m.lockedAt < state.tick && state.tick >= m.deadTick) {
        settle(m, FAM[m.fam].expire, FAM[m.fam].expire === 'VOID' ? 'no event by the deadline → refund' : null);
        settledNow.push(m);
      }
    });

    sweep();
    return settledNow.filter(function (m) { return m.bet; });
  }

  // DELAYED FEED: an event whose TRUE time was inside a still-open market's betting window,
  // reported late. THE ANTI-ARB: set-piece markets → VOID (refund); time-based markets → the
  // event is IGNORED and their timer keeps running. Targets OPEN markets to demonstrate both.
  function delayedFeed() {
    state.tick++;
    // make sure a set-piece market is on the board so the void is visible
    if (!state.markets.some(function (m) { return m.set && m.status === 'open'; })) {
      state.markets.unshift(spawn(Math.random() < 0.5 ? 'cornergoal' : 'penalty'));
    }
    var ev = { kind: 'goal', team: 'away', clock: state.clock, delayed: true,
      text: state.clock + "' GOAL — " + AWAY + "  (delayed feed · true time was during betting)" };
    pushFeed(ev);
    var settledNow = [];
    state.markets.forEach(function (m) {
      if (m.status !== 'open') return;
      var w = FAM[m.fam].wins(ev);
      if (!w) return;
      if (m.set) { settle(m, 'VOID', 'set piece taken during betting → voided'); settledNow.push(m); }
      else { m.note = 'delayed event ignored · timer continues'; }
    });
    sweep();
    return settledNow.filter(function (m) { return m.bet; });
  }

  function pushFeed(ev) { state.feed.unshift(ev); if (state.feed.length > 5) state.feed.pop(); }
  function sweep() { state.markets = state.markets.filter(function (m) { return m.status !== 'settled'; }); refill(); }

  function settle(m, winK, note) {
    m.status = 'settled'; m.result = winK; m.note = note || m.note;
    var total = gross(m);
    if (m.bet) {
      var bet = state.bets.filter(function (b) { return b.mId === m.id && b.status === 'open'; })[0];
      if (bet) {
        if (winK === 'VOID') { bet.status = 'void'; bet.payout = bet.stake; addBal(bet.stake); }
        else if (bet.sideK === winK) { var wp = sideOf(m, winK).pool; bet.payout = round((bet.stake / wp) * total * (1 - RAKE), state.mode === 'real' ? 4 : 0); bet.status = 'won'; addBal(bet.payout); }
        else { bet.status = 'lost'; bet.payout = 0; }
        m.payoutLabel = bet.status === 'won' ? '+' + fmt(bet.payout) : bet.status === 'void' ? '+' + fmt(bet.stake) : '−' + fmt(bet.stake);
      }
    }
    state.results.unshift(m);
    if (state.results.length > 5) state.results.pop();
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode;
    state.markets = []; state.results = []; state.feed = []; refill();
  }
  function reset() {
    state.points = 1284; state.sol = 0.84; state.clock = 67; state.sh = 1; state.sa = 0; state.tick = 0;
    state.markets = []; state.results = []; state.bets = []; state.feed = []; refill();
  }

  function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }

  reset();
  return {
    state: state, RAKE: RAKE, HOME: HOME, AWAY: AWAY,
    bal: bal, fmt: fmt, unit: unit, mult: mult, sideOf: sideOf, gross: gross, projected: projected,
    placeBet: placeBet, simulate: simulate, delayedFeed: delayedFeed, setMode: setMode, reset: reset,
  };
})();

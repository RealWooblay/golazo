/* ============================================================================
   GOLAZO — UI MOCK · render + interactions. Drives every screen off GZ (engine.js).
   Board shows the full lifecycle in zones: OPEN (betting) → LOCKED (awaiting) → RESULTS.
   ========================================================================== */
(function () {
  'use strict';
  var GZ = window.GZ, S = GZ.state;
  var STAKES = { points: [10, 25, 100], real: [0.01, 0.05, 0.25] };
  var stakeIdx = { points: 1, real: 1 };
  function stake() { return STAKES[S.mode][stakeIdx[S.mode]]; }
  function sym() { return S.mode === 'points' ? '' : ' SOL'; }

  /* ---- navigation ---------------------------------------------------------- */
  function go(name) {
    qa('.screen').forEach(function (s) { s.classList.toggle('is-active', s.dataset.screen === name); });
    var a = q('.screen.is-active'); if (a) a.scrollTop = 0;
    renderAll();
  }

  /* ---- render-all ---------------------------------------------------------- */
  function renderAll() {
    qa('[data-bal]').forEach(function (e) { e.textContent = GZ.fmt(GZ.bal()) + (S.mode === 'real' ? '' : ''); });
    qa('[data-bal-sym]').forEach(function (e) { e.textContent = S.mode === 'points' ? 'pts' : 'SOL'; });
    var pe = q('#wallet-points'); if (pe) pe.textContent = S.points.toLocaleString();
    var se = q('#wallet-sol'); if (se) se.textContent = S.sol.toFixed(2);
    qa('[data-score]').forEach(function (e) { e.textContent = GZ.HOME + ' ' + S.sh + ' – ' + S.sa + ' ' + GZ.AWAY; });
    qa('[data-clock]').forEach(function (e) { e.textContent = S.clock + "'"; });
    renderMode(); renderStake(); renderTicker(); renderBoard(); renderActivity(); renderFriends();
  }

  function renderMode() {
    qa('[data-mode]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.mode === S.mode); });
    qa('.mode-flag').forEach(function (f) { f.textContent = S.mode === 'points' ? 'PLAY · points' : 'REAL · SOL on-chain'; f.className = 'mode-flag' + (S.mode === 'real' ? ' mode-flag--real' : ''); });
  }
  function renderStake() {
    var host = q('#chips'); if (!host) return;
    host.innerHTML = STAKES[S.mode].map(function (v, i) {
      return '<button class="chip' + (i === stakeIdx[S.mode] ? ' is-active' : '') + '" data-stake="' + i + '">' + v + '</button>';
    }).join('');
  }
  function renderTicker() {
    var t = q('#ticker'); if (!t) return;
    if (!S.feed.length) { t.classList.add('is-hidden'); return; }
    t.classList.remove('is-hidden');
    var ev = S.feed[0];
    var ic = { shot: 'ti-target-arrow', corner: 'ti-flag-3', goal: 'ti-ball-football', card: 'ti-rectangle-vertical', clear: 'ti-shield' }[ev.kind];
    var col = ev.delayed ? 'var(--warn)' : ev.kind === 'goal' ? 'var(--accent)' : ev.kind === 'card' ? 'var(--away)' : 'var(--text2)';
    t.innerHTML = '<i class="ti ' + (ev.delayed ? 'ti-clock-exclamation' : ic) + '" style="color:' + col + '"></i><span class="ticker__t">' + ev.text + '</span>';
  }

  /* ---- the board (open → locked → results) --------------------------------- */
  function renderBoard() {
    var open = S.markets.filter(function (m) { return m.status === 'open'; });
    var locked = S.markets.filter(function (m) { return m.status === 'locked' && m.bet; });
    fill('#zone-open', open.map(openCard).join(''));
    section('#sec-locked', '#zone-locked', locked.map(lockedCard).join(''), locked.length);
    section('#sec-results', '#zone-results', S.results.slice(0, 5).map(resultRow).join(''), S.results.length);
    // also render the friends board (shared markets reuse open cards)
    var fb = q('#friends-board'); if (fb) fb.innerHTML = open.slice(0, 2).map(openCard).join('');
  }

  function multStr(m, k) { return GZ.mult(m, GZ.sideOf(m, k)).toFixed(2) + '×'; }
  function laneCls(m) { return (m.fam === 'shotcorner' || m.fam === 'goalwin') ? 'lane--accent' : m.set ? 'lane--set' : 'lane--neutral'; }

  function openCard(m) {
    var head = '<div class="between" style="margin-bottom:11px;"><span class="lane ' + laneCls(m) + '">' + m.lane + '</span><span class="dim row" style="gap:5px;font-size:11px;">' + (m.note ? '<i class="ti ti-clock-exclamation" style="color:var(--warn);font-size:13px;"></i>' + m.note : '<i class="ti ti-lock-open" style="font-size:13px;"></i>betting · locks next event') + '</span></div>';
    var body;
    if (m.bet) {
      var s = GZ.sideOf(m, m.bet.sideK);
      var other = m.sides.filter(function (x) { return x.k !== m.bet.sideK; }).map(function (x) { return '<button class="side is-faded"><span class="label">' + x.label + '</span><span class="mult">' + multStr(m, x.k) + '</span></button>'; }).join('');
      body = '<div class="sides">' + other + '<div class="position"><div class="position__top">' + m.bet.label + ' · ' + GZ.fmt(m.bet.stake) + '</div><div class="position__win">to win <b class="num">' + GZ.fmt(GZ.projected(m)) + '</b></div><div class="position__tag"><i class="ti ti-circle-dot"></i>open · ' + multStr(m, m.bet.sideK) + '</div></div></div>';
    } else {
      body = '<div class="sides">' + m.sides.map(function (x) {
        var cls = x.k === 'home' ? 'side--home' : x.k === 'away' ? 'side--away' : x.k === 'yes' ? 'side--yes' : '';
        return '<button class="side ' + cls + '" data-bet="' + m.id + '" data-side="' + x.k + '"><span class="label">' + x.label + '</span><span class="mult">' + multStr(m, x.k) + '</span></button>';
      }).join('') + '</div>';
    }
    return '<div class="card">' + head + '<p class="card__q">' + m.q + '</p>' + body + '</div>';
  }

  function lockedCard(m) {
    return '<div class="card card--locked"><div class="between"><span class="row" style="gap:8px;"><i class="ti ti-lock" style="font-size:15px;color:var(--text2);"></i><span style="font-size:14px;font-weight:700;">' + m.q + '</span></span><span class="dim" style="font-size:11px;font-weight:700;">awaiting</span></div>' +
      '<div class="between" style="margin-top:9px;"><span class="muted" style="font-size:12px;">' + m.bet.label + ' · ' + GZ.fmt(m.bet.stake) + ' staked</span><span class="num" style="font-size:13px;font-weight:700;color:var(--accent);">to win ' + GZ.fmt(GZ.projected(m)) + '</span></div></div>';
  }

  function resultRow(m) {
    var won = m.result !== 'VOID' && m.bet && m.bet.sideK === m.result;
    var voided = m.result === 'VOID';
    var amtCol = won ? 'var(--accent)' : voided ? 'var(--text2)' : 'var(--text3)';
    var verb = !m.bet ? 'resulted' : voided ? 'refunded' : won ? 'won' : 'lost';
    var note = m.note ? '<div class="result__note"><i class="ti ' + (m.set ? 'ti-shield-x' : 'ti-clock-exclamation') + '"></i>' + m.note + '</div>' : '';
    return '<div class="result' + (won ? ' result--won' : '') + '"><div class="between"><span style="font-size:13px;font-weight:700;">' + m.q + '</span>' +
      (m.payoutLabel ? '<span class="num" style="font-size:15px;font-weight:700;color:' + amtCol + ';">' + m.payoutLabel + '</span>' : '<span class="dim" style="font-size:12px;">' + verb + '</span>') +
      '</div><div class="dim" style="font-size:11px;margin-top:4px;">' + (m.bet ? m.bet.label + ' · ' + verb : verb) + '</div>' + note + '</div>';
  }

  /* ---- activity ------------------------------------------------------------ */
  function renderActivity() {
    var live = S.bets.filter(function (b) { return b.status === 'open'; });
    var done = S.bets.filter(function (b) { return b.status !== 'open'; });
    var staked = S.bets.reduce(function (a, b) { return a + b.stake; }, 0);
    var ret = S.bets.reduce(function (a, b) { return a + (b.payout || 0); }, 0) + live.reduce(function (a, b) { return a + b.stake; }, 0);
    var pl = ret - staked;
    var pe = q('#act-pl'); if (pe) { pe.textContent = (pl >= 0 ? '+' : '') + GZ.fmt(pl); pe.className = 'metric__v num ' + (pl >= 0 ? 'win' : 'loss'); }
    var lc = q('#act-live-count'); if (lc) lc.textContent = live.length;
    fill('#act-live', live.length ? live.map(function (b) {
      return '<div class="card" style="padding:12px 14px;margin-bottom:9px;"><div class="between"><span style="font-size:14px;font-weight:700;">' + b.q + ' · ' + b.side + '</span><span class="dim" style="font-size:11px;font-weight:700;">' + (b.mode === 'real' ? 'REAL' : 'points') + '</span></div><div class="between" style="margin-top:7px;"><span class="muted" style="font-size:12px;">' + GZ.fmt(b.stake) + ' stake · ' + b.match + '</span><span style="font-size:12px;color:var(--away);font-weight:700;">live</span></div></div>';
    }).join('') : '<div class="dim" style="padding:2px 16px 8px;font-size:13px;">No open bets — place one on the board.</div>');
    fill('#act-settled', done.length ? done.map(function (b) {
      var amt = b.status === 'won' ? '+' + GZ.fmt(b.payout) : b.status === 'void' ? '+' + GZ.fmt(b.stake) : '−' + GZ.fmt(b.stake);
      var col = b.status === 'lost' ? 'loss' : 'win';
      return '<div class="bet-row"><div><div class="bet-row__t ' + (b.status === 'lost' ? 'muted' : '') + '">' + b.q + '</div><div class="bet-row__s">' + GZ.fmt(b.stake) + ' · ' + b.side + ' · ' + b.status + '</div></div><span class="bet-row__amt ' + col + '">' + amt + '</span></div>';
    }).join('') : '<div class="dim" style="padding:2px 16px 8px;font-size:13px;">Nothing settled yet — hit Simulate.</div>');
  }

  /* ---- friends ------------------------------------------------------------- */
  var FRIENDS_FEED = [
    { who: 'samir', act: 'backed Algeria to score next', amt: '50' },
    { who: 'mia', act: 'won · a shot this spell', amt: '+72' },
    { who: 'you', act: 'backed Yes · goal in 3 min', amt: '25' },
    { who: 'deniz', act: 'lost · who threatens next', amt: '−40' },
  ];
  function renderFriends() {
    var f = q('#friends-feed'); if (!f) return;
    f.innerHTML = FRIENDS_FEED.map(function (x) {
      var me = x.who === 'you';
      var col = x.amt[0] === '+' ? 'var(--accent)' : x.amt[0] === '−' ? 'var(--text3)' : 'var(--text2)';
      return '<div class="friend-row"><span class="avatar" style="background:' + avatarColor(x.who) + '">' + x.who[0].toUpperCase() + '</span><span class="friend-row__t"><b>' + (me ? 'You' : x.who) + '</b> ' + x.act + '</span><span class="num" style="font-size:13px;font-weight:700;color:' + col + ';">' + x.amt + '</span></div>';
    }).join('');
  }
  function avatarColor(n) { var c = ['#5B8DEF', '#F5A524', '#27E08A', '#C77DFF']; var i = 0; for (var k = 0; k < n.length; k++) i += n.charCodeAt(k); return c[i % c.length]; }

  /* ---- simulate + reveal --------------------------------------------------- */
  function doSim(delayed) {
    var mine = GZ.simulate(delayed);
    renderAll();
    var net = mine.reduce(function (a, b) { var bet = S.bets.filter(function (x) { return x.mId === b.id; })[0]; return a + (bet ? (bet.status === 'won' ? bet.payout - bet.stake : bet.status === 'void' ? 0 : -bet.stake) : 0); }, 0);
    if (mine.length) reveal(net, mine);
  }
  function reveal(net, mine) {
    var t = q('#toast'); if (!t) return;
    var voided = mine.every(function (m) { return m.result === 'VOID'; });
    var win = net > 0;
    t.className = 'toast' + (voided ? ' toast--void' : win ? '' : ' toast--loss');
    var ic = voided ? 'ti-arrow-back-up' : win ? 'ti-trophy' : 'ti-circle-x';
    var label = voided ? 'Refunded — voided' : win ? 'Nice — you won' : 'No luck that time';
    var amt = voided ? '' : (net >= 0 ? '+' : '') + GZ.fmt(net);
    t.innerHTML = '<i class="ti ' + ic + '"></i><span class="toast__t">' + label + '</span><span class="toast__amt">' + amt + '</span>';
    clearTimeout(reveal._t); reveal._t = setTimeout(function () { t.classList.add('is-hidden'); }, 3200);
  }

  /* ---- helpers + delegated clicks ------------------------------------------ */
  function q(s) { return document.querySelector(s); }
  function qa(s) { return [].slice.call(document.querySelectorAll(s)); }
  function fill(sel, html) { var e = q(sel); if (e) e.innerHTML = html; }
  function section(secSel, zoneSel, html, n) { var s = q(secSel); if (s) s.classList.toggle('is-hidden', !n); fill(zoneSel, html); }

  document.querySelector('.phone').addEventListener('click', function (e) {
    var g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go); return; }
    var md = e.target.closest('[data-mode]'); if (md) { GZ.setMode(md.dataset.mode); renderAll(); return; }
    var ch = e.target.closest('.chip[data-stake]'); if (ch) { stakeIdx[S.mode] = Number(ch.dataset.stake); renderStake(); return; }
    if (e.target.closest('#sim')) { doSim(false); return; }
    if (e.target.closest('#sim-delay')) { doSim(true); return; }
    if (e.target.closest('#reset')) { GZ.reset(); renderAll(); return; }
    var b = e.target.closest('.side[data-bet]'); if (b && !b.classList.contains('is-faded')) { GZ.placeBet(b.dataset.bet, b.dataset.side, stake()); renderAll(); return; }
  });

  go('onboarding');
})();

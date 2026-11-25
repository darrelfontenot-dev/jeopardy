/* Host console: a second window that mirrors the game, shows the answers and sends commands to the main screen. */
(function (global) {
  'use strict';

  var E = global.JeopardyEngine, FJ = global.FJ, esc = FJ.esc, money = FJ.money;
  var $ = function (id) { return document.getElementById(id); };
  var chan = null, state = null, eng = null, canUndo = false, timer = 0, helloTimer = 0;

  function send(name, args) { chan.postMessage({ t: 'cmd', name: name, args: args || [] }); }

  function mount() {
    document.body.classList.add('ui');
    ['screen-setup', 'screen-admin', 'screen-game'].forEach(function (id) { $(id).hidden = true; });
    var root = $('screen-host');
    root.hidden = false;
    document.title = 'Host console - Christmas Jeopardy';
    if (!global.BroadcastChannel) {
      root.innerHTML = '<div class="host-wait">This browser cannot link windows. Use Chrome or Edge.</div>';
      return;
    }
    chan = new BroadcastChannel(FJ.CHANNEL);
    chan.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.t !== 'state') return;
      state = m.s;
      canUndo = !!m.canUndo;
      eng = state ? new E(state) : null;
      render();
    };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.id === 'h-wager') { e.preventDefault(); wager(); }
      if (e.key === 'Enter' && e.target.id === 'h-fwager') { e.preventDefault(); fwager(e.target); }
    });
    document.addEventListener('keydown', onKey);
    chan.postMessage({ t: 'hello' });
    helloTimer = setInterval(function () { if (!state) chan.postMessage({ t: 'hello' }); }, 1500);
    timer = setInterval(tickTimers, 200);
    render();
  }

  function wager() {
    var inp = $('h-wager');
    if (inp && inp.value !== '') send('wager', [inp.value]);
  }

  function fwager(inp) {
    if (inp && inp.value !== '') send('finalWager', [inp.dataset.pid, inp.value]);
  }

  function onKey(e) {
    if (!state || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    var k = e.key, did = true;
    if (k === ' ') send('advance');
    else if (k === 'y' || k === 'Y') send('judge', [true]);
    else if (k === 'n' || k === 'N') send('judge', [false]);
    else if (k === 'r' || k === 'R') send('skip');
    else if (k === 'a' || k === 'A') send('finalAnswer');
    else if (k === 'p' || k === 'P') send('media');
    else if (k === 'u' || k === 'U') send('undo');
    else if (/^[1-6]$/.test(k)) {
      var p = state.players[Number(k) - 1];
      if (p) send(state.phase === 'clue' ? 'buzz' : 'control', [p.id]);
    } else did = false;
    if (did) e.preventDefault();
  }

  function onClick(e) {
    var el = e.target.closest('[data-h]');
    if (!el) return;
    var a = el.dataset.h;
    if (a === 'tile') send('select', [Number(el.dataset.c), Number(el.dataset.r)]);
    else if (a === 'advance') send('advance');
    else if (a === 'open') send('open');
    else if (a === 'buzz') send('buzz', [el.dataset.pid]);
    else if (a === 'judge') send('judge', [el.dataset.v === '1']);
    else if (a === 'skip') send('skip');
    else if (a === 'undo') send('undo');
    else if (a === 'end') { if (confirm('End this round now?')) send('endRound'); }
    else if (a === 'wager') wager();
    else if (a === 'wager-max') send('wager', [eng.ddMax()]);
    else if (a === 'fwager') fwager($('h-fwager'));
    else if (a === 'fanswer') send('finalAnswer');
    else if (a === 'media') send('media');
    else if (a === 'control') send('control', [el.dataset.pid]);
    else if (a === 'adjust') send('adjust', [el.dataset.pid, Number(el.dataset.d)]);
    el.blur();
  }

  function b(h, label, cls, extra) {
    return '<button type="button" class="btn ' + (cls || '') + '" data-h="' + h + '"' + (extra || '') + '>' + label + '</button>';
  }

  function nameOf(pid) { var p = eng.player(pid); return p ? esc(p.name) : ''; }

  function render() {
    var root = $('screen-host');
    if (!state) {
      root.innerHTML = hostHead('Waiting for the game') + '<div class="host-wait">Start a game in the main window. This console connects automatically.</div>';
      return;
    }
    var s = state;
    root.innerHTML = hostHead(FJ.roundLabel(s) + ' &middot; ' + esc(FJ.stepHint(s))) +
      '<div class="host-body">' + nowCard(s) + scoreCard(s) + '</div>';
    tickTimers();
  }

  function hostHead(sub) {
    return '<header class="host-head"><img src="/static/img/logo-dark.svg" alt="" class="host-logo"><div><div class="host-title">Host console</div><div class="host-sub">' + sub + '</div></div>' +
      '<div class="host-tools">' + (state ? b('undo', '&#8630; Undo', '', canUndo ? '' : ' disabled') : '') + '</div></header>';
  }

  function nowCard(s) {
    var h = '<section class="card host-card"><div class="card-body">';
    if (s.phase === 'intro') {
      h += '<p class="host-line">The board is being revealed on the main screen.</p><div class="host-actions">' + b('advance', 'Skip intro (Space)', 'btn-primary') + '</div>';
    } else if (s.phase === 'board') {
      h += boardHtml(s);
    } else if (s.phase === 'clue') {
      h += clueHtml(s);
    } else if (s.phase === 'round_end') {
      h += '<p class="host-line"><b>Round complete.</b></p><div class="host-actions">' + b('advance', 'Start next part (Space)', 'btn-primary') + '</div>';
    } else if (s.phase === 'final') {
      h += finalHtml(s);
    } else {
      var w = eng.winners().map(function (p) { return esc(p.name); }).join(' &amp; ');
      h += '<p class="host-line"><b>Game over.</b> Winner: ' + w + '</p>';
    }
    return h + '</div></section>';
  }

  function boardHtml(s) {
    var bd = eng.board(), cols = bd.categories.length, rows = bd.rowValues.length;
    var h = '<p class="host-line"><span class="pill-up">' + nameOf(s.control) + '</span> has control. Pick the clue they choose:</p>';
    h += '<div class="mini-board" style="--cols:' + cols + '">';
    bd.categories.forEach(function (n) { h += '<div class="mb-cat">' + esc(n) + '</div>'; });
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      var cell = bd.grid[c][r];
      h += (!cell || cell.done) ? '<div class="mb-tile off"></div>' :
        '<button type="button" class="mb-tile" data-h="tile" data-c="' + c + '" data-r="' + r + '" title="' + esc(cell.clue) + '">' + (cell.dd ? '<i title="Daily Double">DD</i>' : '') + money(cell.value) + '</button>';
    }
    h += '</div><div class="host-actions">' + b('end', 'End round') + '</div>';
    return h;
  }

  function clueHtml(s) {
    var k = s.clue, bd = eng.board(), cell = eng.cell(k.c, k.r);
    var h = '<div class="host-meta">' + esc(bd.categories[k.c]) + ' &middot; <b>' + money(k.value) + '</b>' + (k.dd ? ' &middot; <span class="badge-review">DAILY DOUBLE</span>' : '') + '</div>';
    h += '<div class="host-clue">' + esc(cell.clue) + '</div>';
    h += mediaHtml(cell.media);
    h += '<div class="host-answer"><span>ANSWER</span>' + esc(cell.answer) + '</div>';
    h += mediaHtml(cell.answerMedia, true);
    var actions = '';
    if (k.step === 'dd_splash') actions = b('advance', 'Continue (Space)', 'btn-primary');
    else if (k.step === 'dd_wager') {
      var p = eng.player(s.control), max = eng.ddMax();
      h += '<p class="host-line">' + nameOf(s.control) + ' has ' + money(p.score) + '. Wager ' + money(E.DD_MIN) + ' to ' + money(max) + '.</p>' +
        '<div class="host-actions"><input id="h-wager" class="num-input" type="number" min="' + E.DD_MIN + '" max="' + max + '" placeholder="Wager">' + b('wager', 'Lock in', 'btn-primary') + b('wager-max', 'True Daily Double') + '</div>';
    } else if (k.step === 'reading') actions = b('open', (k.dd ? 'Start answer clock' : 'Open buzzers') + ' (Space)', 'btn-primary');
    else if (k.step === 'open') {
      h += '<p class="host-line">Buzzers open <span id="h-timer" class="host-timer"></span>. Ring in for a player:</p><div class="host-actions">' + ringButtons(s) + '</div>';
    } else if (k.step === 'answering') {
      h += '<p class="host-line"><b>' + nameOf(k.answerer) + '</b> is answering <span id="h-timer" class="host-timer"></span>' + (k.timedOut ? ' <span class="pill-down">Time&rsquo;s up</span>' : '') + '</p>';
      actions = b('judge', '&#10003; Correct (Y)', 'btn-primary', ' data-v="1"') + b('judge', '&#10007; Incorrect (N)', 'bad', ' data-v="0"');
    } else if (k.step === 'reveal') actions = b('advance', 'Continue (Space)', 'btn-primary');
    if (k.reading && (k.step === 'open' || k.step === 'answering')) actions = b('advance', 'Done reading &mdash; start clock (Space)', 'btn-primary') + actions;
    if (k.step !== 'reveal' && k.step !== 'dd_wager') actions += b('skip', 'Skip clue (R)');
    return h + (actions ? '<div class="host-actions">' + actions + '</div>' : '');
  }

  function mediaHtml(ref, answer) {
    var info = FJ.mediaInfo(ref);
    if (!info) return '';
    var tag = answer ? '<span>Shown with the answer:</span>' : '';
    if (info.kind === 'image') return '<div class="host-media">' + tag + '<img src="' + esc(info.src) + '" alt=""></div>';
    var label = { video: '&#127916; Video', audio: '&#127925; Sound', embed: '&#127916; Web video' }[info.kind] + (answer ? ' with the answer' : info.kind === 'embed' ? '' : ' clue');
    return '<div class="host-media"><span>' + label + ': ' + esc(info.name) + '</span>' +
      (info.kind === 'embed' ? '' : b('media', 'Play / pause on the board (P)')) + '</div>';
  }

  function ringButtons(s) {
    var k = s.clue;
    return s.players.map(function (p, i) {
      return b('buzz', (i + 1) + ' ' + esc(p.name), '', ' data-pid="' + p.id + '"' + (k.locked.indexOf(p.id) >= 0 ? ' disabled' : ''));
    }).join('');
  }

  /* The response a player sent from their device (the host sees it before it is revealed on the board). */
  function hostResponse(s, pid) {
    var r = s.fresp && s.fresp[pid];
    if (!r) return '<div class="host-resp is-none">No response sent</div>';
    if (r.ink) return '<div class="host-resp is-ink"><img src="' + esc(r.ink) + '" alt="Handwritten response"></div>';
    return '<div class="host-resp">' + esc(r.text) + '</div>';
  }

  function finalHtml(s) {
    var f = s.final, fc = s.finalClue, h = '<div class="host-meta">Final Jeopardy &middot; <b>' + esc(fc.category) + '</b></div>';
    h += '<div class="host-clue">' + esc(fc.clue) + '</div>' + mediaHtml(fc.media) + '<div class="host-answer"><span>ANSWER</span>' + esc(fc.answer) + '</div>' + mediaHtml(fc.answerMedia, true);
    var wagers = f.eligible.map(function (id) { return nameOf(id) + ': ' + (f.wagers[id] != null ? money(f.wagers[id]) : '&hellip;'); }).join(' &nbsp;&middot;&nbsp; ');
    h += '<p class="host-line"><b>Wagers:</b> ' + wagers + '</p>';
    if (f.step === 'category') h += '<div class="host-actions">' + b('advance', 'Collect wagers (Space)', 'btn-primary') + '</div>';
    else if (f.step === 'wager') {
      var pid = f.eligible[f.wi], p = eng.player(pid);
      h += '<p class="host-line">' + nameOf(pid) + ' (' + money(p.score) + ') is wagering on the main screen, or enter it here:</p>' +
        '<div class="host-actions"><input id="h-fwager" class="num-input" type="number" min="0" max="' + p.score + '" data-pid="' + pid + '" placeholder="Wager">' + b('fwager', 'Lock in', 'btn-primary') + '</div>';
    } else if (f.step === 'ready') h += '<div class="host-actions">' + b('advance', 'Reveal the clue (Space)', 'btn-primary') + '</div>';
    else if (f.step === 'clue') {
      h += '<p class="host-line">Think time <span id="h-timer" class="host-timer"></span></p>';
      if (s.room) h += '<p class="host-line"><b>Responses in:</b> ' + f.eligible.map(function (id) { return (s.fresp && s.fresp[id] ? '&#10003; ' : '&hellip; ') + nameOf(id); }).join(' &nbsp;&middot;&nbsp; ') + '</p>';
      h += '<div class="host-actions">' + b('advance', 'Reveal answers (Space)', 'btn-primary') + '</div>';
    }
    else if (f.step === 'reveal') {
      var cur = eng.player(f.order[f.ri]);
      h += '<p class="host-line">Now judging <b>' + esc(cur.name) + '</b> (wager ' + money(f.wagers[cur.id] || 0) + ')</p>' + (s.room ? hostResponse(s, cur.id) : '') + '<div class="host-actions">' +
        (f.shown ? b('judge', '&#10003; Correct (Y)', 'btn-primary', ' data-v="1"') + b('judge', '&#10007; Incorrect (N)', 'bad', ' data-v="0"') : b('advance', 'Reveal response &amp; wager (Space)', 'btn-primary')) +
        (f.answerShown ? '' : b('fanswer', 'Show correct response (A)')) + '</div>';
    } else if (f.step === 'done') h += '<div class="host-actions">' + b('advance', 'See final results (Space)', 'btn-primary') + '</div>';
    return h;
  }

  function scoreCard(s) {
    var h = '<section class="card host-card"><div class="card-header"><h2 class="card-title">Scores</h2></div><div class="card-body"><table class="ui-table"><tbody>';
    s.players.forEach(function (p, i) {
      h += '<tr><td>' + (i + 1) + ' &middot; ' + esc(p.name) + (s.control === p.id ? ' <span class="pill-up">picks</span>' : '') + '</td><td class="' + (p.score < 0 ? 'pill-down-inline' : '') + '">' + money(p.score) + '</td>' +
        '<td class="host-mini">' + b('adjust', '&minus;100', '', ' data-pid="' + p.id + '" data-d="-100"') + b('adjust', '+100', '', ' data-pid="' + p.id + '" data-d="100"') +
        (s.phase === 'board' ? b('control', 'Pick', '', ' data-pid="' + p.id + '"') : '') + '</td></tr>';
    });
    return h + '</tbody></table></div></section>';
  }

  function tickTimers() {
    var el = $('h-timer');
    if (!el || !state) return;
    var d = state.clue ? state.clue.deadline : state.final ? state.final.deadline : null;
    el.textContent = d ? Math.max(0, Math.ceil((d - Date.now()) / 1000)) + 's' : '';
  }

  global.FJHost = { mount: mount };
})(window);

/* Player screen: join a running game from a phone or laptop and ring in with a big buzzer. */
(function (global) {
  'use strict';

  var FJ = global.FJ, esc = FJ.esc, money = FJ.money, api = global.FJRemote.api;
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'fj.player.v1';

  var root = null, me = null, view = null, started = false, roster = [], ver = -1, gen = 0;
  var lastClue = '', buzzedAt = 0, flash = '', flashTimer = 0, wakeLock = null, error = '';

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* private mode */ } }

  function mount(code) {
    document.body.classList.remove('ui');
    document.body.classList.add('in-player');
    ['screen-setup', 'screen-admin', 'screen-game', 'screen-host'].forEach(function (id) { $(id).hidden = true; });
    root = $('screen-player');
    root.hidden = false;
    document.title = 'Buzzer - Christmas Jeopardy';
    root.addEventListener('click', onClick);
    root.addEventListener('pointerdown', onPress);
    root.addEventListener('submit', function (e) {
      e.preventDefault();
      if (e.target.id === 'pl-join') join(); else if (e.target.id === 'pl-wager') wager(); else if (e.target.id === 'pl-fresp') sendResponse(false);
    });
    root.addEventListener('input', function (e) {
      if (e.target.id !== 'pl-fr-text') return;
      fr.text = e.target.value;
      fr.dirty = true;
      fr.err = '';
      responseRefresh();
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && me) keepAwake(); });

    var saved = load();
    code = (code || '').toUpperCase();
    if (saved.token && saved.code && (!code || code === saved.code)) {
      me = { code: saved.code, token: saved.token, name: saved.name };
      poll();
    }
    renderJoin(code || saved.code || '', saved.name || '');
    if (me) render();
  }

  /* ------------------------------------------------------------------ joining */

  function renderJoin(code, name) {
    root.innerHTML = '<div class="pl-shell"><div class="pl-brand"><img src="/static/img/logo-light.svg" alt="" class="pl-logo"><span>CHRISTMAS JEOPARDY</span></div>' +
      '<form id="pl-join" class="pl-card" autocomplete="off"><h1>Join a game</h1>' +
      '<label for="pl-code">Game code</label><input id="pl-code" class="pl-input pl-code" maxlength="4" value="' + esc(code) + '" placeholder="ABCD" autocapitalize="characters" spellcheck="false">' +
      '<label for="pl-name">Your name</label><input id="pl-name" class="pl-input" maxlength="20" value="' + esc(name) + '" placeholder="Name on your podium">' +
      '<label>Write your name on your podium <span class="pl-opt">(optional, like on the show)</span></label>' + padHtml() +
      '<button class="pl-btn" type="submit">Join</button>' +
      '<p class="pl-err" id="pl-err">' + esc(error) + '</p>' +
      '<p class="pl-note">The game code is shown on the host&rsquo;s screen.</p></form></div>';
    var first = code ? $('pl-name') : $('pl-code');
    if (first && !me) first.focus();
    pad = makePad($('pl-pad'));
  }

  /* ------------------------------------------------------------------ handwritten name (light pen) */

  var pad = null, padOpen = false;

  function padHtml() {
    return '<div class="pl-padwrap"><canvas id="pl-pad" class="pl-pad" aria-label="Write your name here with your finger or mouse"></canvas>' +
      '<span class="pl-padhint" id="pl-padhint">Write here with your finger or mouse</span>' +
      '<button type="button" class="pl-link pl-padclear" data-pl="pad-clear">Clear</button></div>';
  }

  function makePad(canvas, onInk) {
    if (!canvas) return null;
    var dpr = global.devicePixelRatio || 1, ctx = canvas.getContext('2d'), inked = false, last = null;
    var hint = canvas.parentNode.querySelector('.pl-padhint');
    var box = canvas.getBoundingClientRect();
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(3, Math.min(box.height / 28, 6)) * dpr;
    var at = function (e) { var r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr }; };
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      last = at(e);
      ctx.beginPath(); ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      if (!inked) { inked = true; if (hint) hint.hidden = true; }
      if (onInk) onInk();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!last) return;
      e.preventDefault();
      var p = at(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
    });
    var end = function () { last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    return {
      inked: function () { return inked; },
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); inked = false; if (hint) hint.hidden = false; if (onInk) onInk(); },
      /* Crop to the ink and shrink, so the big screen gets a small, tight PNG. */
      png: function (maxH, maxW) {
        if (!inked) return '';
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height).data, w = canvas.width, h = canvas.height;
        var x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
          if (img[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if (x1 < 0) return '';
        var padPx = Math.round(ctx.lineWidth);
        x0 = Math.max(0, x0 - padPx); y0 = Math.max(0, y0 - padPx); x1 = Math.min(w - 1, x1 + padPx); y1 = Math.min(h - 1, y1 + padPx);
        var cw = x1 - x0 + 1, ch = y1 - y0 + 1, scale = Math.min(1, (maxH || 140) / ch, (maxW || 560) / cw);
        var out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(cw * scale)); out.height = Math.max(1, Math.round(ch * scale));
        out.getContext('2d').drawImage(canvas, x0, y0, cw, ch, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      }
    };
  }

  function saveSig(sig) {
    return api('POST', '/api/rooms/' + encodeURIComponent(me.code) + '/sign', { token: me.token, sig: sig });
  }

  function openPad() {
    padOpen = true;
    root.innerHTML = '<div class="pl-shell"><div class="pl-brand"><img src="/static/img/logo-light.svg" alt="" class="pl-logo"><span>CHRISTMAS JEOPARDY</span></div>' +
      '<div class="pl-card"><h1>Write your name</h1><p class="pl-note pl-left">This is what appears on your podium on the big screen.</p>' + padHtml() +
      '<button class="pl-btn" type="button" data-pl="pad-save">Save</button>' +
      '<div class="pl-padrow"><button type="button" class="pl-link" data-pl="pad-cancel">Cancel</button>' +
      (me.sig ? '<button type="button" class="pl-link" data-pl="pad-remove">Use my typed name instead</button>' : '') + '</div>' +
      '<p class="pl-err" id="pl-err"></p></div></div>';
    pad = makePad($('pl-pad'));
  }

  function closePad() { padOpen = false; pad = null; render(); }

  function join() {
    var code = ($('pl-code').value || '').trim().toUpperCase(), name = ($('pl-name').value || '').trim();
    if (code.length !== 4) { showErr('Type the 4-letter code from the host\u2019s screen.'); return; }
    if (!name) { showErr('Type your name.'); return; }
    var saved = load();
    var body = { name: name, token: saved.code === code ? saved.token : null };
    var sig = pad ? pad.png() : '';
    api('POST', '/api/rooms/' + encodeURIComponent(code) + '/join', body).then(function (r) {
      me = { code: code, token: r.token, name: r.name };
      if (sig) saveSig(sig).catch(function (e) { alert(e.message); });
      save({ code: code, token: r.token, name: r.name });
      error = '';
      ver = -1;
      keepAwake();
      history.replaceState(null, '', location.pathname + '?join=' + encodeURIComponent(code));
      poll();
      render();
    }).catch(function (e) { showErr(e.message); });
  }

  function showErr(msg) { error = msg; var el = $('pl-err'); if (el) el.textContent = msg; }

  function leave(msg) {
    gen++;
    var saved = load();
    me = null; view = null; started = false; ver = -1;
    save({ name: saved.name });
    error = msg || '';
    renderJoin('', saved.name || '');
  }

  function keepAwake() {
    if (!navigator.wakeLock || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; l.addEventListener('release', function () { wakeLock = null; }); }).catch(function () {});
  }

  /* ------------------------------------------------------------------ live state */

  function poll() {
    var g = ++gen;
    (function loop() {
      if (g !== gen || !me) return;
      api('GET', '/api/rooms/' + encodeURIComponent(me.code) + '/player?token=' + encodeURIComponent(me.token) + '&since=' + ver).then(function (d) {
        if (g !== gen) return;
        ver = d.ver;
        me.slot = d.me.slot;
        me.id = d.me.id;
        me.sig = d.me.sig || '';
        me.name = d.me.name;
        started = d.started;
        roster = d.players;
        view = d.state;
        render();
        loop();
      }).catch(function (e) {
        if (g !== gen) return;
        if (e.status === 403) { leave('You were removed from the game, or it restarted. Join again.'); return; }
        if (e.status === 404) { leave('That game has ended or the code is wrong.'); return; }
        setTimeout(loop, 1500);
      });
    })();
  }

  function playerOf(id) {
    var list = view && view.players || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function nameOf(id) { var p = playerOf(id); return p ? p.name : ''; }

  /* Works out the buzzer's look and caption from the host's state. */
  function buzzer() {
    var v = view, k = v && v.clue, slot = me.slot;
    if (!started || !v) return { cls: 'wait', big: 'Waiting', small: 'The host will start the game soon.' };
    if (v.phase === 'clue' && k) {
      if (k.id !== lastClue) { lastClue = k.id; buzzedAt = 0; flash = ''; }
      var head = k.category + ' \u00b7 ' + money(k.value);
      if (k.dd) {
        return k.step === 'reveal' ? { cls: 'wait', big: 'Daily Double', small: head }
          : { cls: k.answerer === slot || v.control === slot ? 'you' : 'wait', big: 'Daily Double', small: (v.control === slot ? 'It\u2019s yours! Tell the host your wager.' : nameOf(v.control) + ' is playing it.') };
      }
      if (k.step === 'reading') {
        if (k.early.indexOf(slot) >= 0 || flash === 'early') return { cls: 'early', big: 'Too early!', small: 'Wait until the host opens the buzzers.', press: true, head: head };
        return { cls: 'armed', big: 'Get ready', small: 'Buzz when the host opens the buzzers.', press: true, head: head };
      }
      if (k.step === 'open') {
        if (k.locked.indexOf(slot) >= 0) return { cls: 'locked', big: 'Locked out', small: 'You already answered this clue.', head: head };
        if (buzzedAt && Date.now() - buzzedAt < 1500) return { cls: 'sent', big: 'Buzzed!', small: 'Waiting for the host\u2026', head: head };
        return { cls: 'live', big: 'BUZZ!', small: 'Tap the button or press Space', press: true, head: head };
      }
      if (k.step === 'answering') {
        if (k.answerer === slot) return { cls: 'you', big: 'You\u2019re up!', small: k.timedOut ? 'Time is up \u2014 give your answer.' : 'Say your answer out loud.', head: head };
        return { cls: 'other', big: nameOf(k.answerer), small: 'rang in first', head: head };
      }
      if (k.step === 'reveal') {
        if (k.winner === slot) return { cls: 'you', big: 'Correct!', small: '+' + money(k.value), head: head };
        if (k.winner) return { cls: 'other', big: nameOf(k.winner), small: 'got it', head: head };
        return { cls: 'wait', big: 'Nobody got it', small: head };
      }
    }
    if (v.phase === 'board' || v.phase === 'intro') {
      return v.control === slot ? { cls: 'you', big: 'Your pick!', small: 'Tell the host a category and value.' } : { cls: 'wait', big: nameOf(v.control), small: 'picks the next clue' };
    }
    if (v.phase === 'round_end') return { cls: 'wait', big: 'Round over', small: 'Next round coming up.' };
    if (v.phase === 'over') {
      var won = (v.winners || []).indexOf(slot) >= 0;
      return { cls: won ? 'you' : 'wait', big: won ? 'You win!' : 'Game over', small: won ? 'Congratulations!' : (v.winners || []).map(nameOf).join(' & ') + ' won.' };
    }
    return { cls: 'wait', big: v.round || '', small: '' };
  }

  function finalPanel() {
    var f = view.final, slot = me.slot, p = playerOf(slot), eligible = f.eligible.indexOf(slot) >= 0;
    var h = '<div class="pl-final"><div class="pl-kicker">FINAL JEOPARDY</div><div class="pl-fcat">' + esc(f.category) + '</div>';
    if (!eligible) return h + '<p>Only players with a score above $0 play Final Jeopardy. Enjoy the show!</p></div>';
    if (f.step === 'category') return h + '<p>Think about how much to risk. Wagers open in a moment.</p></div>';
    if (f.step === 'wager') {
      if (f.wagered.indexOf(slot) >= 0 && !view.errors[slot]) return h + '<p class="pl-ok">Wager locked in. Wait for the clue.</p></div>';
      return h + '<form id="pl-wager" class="pl-wager"><label for="pl-wager-n">Your secret wager ($0 &ndash; ' + money(p.score) + ')</label>' +
        '<input id="pl-wager-n" class="pl-input" type="number" inputmode="numeric" min="0" max="' + p.score + '" step="1">' +
        '<button class="pl-btn" type="submit">Lock in wager</button>' +
        '<p class="pl-err">' + esc(view.errors[slot] || '') + '</p></form></div>';
    }
    if (f.step === 'ready') return h + '<p class="pl-ok">All wagers are in. The clue is next.</p></div>';
    if (f.step === 'clue' && !f.timeUp) return h + responseForm() + '</div>';
    if (f.step === 'clue') return h + '<p class="pl-bad">Time&rsquo;s up &mdash; pens down!</p>' + sentHtml() + '</div>';
    var res = f.results[slot];
    if (f.revealing === slot) return h + '<p class="pl-ok">Your turn! Your response is going up on the big screen.</p>' + sentHtml() + '</div>';
    return h + (res ? '<p class="' + (res === 'correct' ? 'pl-ok' : 'pl-bad') + '">' + (res === 'correct' ? 'You got it!' : 'Not this time.') + '</p>' : '<p>Responses are revealed from the lowest score up.</p>') + sentHtml() + '</div>';
  }

  /* ------------------------------------------------------------------ Final Jeopardy response */

  // The response being written. The form is built once per clue and left alone by later renders,
  // so typing and handwriting survive the live updates.
  var fr = { mode: 'type', text: '', pad: null, sent: null, dirty: false, err: '', active: false };

  function resetResponse() { fr = { mode: 'type', text: '', pad: null, sent: null, dirty: false, err: '', active: false }; }

  function responseForm() {
    var write = fr.mode === 'write';
    return '<form id="pl-fresp" class="pl-wager pl-fresp" autocomplete="off">' +
      '<div class="pl-tabs" role="tablist"><button type="button" class="pl-tab' + (write ? '' : ' on') + '" data-pl="fr-type" role="tab">Type it</button>' +
      '<button type="button" class="pl-tab' + (write ? ' on' : '') + '" data-pl="fr-write" role="tab">Write it</button></div>' +
      '<div id="pl-fr-typebox"' + (write ? ' hidden' : '') + '><label for="pl-fr-text">Your response</label>' +
      '<input id="pl-fr-text" class="pl-input" maxlength="200" placeholder="What is&hellip;" value="' + esc(fr.text) + '" spellcheck="false"></div>' +
      '<div id="pl-fr-writebox"' + (write ? '' : ' hidden') + '><div class="pl-padwrap"><canvas id="pl-fr-pad" class="pl-pad pl-pad-lg" aria-label="Write your response with your finger or mouse"></canvas>' +
      '<span class="pl-padhint">Write your response here</span><button type="button" class="pl-link pl-padclear" data-pl="fr-clear">Clear</button></div></div>' +
      '<button class="pl-btn" type="submit" id="pl-fr-send">' + (fr.sent ? 'Update my response' : 'Lock in response') + '</button>' +
      '<p class="pl-note pl-left" id="pl-fr-status">' + responseStatus() + '</p></form>';
  }

  function responseStatus() {
    var err = view && view.ferrors && view.ferrors[me.slot];
    if (fr.err || err) return '<span class="pl-err">' + esc(fr.err || err) + '</span>';
    if (fr.sent && !fr.dirty) return '<span class="pl-ok">&#10003; Locked in.</span> You can change it until time runs out.';
    if (fr.sent) return 'Not sent yet &mdash; tap Update. Whatever is here when time runs out is sent for you.';
    return 'Only the host sees it. Whatever is here when time runs out is sent for you.';
  }

  function sentHtml() {
    var r = fr.sent;
    if (!r) return '<p class="pl-note">No response was sent from this device.</p>';
    return '<div class="pl-sent"><span>Your response</span>' + (r.ink ? '<img src="' + esc(r.ink) + '" alt="Your handwritten response">' : '<b>' + esc(r.text) + '</b>') + '</div>';
  }

  function responseDraft() {
    if (fr.mode === 'write') {
      var ink = fr.pad && fr.pad.inked() ? fr.pad.png(160, 640) : '';
      return ink ? { text: '', ink: ink } : null;
    }
    var text = (fr.text || '').trim();
    return text ? { text: text, ink: '' } : null;
  }

  function sendResponse(auto) {
    var d = responseDraft();
    if (!d) { if (!auto) { fr.err = fr.mode === 'write' ? 'Write your response in the box first.' : 'Type your response first.'; responseRefresh(); } return; }
    fr.err = '';
    api('POST', '/api/rooms/' + encodeURIComponent(me.code) + '/response', { token: me.token, text: d.text, ink: d.ink })
      .then(function () { fr.sent = d; fr.dirty = false; render(); })
      .catch(function (e) { fr.err = e.message; render(); });
  }

  /* Refresh the status line and button in place (never the inputs). */
  function responseRefresh() {
    var st = $('pl-fr-status'), btn = $('pl-fr-send');
    if (st) st.innerHTML = responseStatus();
    if (btn) btn.textContent = fr.sent ? 'Update my response' : 'Lock in response';
  }

  function setResponseMode(mode) {
    fr.mode = mode;
    var tb = $('pl-fr-typebox'), wb = $('pl-fr-writebox');
    if (!tb || !wb) return;
    tb.hidden = mode !== 'type';
    wb.hidden = mode !== 'write';
    root.querySelectorAll('.pl-tab').forEach(function (t) { t.classList.toggle('on', t.dataset.pl === 'fr-' + mode); });
    fr.dirty = true;
    fr.err = '';
    if (mode === 'write' && !fr.pad) fr.pad = makePad($('pl-fr-pad'), function () { fr.dirty = true; fr.err = ''; responseRefresh(); });
    if (mode === 'type') { var inp = $('pl-fr-text'); if (inp) inp.focus(); }
    responseRefresh();
  }

  /* Called on every state update: keeps the response form alive during the clue and sends an unsent
   * draft the moment time runs out (or the host ends the clock early). */
  function responseLive(v) {
    var f = v && v.phase === 'final' && v.final, eligible = f && f.eligible.indexOf(me.slot) >= 0;
    if (!f || f.step === 'category' || f.step === 'wager' || f.step === 'ready') { if (fr.sent || fr.text || fr.active) resetResponse(); return false; }
    var open = eligible && f.step === 'clue' && !f.timeUp;
    if (open) {
      if (!fr.active) return false;          // first render of the form
      responseRefresh();
      return true;                           // form already on screen: leave it untouched
    }
    if (fr.active) {
      if (fr.dirty) sendResponse(true);      // capture the draft before the form is replaced
      fr.active = false;
      fr.pad = null;
    }
    return false;
  }

  function render() {
    if (!root || !me || padOpen) return;
    var v = view, p = me.slot && playerOf(me.slot);
    if (responseLive(v)) return;
    var top = '<header class="pl-top"><div><div class="pl-me">' + (me.sig ? '<img class="pl-mysig" src="' + esc(me.sig) + '" alt="' + esc(me.name) + '">' : esc(me.name)) + '</div><div class="pl-round">' + esc(v ? v.round : 'Lobby') + '</div></div>' +
      '<div class="pl-score' + (p && p.score < 0 ? ' neg' : '') + '">' + (p ? money(p.score) : '') + '</div></header>';
    var main;
    if (v && v.phase === 'final' && v.final) main = finalPanel();
    else {
      var b = buzzer();
      main = (b.head ? '<div class="pl-head">' + esc(b.head) + '</div>' : '<div class="pl-head">&nbsp;</div>') +
        '<button type="button" class="pl-buzz is-' + b.cls + '" id="pl-buzz"' + (b.press ? '' : ' aria-disabled="true"') + '><span class="pl-big">' + esc(b.big) + '</span><span class="pl-small">' + esc(b.small) + '</span></button>';
    }
    var list = (started && v ? v.players : roster).map(function (q) {
      var mine = started ? q.id === me.slot : q.id === me.id;
      return '<li class="' + (mine ? 'mine' : '') + '"><span>' + esc(q.name) + '</span>' + (started && v ? '<b>' + money(q.score) + '</b>' : '') + '</li>';
    }).join('');
    var lobby = !started ? '<p class="pl-note">You&rsquo;re in! Waiting for the host to start the game&hellip;</p>' +
      '<button type="button" class="pl-btn pl-btn-ghost" data-pl="pad-open">' + (me.sig ? 'Rewrite my podium name' : 'Write my name on my podium') + '</button>' : '';
    var typing = $('pl-wager-n'), typed = typing && !typing.disabled ? typing.value : null, focused = typing && document.activeElement === typing;
    root.innerHTML = '<div class="pl-shell pl-live">' + top + '<main class="pl-main">' + lobby + main + '</main>' +
      '<ul class="pl-scores">' + list + '</ul>' +
      '<footer class="pl-foot">Game ' + esc(me.code) + ' &middot; ' + (started ? '<button type="button" class="pl-link" data-pl="pad-open">Podium name</button> &middot; ' : '') + '<button type="button" class="pl-link" data-pl="leave">Leave</button></footer></div>';
    var again = $('pl-wager-n');
    if (again && typed !== null) { again.value = typed; if (focused) again.focus(); }
    if ($('pl-fresp')) {
      fr.active = true;
      if (fr.mode === 'write') fr.pad = makePad($('pl-fr-pad'), function () { fr.dirty = true; fr.err = ''; responseRefresh(); });
    }
  }

  /* ------------------------------------------------------------------ input */

  function buzz() {
    if (!me || !view || view.phase !== 'clue' || !view.clue || view.clue.dd) return;
    var k = view.clue;
    if (k.step !== 'reading' && k.step !== 'open') return;
    if (k.step === 'open' && k.locked.indexOf(me.slot) >= 0) return;
    if (buzzedAt && Date.now() - buzzedAt < 400) return;
    buzzedAt = Date.now();
    if (k.step === 'reading') {
      flash = 'early';
      clearTimeout(flashTimer);
      flashTimer = setTimeout(function () { flash = ''; render(); }, 1200);
    }
    if (navigator.vibrate) navigator.vibrate(40);
    api('POST', '/api/rooms/' + encodeURIComponent(me.code) + '/buzz', { token: me.token }).catch(function () {});
    setTimeout(render, 1600);
    render();
  }

  function onPress(e) {
    if (e.target.closest('#pl-buzz')) { e.preventDefault(); buzz(); }
  }

  function onKey(e) {
    if (!me || padOpen || $('screen-player').hidden) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) buzz(); }
  }

  function onClick(e) {
    var a = e.target.closest('[data-pl]');
    if (!a) return;
    var what = a.dataset.pl;
    if (what === 'leave' && confirm('Leave this game? You can join again with the same name.')) leave('');
    else if (what === 'pad-clear' && pad) pad.clear();
    else if (what === 'fr-type') setResponseMode('type');
    else if (what === 'fr-write') setResponseMode('write');
    else if (what === 'fr-clear' && fr.pad) fr.pad.clear();
    else if (what === 'pad-open') openPad();
    else if (what === 'pad-cancel') closePad();
    else if (what === 'pad-remove') saveSig('').then(function () { me.sig = ''; closePad(); }).catch(function (err) { showErr(err.message); });
    else if (what === 'pad-save') {
      if (!pad || !pad.inked()) { showErr('Write your name in the box first.'); return; }
      var sig = pad.png();
      saveSig(sig).then(function () { me.sig = sig; closePad(); }).catch(function (err) { showErr(err.message); });
    }
  }

  function wager() {
    var inp = $('pl-wager-n');
    if (!inp || inp.value === '') return;
    api('POST', '/api/rooms/' + encodeURIComponent(me.code) + '/wager', { token: me.token, amount: Number(inp.value) })
      .then(function () { inp.disabled = true; })
      .catch(function (err) { alert(err.message); });
  }

  global.FJPlayer = { mount: mount };
})(window);

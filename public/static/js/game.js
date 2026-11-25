/* The game screen: renders the engine state as a TV-style board and handles keys, clicks, timers and dialogs. */
(function (global) {
  'use strict';

  var E = global.JeopardyEngine, S = global.FJSound, FJ = global.FJ, esc = FJ.esc, money = FJ.money;
  var $ = function (id) { return document.getElementById(id); };

  var engine = null, chan = null, raf = 0;
  var introToken = 0, lastBoardKey = '', pendingZoom = null;
  var saveTimer = 0, autoTimer = 0, readSig = '', wagerCover = null, confettiRun = 0, onExit = null;
  var media = { key: '', el: null, info: null }, pendingThink = false, link = null;

  /* ------------------------------------------------------------------ lifecycle */

  function start(cfg, exitFn) {
    onExit = exitFn;
    attach(E.create(cfg));
  }

  function resume(json, exitFn) {
    onExit = exitFn;
    attach(E.restore(json));
    if (engine.s.phase === 'final' && engine.s.final.step === 'clue') {
      if (hasSoundMedia(engine.s)) pendingThink = true; else S.thinkStart();
    }
  }

  function attach(e) {
    engine = e;
    lastBoardKey = '';
    readSig = '';
    wagerCover = null;
    document.body.classList.remove('ui');
    document.body.classList.add('in-game');
    ['screen-setup', 'screen-admin', 'screen-host'].forEach(function (id) { $(id).hidden = true; });
    $('screen-game').hidden = false;
    engine.on(render);
    engine.onCue(onCue);
    connectRoom();
    if (localStorage.getItem(MOD_KEY)) modOpen().catch(function () {});
    applySound();
    if (!chan && global.BroadcastChannel) {
      chan = new BroadcastChannel(FJ.CHANNEL);
      chan.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.t === 'hello') broadcast();
        else if (m.t === 'cmd' && engine) exec(m.name, m.args || []);
      };
    }
    S.unlock();
    render(engine.s);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  /* Players on their own devices: their buzzes and Final wagers come in through the room link. */
  function connectRoom() {
    if (link) link.stop();
    link = null;
    var room = engine.s.room, tag = $('fj-join');
    tag.hidden = !room;
    if (!room) return;
    tag.innerHTML = 'Join <b>' + esc(room.code) + '</b>';
    tag.title = 'Players join at ' + global.FJRemote.joinLink(room.code);
    link = new global.FJRemote.Link(engine, {
      buzz: function (pid) {
        var s = engine.s;
        if (s.phase === 'clue' && s.clue && !s.clue.dd) ringIn(pid);
      },
      finalWager: function (pid, n) {
        var err = engine.finalWager(pid, n);
        if (!err) wagerCover = null;
        return err;
      },
      finalResponse: function (pid, resp) { return engine.finalResponse(pid, resp); },
      onRoster: function () { if (engine) render(engine.s); }
    });
    engine.on(function () { if (link) { link.settleWagers(); link.push(); } });
    link.start();
  }

  function stop() {
    if (link) { link.stop(); link = null; }
    cancelAnimationFrame(raf);
    clearTimeout(autoTimer);
    introToken++;
    S.thinkStop();
    if (global.speechSynthesis) speechSynthesis.cancel();
    stopConfetti();
    dropMedia();
    pendingThink = false;
    engine = null;
    modPush();
    $('screen-game').hidden = true;
    document.body.classList.remove('in-game');
    document.body.classList.add('ui');
    if (chan) chan.postMessage({ t: 'state', s: null });
  }

  function applySound() {
    var o = engine.s.opts, think = o.thinkMusic && FJ.mediaInfo(o.thinkMusic);
    S.setEnabled(o.sound);
    S.setVolume(o.volume);
    S.setThinkTrack(think && think.kind === 'audio' ? think.src : '');
  }

  /* ------------------------------------------------------------------ persistence + sync */

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (!engine) return;
      try {
        if (engine.s.phase === 'over') localStorage.removeItem(FJ.SAVE_KEY);
        else localStorage.setItem(FJ.SAVE_KEY, JSON.stringify(engine.s));
      } catch (e) { /* storage unavailable: the game still plays, it just cannot be resumed */ }
    }, 250);
  }

  function broadcast() {
    if (!chan || !engine) return;
    var copy = Object.assign({}, engine.s);
    delete copy.history;
    chan.postMessage({ t: 'state', s: copy, canUndo: engine.canUndo() });
  }

  /* ---- moderator answer feed: a link the moderator opens on any device to see the current answer ---- */

  var MOD_KEY = 'fj.modfeed.v1';
  var mod = { keys: null, sent: '', busy: false, again: false, ready: null };

  function modLink(k) { return location.origin + location.pathname + '?mod=' + encodeURIComponent(k.id) + '&k=' + encodeURIComponent(k.viewKey); }

  /* Opens (or after an app restart, recreates) this browser's feed. Resolves with its keys. */
  function modOpen() {
    if (mod.ready) return mod.ready;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(MOD_KEY) || 'null'); } catch (e) { saved = null; }
    mod.ready = global.FJRemote.api('POST', '/api/mod', saved || {}).then(function (k) {
      mod.keys = k;
      mod.sent = '';
      try { localStorage.setItem(MOD_KEY, JSON.stringify(k)); } catch (e) { /* link just won't survive a reload */ }
      modPush();
      return k;
    }, function (err) {
      mod.ready = null;
      if (err.status === 403) localStorage.removeItem(MOD_KEY);
      throw err;
    });
    return mod.ready;
  }

  function modState() {
    if (!engine) return { phase: 'none' };
    var s = engine.s, p = { title: s.title, round: FJ.roundLabel(s), phase: s.phase };
    p.players = s.players.map(function (q) { return { name: q.name, score: q.score }; });
    var k = s.clue;
    if (s.phase === 'clue' && k) {
      var cell = engine.cell(k.c, k.r);
      p.clue = {
        category: engine.board().categories[k.c], value: k.value, dd: !!k.dd, wager: k.wager,
        text: cell.clue, answer: cell.answer, media: cell.media || '', step: k.step, reading: !!k.reading,
        answerer: k.answerer ? nameOf(k.answerer) : '', winner: k.winner ? nameOf(k.winner) : '', outcome: k.outcome || ''
      };
    } else if (s.phase === 'final' && s.finalClue) {
      p.final = { category: s.finalClue.category, text: s.finalClue.clue, answer: s.finalClue.answer, step: s.final ? s.final.step : '' };
      if (s.final && s.room) {
        // Typed responses only: handwriting is too big for the feed and shows on the main screen and host console.
        p.final.responses = s.final.eligible.map(function (id) {
          var r = s.fresp && s.fresp[id];
          return { name: nameOf(id), text: r ? r.text.slice(0, 200) : '', ink: !!(r && r.ink), sent: !!r };
        });
        p.final.judging = s.final.step === 'reveal' ? nameOf(s.final.order[s.final.ri]) : '';
      }
    }
    return p;
  }

  function modPush() {
    if (!mod.keys) return;
    if (mod.busy) { mod.again = true; return; }
    var body = JSON.stringify(modState());
    if (body === mod.sent) return;
    mod.busy = true;
    fetch('/api/mod/' + encodeURIComponent(mod.keys.id) + '/state?key=' + encodeURIComponent(mod.keys.hostKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
    }).then(function (r) {
      if (r.ok) mod.sent = body;
      else if (r.status === 404) { mod.keys = null; mod.ready = null; modOpen().catch(function () {}); }
    }).catch(function () { /* offline: the next change retries */ }).then(function () {
      mod.busy = false;
      if (mod.again) { mod.again = false; modPush(); }
    });
  }

  function openModDialog() {
    var dlg = $('dlg-mod');
    var paint = function (inner) {
      dlg.innerHTML = '<div class="dlg-h"><h2>Moderator answers</h2><button class="dlg-x" type="button" data-close>&times;</button></div><div class="dlg-b">' + inner + '</div>';
    };
    paint('<p>Connecting&hellip;</p>');
    if (!dlg.open) dlg.showModal();
    modOpen().then(function (k) {
      var url = modLink(k);
      paint('<p>Open this link on the moderator&rsquo;s screen (another monitor, laptop, tablet or phone). It shows the clue being read and its correct response, and follows the game live. Keep it away from the players.</p>' +
        '<div class="wager-row"><input id="mod-link" class="text-input mod-link" readonly value="' + esc(url) + '"></div>' +
        '<div class="dlg-actions"><button type="button" class="btn btn-primary" data-mod="copy">Copy link</button>' +
        '<button type="button" class="btn" data-mod="open">Open in a new window</button>' +
        '<button type="button" class="btn" data-mod="reset">Make a new link</button></div>' +
        '<p class="mod-note">The link stays the same for every game you run in this browser. &ldquo;Make a new link&rdquo; stops the old one from updating.</p>');
    }, function (err) { paint('<p>Could not create the moderator link: ' + esc(err.message) + '</p>'); });
  }

  function onModDialogClick(e) {
    var b = e.target.closest('[data-mod]');
    if (!b) return;
    var inp = $('mod-link'), what = b.dataset.mod;
    if (what === 'copy' && inp) {
      inp.select();
      var copied = function () { b.textContent = 'Copied!'; setTimeout(function () { b.textContent = 'Copy link'; }, 1800); };
      (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(copied,
        function () { document.execCommand('copy'); copied(); });
    } else if (what === 'open' && inp) {
      if (!window.open(inp.value, 'fj-mod', 'popup,width=900,height=700')) b.textContent = 'Pop-up blocked - copy the link instead';
    } else if (what === 'reset') {
      if (!confirm('Make a new moderator link? The current link will stop working.')) return;
      localStorage.removeItem(MOD_KEY);
      mod.keys = null; mod.ready = null;
      openModDialog();
    }
  }

  /* ------------------------------------------------------------------ commands (keys, buttons, host console) */

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.h);
    toast.h = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function nameOf(pid) { var p = engine.player(pid); return p ? p.name : ''; }

  function ringIn(pid) {
    var r = engine.buzz(pid);
    if (r === 'early') flashPod(pid, 'early');
    if (r === 'frozen') flashPod(pid, 'early');
    if (r === 'early') toast(nameOf(pid) + ' rang in early and is frozen out briefly');
    return r === 'ok';
  }

  function exec(name, a) {
    if (!engine) return false;
    var s = engine.s;
    switch (name) {
      case 'advance': return engine.advance();
      case 'open': return engine.openBuzzers();
      case 'buzz': return ringIn(a[0]);
      case 'judge': return s.phase === 'final' ? engine.finalJudge(!!a[0]) : engine.judge(!!a[0]);
      case 'skip': return engine.skipClue();
      case 'wager': { var err = engine.setWager(a[0]); if (err) toast(err); return !err; }
      case 'select': return selectTile(a[0], a[1], null);
      case 'control': return engine.setControl(a[0]);
      case 'undo': return engine.undo();
      case 'endRound': return engine.endRound();
      case 'adjust': return engine.adjustScore(a[0], a[1]);
      case 'setScore': return engine.setScore(a[0], a[1]);
      case 'finalWager': { var e2 = engine.finalWager(a[0], a[1]); if (e2) toast(e2); else wagerCover = null; return !e2; }
      case 'finalAnswer': return engine.finalShowAnswer();
      case 'setOpt': return setOpt(a[0], a[1]);
      case 'media': return toggleMedia();
      default: return false;
    }
  }

  function setOpt(key, val) {
    if (!(key in E.DEFAULT_OPTS)) return false;
    engine.s.opts[key] = val;
    var prefs = FJ.loadPrefs();
    prefs[key] = val;
    FJ.savePrefs(prefs);
    applySound();
    if (key === 'sound' && !val && global.speechSynthesis) speechSynthesis.cancel();
    render(engine.s);
    return true;
  }

  function selectTile(c, r, el) {
    if (engine.s.phase !== 'board') return false;
    pendingZoom = el ? el.getBoundingClientRect() : null;
    return engine.selectClue(c, r);
  }

  /* ------------------------------------------------------------------ rendering */

  function onCue(name, d) {
    if (name === 'thinkstart') {
      // A video or sound Final clue plays first; the think music starts when it ends.
      if (hasSoundMedia(engine.s)) pendingThink = true; else S.thinkStart();
      return;
    }
    if (name === 'thinkstop') { pendingThink = false; S.thinkStop(); return; }
    if (name === 'undo' && !(engine.s.phase === 'final' && engine.s.final.step === 'clue')) { pendingThink = false; S.thinkStop(); }
    if (name === 'timeup' && engine.s.phase === 'final') S.thinkStop();
    S.play(name, d);
  }

  function render(s) {
    if (!engine) return;
    document.body.dataset.phase = s.phase;
    renderBar(s);
    renderPodiums(s);
    if (s.phase === 'intro' || s.phase === 'board' || s.phase === 'clue' || s.phase === 'round_end') renderBoard(s);
    renderOverlay(s);
    afterRender(s);
    scheduleSave();
    broadcast();
    modPush();
  }

  function renderBar(s) {
    var label = FJ.roundLabel(s);
    $('fj-round').textContent = label;
    $('t-undo').disabled = !engine.canUndo();
    $('t-sound').innerHTML = s.opts.sound ? '&#128266;' : '&#128263;';
  }

  function podClass(s, p) {
    var k = s.clue, c = ['pod'];
    if (s.control === p.id && (s.phase === 'board' || s.phase === 'clue' || s.phase === 'intro')) c.push('is-control');
    if (k && k.answerer === p.id) c.push('is-answering');
    if (k && k.locked.indexOf(p.id) >= 0) c.push('is-locked');
    if (k && k.step === 'open' && !k.dd && k.locked.indexOf(p.id) < 0) c.push('can-ring');
    if (p.score < 0) c.push('is-neg');
    if (s.phase === 'final' && s.final) {
      if (s.final.eligible.indexOf(p.id) < 0) c.push('is-out');
      if (s.final.step === 'reveal' && s.final.order[s.final.ri] === p.id) c.push('is-answering');
    }
    if (link && link.online[p.id] === false) c.push('is-offline');
    return c.join(' ');
  }

  function renderPodiums(s) {
    var sigs = s.sigs || {};
    var html = s.players.map(function (p, i) {
      var name = sigs[p.id]
        ? '<span class="pod-name pod-sig"><img src="' + esc(sigs[p.id]) + '" alt="' + esc(p.name) + '"></span>'
        : '<span class="pod-name">' + esc(p.name) + '</span>';
      return '<div class="' + podClass(s, p) + '" data-pid="' + p.id + '" style="--pc:var(--pc' + (i % 6) + ')">' +
        '<button class="pod-main" type="button" data-act="pod" data-pid="' + p.id + '" aria-label="' + esc(p.name) + ', ' + money(p.score) + '">' +
        name +
        '<span class="pod-score">' + money(p.score) + '</span></button>' +
        '<span class="pod-key" title="Ring-in key">' + (i + 1) + '</span>' +
        '<span class="pod-tag">PICKS</span>' +
        '<button class="pod-edit" type="button" data-act="score" data-pid="' + p.id + '" title="Adjust score" aria-label="Adjust score for ' + esc(p.name) + '">&#9998;</button>' +
        '<span class="pod-bar"><i></i></span></div>';
    }).join('');
    $('podiums').innerHTML = html;
    $('podiums').style.setProperty('--n', s.players.length);
  }

  function flashPod(pid, cls) {
    var el = document.querySelector('.pod[data-pid="' + pid + '"]');
    if (!el) return;
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 600);
  }

  /* ---- board ---- */

  function boardKey(s) {
    var b = engine.board(), sig = '';
    b.grid.forEach(function (col) { col.forEach(function (c) { sig += c ? (c.done ? '1' : '0') : 'x'; }); });
    return s.round + ':' + (s.phase === 'intro' ? 'i' : 'b') + ':' + sig;
  }

  function renderBoard(s) {
    var key = boardKey(s);
    if (key === lastBoardKey) return;
    lastBoardKey = key;
    var b = engine.board(), cols = b.categories.length, rows = b.rowValues.length;
    var html = '<div class="b-grid" style="--cols:' + cols + ';--rows:' + rows + '">';
    b.categories.forEach(function (name, c) {
      html += '<div class="b-cat" data-c="' + c + '"><span>' + esc(name) + '</span></div>';
    });
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var cell = b.grid[c][r];
        if (!cell || cell.done) html += '<div class="b-tile is-empty"></div>';
        else html += '<button class="b-tile" type="button" data-c="' + c + '" data-r="' + r + '"><span>' + money(cell.value) + '</span></button>';
      }
    }
    $('board').innerHTML = html + '</div>';
    if (s.phase === 'intro') runIntro();
  }

  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* Title card, then category names appear one by one, then the dollar tiles fill in at random. */
  function runIntro() {
    var token = ++introToken;
    var alive = function () { return token === introToken && engine && engine.s.phase === 'intro'; };
    var s = engine.s, grid = $('board');
    var cats = [].slice.call(grid.querySelectorAll('.b-cat')), tiles = [].slice.call(grid.querySelectorAll('.b-tile'));
    cats.forEach(function (c) { c.classList.add('is-hidden'); });
    tiles.forEach(function (t) { t.classList.add('is-hidden'); });
    var ov = $('overlay');
    ov.hidden = false;
    ov.className = 'fj-overlay ov-title';
    ov.innerHTML = '<div class="title-card"><img src="/static/img/logo-light.svg" alt="" class="title-logo">' +
      '<div class="title-round">' + esc(FJ.roundLabel(s)) + '</div>' +
      '<div class="title-sub">' + esc(nameOf(s.control)) + ' has control of the board</div>' +
      '<div class="title-hint">Press Space to skip the intro</div></div>';
    S.play('roundend');
    wait(s.round === 0 ? 1900 : 1700).then(function () {
      if (!alive()) return;
      ov.hidden = true;
      var i = 0;
      return (function revealCats() {
        if (!alive()) return;
        if (i < cats.length) {
          cats[i++].classList.remove('is-hidden');
          S.play('category');
          return wait(520).then(revealCats);
        }
        var order = tiles.map(function (_, k) { return k; });
        for (var j = order.length - 1; j > 0; j--) { var r = Math.floor(Math.random() * (j + 1)); var t = order[j]; order[j] = order[r]; order[r] = t; }
        var n = 0;
        var per = Math.max(18, Math.min(60, 2200 / Math.max(1, order.length)));
        return (function fill() {
          if (!alive()) return;
          if (n < order.length) {
            tiles[order[n]].classList.remove('is-hidden');
            if (n % 2 === 0) S.play('fill', { i: n % 12 });
            n++;
            return wait(per).then(fill);
          }
          return wait(450).then(function () { if (alive()) engine.startBoard(); });
        })();
      })();
    });
  }

  /* ---- overlay ---- */

  function btn(act, label, kbd, cls, data) {
    return '<button type="button" class="ov-btn ' + (cls || '') + '" data-act="' + act + '"' + (data || '') + '>' + label + (kbd ? ' <kbd>' + kbd + '</kbd>' : '') + '</button>';
  }

  function controls(s, html) {
    return s.opts.hideHostControls ? '' : '<div class="ov-controls">' + html + '</div>';
  }

  function lightsHtml() {
    var h = '<div class="lights" id="lights">';
    for (var i = 0; i < 9; i++) h += '<i></i>';
    return h + '</div>';
  }

  function renderOverlay(s) {
    var ov = $('overlay');
    if (s.phase === 'intro') return;
    if (s.phase === 'board') { ov.hidden = true; ov.className = 'fj-overlay'; ov.innerHTML = ''; dropMedia(); return; }
    var html = '', cls = 'fj-overlay';
    if (s.phase === 'clue') { html = clueHtml(s); cls += ' ov-clue-wrap step-' + s.clue.step + (s.clue.dd ? ' is-dd' : ''); }
    else if (s.phase === 'round_end') { html = roundEndHtml(s); cls += ' ov-card-wrap'; }
    else if (s.phase === 'final') { html = finalHtml(s); cls += ' ov-card-wrap final-' + s.final.step; }
    else if (s.phase === 'over') { html = overHtml(s); cls += ' ov-card-wrap'; }
    var wasHidden = ov.hidden;
    var prevStep = ov.dataset.step;
    var step = s.phase + ':' + (s.clue ? s.clue.step : s.final ? s.final.step : '');
    if (wantedMedia(s)) cls += ' has-media';
    ov.className = cls;
    ov.innerHTML = html;
    ov.hidden = false;
    ov.dataset.step = step;
    syncMedia(s);
    if (s.phase === 'clue' && pendingZoom && s.clue.step !== 'reveal') zoomIn(pendingZoom);
    pendingZoom = null;
    if (s.phase === 'over' && prevStep !== step) startConfetti();
    if (wasHidden || prevStep !== step) focusFirst(ov);
  }

  function focusFirst(ov) {
    var input = ov.querySelector('input');
    if (input) { setTimeout(function () { input.focus(); input.select(); }, 30); }
  }

  function zoomIn(rect) {
    var ov = $('overlay'), st = $('stage').getBoundingClientRect();
    var from = 'inset(' + (rect.top - st.top) + 'px ' + (st.right - rect.right) + 'px ' + (st.bottom - rect.bottom) + 'px ' + (rect.left - st.left) + 'px)';
    if (ov.animate) ov.animate([{ clipPath: from, opacity: 0.5 }, { clipPath: 'inset(0px 0px 0px 0px)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  /* ---- media clues (picture / video / sound) ----
   * The overlay is rebuilt on every state change, so the media lives in its own layer laid over the
   * overlay's .ov-media-slot. That keeps a video playing (and a YouTube frame loaded) through buzz-ins. */

  var MEDIA_STEPS = { reading: 1, open: 1, answering: 1, reveal: 1 };

  function wantedMedia(s) {
    if (s.phase === 'clue' && s.clue && MEDIA_STEPS[s.clue.step]) {
      var cell = engine.cell(s.clue.c, s.clue.r);
      if (cell && s.clue.step === 'reveal' && cell.answerMedia) {
        return { key: s.clue.id + '|answer|' + cell.answerMedia, ref: cell.answerMedia, autoplay: true, answer: true };
      }
      return cell && cell.media ? { key: s.clue.id + '|' + cell.media, ref: cell.media, autoplay: s.clue.step === 'reading' || !!s.clue.reading } : null;
    }
    if (s.phase === 'final' && s.final && s.final.step === 'clue' && s.finalClue && s.finalClue.media) {
      return { key: 'final|' + s.finalClue.media, ref: s.finalClue.media, autoplay: true };
    }
    if (s.phase === 'final' && s.final && s.final.answerShown && s.finalClue && s.finalClue.answerMedia) {
      return { key: 'final|answer|' + s.finalClue.answerMedia, ref: s.finalClue.answerMedia, autoplay: true, answer: true };
    }
    return null;
  }

  function playable() { return media.el && media.el.querySelector('video,audio'); }

  function buildMedia(info) {
    var box = document.createElement('div');
    box.className = 'fj-media-box kind-' + info.kind;
    var el;
    if (info.kind === 'image') {
      el = document.createElement('img');
      el.alt = '';
    } else if (info.kind === 'embed') {
      el = document.createElement('iframe');
      el.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
      el.referrerPolicy = 'strict-origin-when-cross-origin';
    } else {
      el = document.createElement(info.kind);
      el.controls = true;
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      el.addEventListener('ended', onMediaEnded);
    }
    el.addEventListener('error', function () {
      box.innerHTML = '<div class="fj-media-missing">Media not available: ' + esc(info.name) + '</div>';
    });
    el.src = info.src;
    box.appendChild(el);
    return box;
  }

  function dropMedia() {
    var v = playable();
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    media = { key: '', el: null, info: null };
    var layer = $('media-layer');
    layer.innerHTML = '';
    layer.hidden = true;
  }

  function syncMedia(s) {
    var want = wantedMedia(s), slot = $('overlay').querySelector('.ov-media-slot');
    if (!want || !slot) { if (media.key) dropMedia(); return; }
    var layer = $('media-layer');
    if (media.key !== want.key) {
      dropMedia();
      var info = FJ.mediaInfo(want.ref);
      if (!info) return;
      media = { key: want.key, el: buildMedia(info), info: info };
      layer.appendChild(media.el);
      layer.hidden = false;
      var v = playable();
      if (v && want.autoplay) v.play().catch(function () { /* autoplay blocked: the host presses play or P */ });
    }
    var v2 = playable();
    if (v2 && !want.answer && s.phase === 'clue' && ((s.clue.step === 'answering' && !s.clue.reading) || s.clue.step === 'reveal') && !v2.paused) v2.pause();
    placeMedia();
  }

  function placeMedia() {
    var slot = $('overlay').querySelector('.ov-media-slot'), layer = $('media-layer');
    if (!slot || !media.el) return;
    var st = $('stage').getBoundingClientRect(), r = slot.getBoundingClientRect();
    layer.style.left = (r.left - st.left) + 'px';
    layer.style.top = (r.top - st.top) + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';
  }

  function toggleMedia() {
    var v = playable();
    if (!v) return false;
    if (v.paused) v.play().catch(function () {}); else v.pause();
    return true;
  }

  function hasSoundMedia(s) {
    var w = wantedMedia(s), info = w && FJ.mediaInfo(w.ref);
    return !!info && info.kind !== 'image';
  }

  function onMediaEnded() {
    if (!engine) return;
    var s = engine.s;
    if (s.phase === 'clue' && s.clue && s.clue.reading) {
      autoTimer = setTimeout(function () { if (engine && engine.s.clue && engine.s.clue.reading) engine.finishReading(); }, 350);
    } else if (s.phase === 'clue' && s.clue && s.clue.step === 'reading' && s.opts.autoOpen) {
      autoTimer = setTimeout(function () { if (engine && engine.s.clue && engine.s.clue.step === 'reading') engine.openBuzzers(); }, 350);
    }
    if (pendingThink && s.phase === 'final' && s.final.step === 'clue') { pendingThink = false; S.thinkStart(); }
  }

  function clueHtml(s) {
    var k = s.clue, b = engine.board(), cell = engine.cell(k.c, k.r), cat = b.categories[k.c];
    var val = k.dd ? 'DAILY DOUBLE' + (k.wager != null ? ' &middot; ' + money(k.wager) : '') : money(k.value);
    var head = '<div class="ov-meta"><span class="ov-cat">' + esc(cat) + '</span><span class="ov-val">' + val + '</span></div>';
    var who = k.dd ? nameOf(s.control) : '';

    if (k.step === 'dd_splash') {
      return head + '<div class="dd-splash"><img src="/static/img/logo-light.svg" alt="" class="dd-logo"><div class="dd-title">DAILY DOUBLE</div>' +
        '<div class="dd-sub">' + esc(who) + ', this one is yours.</div></div>' +
        controls(s, btn('advance', 'Continue', 'Space', 'primary'));
    }
    if (k.step === 'dd_wager') {
      var p = engine.player(s.control), max = engine.ddMax();
      return head + '<div class="ov-wager"><div class="wager-h">' + esc(who) + ', make your wager</div>' +
        '<div class="wager-sub">Your score is <b>' + money(p.score) + '</b>. Wager from <b>' + money(E.DD_MIN) + '</b> up to <b>' + money(max) + '</b>.</div>' +
        '<div class="wager-row"><input id="wager-input" class="wager-input" type="number" inputmode="numeric" min="' + E.DD_MIN + '" max="' + max + '" step="5" placeholder="$"> ' +
        btn('wager', 'Lock in wager', 'Enter', 'primary') + btn('wager-max', 'True Daily Double (' + money(max) + ')', '', '') + '</div></div>' +
        controls(s, btn('skip', 'Skip clue', 'R', 'ghost'));
    }

    var showSlot = cell.media || (k.step === 'reveal' && cell.answerMedia);
    var body = (showSlot ? '<div class="ov-media-slot"></div>' : '') + '<div class="ov-text" id="ov-text">' + esc(cell.clue) + '</div>';
    var status = '', ctl = '';
    if (k.step === 'reading') {
      status = k.dd ? esc(who) + ', listen to the clue' : 'Listen to the clue&hellip;';
      ctl = btn('open', k.dd ? 'Start answer clock' : 'Open buzzers', 'Space', 'primary') + btn('skip', 'Skip clue', 'R', 'ghost');
    } else if (k.step === 'open') {
      status = '<span class="live">RING IN!</span> <span id="timer-text" class="timer-text"></span>';
      ctl = (k.reading ? btn('advance', 'Done reading', 'Space', 'primary') : '') + btn('skip', 'Skip clue', 'R', 'ghost');
    } else if (k.step === 'answering') {
      status = '<span class="live">' + esc(nameOf(k.answerer)) + '</span>, your response? <span id="timer-text" class="timer-text"></span>' + (k.timedOut ? ' <span class="timesup">TIME&rsquo;S UP</span>' : '');
      ctl = (k.reading ? btn('advance', 'Done reading', 'Space', 'primary') : '') + btn('judge', '&#10003; Correct', 'Y', 'good', ' data-v="1"') + btn('judge', '&#10007; Incorrect', 'N', 'bad', ' data-v="0"') + btn('skip', 'Reveal answer', 'R', 'ghost');
    } else if (k.step === 'reveal') {
      body += '<div class="ov-answer"><span class="ov-answer-l">CORRECT RESPONSE</span>' + esc(cell.answer) + '</div>';
      status = outcomeText(s);
      ctl = btn('advance', 'Continue', 'Space', 'primary');
    }
    return head + body + '<div class="ov-status" id="ov-status">' + status + '</div>' + lightsHtml() + controls(s, ctl);
  }

  function outcomeText(s) {
    var k = s.clue;
    if (k.outcome === 'correct') {
      var last = k.log[k.log.length - 1];
      return '<span class="good-t">' + esc(nameOf(k.winner)) + ' is correct! +' + money(last.amount) + '</span> &middot; ' + esc(nameOf(k.winner)) + ' picks next';
    }
    if (k.outcome === 'wrong') {
      var l2 = k.log[k.log.length - 1];
      return '<span class="bad-t">Sorry, ' + esc(nameOf(l2.pid)) + ' &minus;' + money(l2.amount) + '</span>';
    }
    if (k.dd && !k.log.length) return 'Daily Double skipped &middot; ' + esc(nameOf(s.control)) + ' still has control';
    return k.log.length ? 'Nobody got it &middot; ' + esc(nameOf(s.control)) + ' still has control' : 'No one rang in &middot; ' + esc(nameOf(s.control)) + ' still has control';
  }

  function standingsHtml(s, sorted) {
    var list = s.players.slice();
    if (sorted) list.sort(function (a, b) { return b.score - a.score; });
    return '<ol class="stand">' + list.map(function (p) {
      return '<li class="' + (p.score < 0 ? 'neg' : '') + '"><span>' + esc(p.name) + '</span><b>' + money(p.score) + '</b></li>';
    }).join('') + '</ol>';
  }

  function roundEndHtml(s) {
    var more = s.round + 1 < s.boards.length;
    var next = more ? s.boards[s.round + 1].name : 'Final Jeopardy';
    var low = engine.lowestPlayers().map(nameOf).join(' / ');
    return '<div class="card-big"><div class="cb-kicker">END OF ' + esc(engine.board().name.toUpperCase()) + '</div>' + standingsHtml(s, false) +
      '<div class="cb-note">' + (more ? 'Up next: <b>' + esc(next) + '</b>. ' + esc(low) + ' has the lowest score and picks first.' : 'Up next: <b>Final Jeopardy</b>. Only players with a positive score may play.') + '</div>' +
      controls(s, btn('advance', 'Start ' + esc(next), 'Space', 'primary') + btn('undo', 'Undo', 'U', 'ghost')) + '</div>';
  }

  /* A player's Final response from their device: their handwriting, or what they typed. */
  function responseHtml(s, pid) {
    var r = s.fresp && s.fresp[pid];
    if (!r) return '<div class="fin-resp is-none">No response</div>';
    if (r.ink) return '<div class="fin-resp is-ink"><img src="' + esc(r.ink) + '" alt="Handwritten response"></div>';
    return '<div class="fin-resp">' + esc(r.text) + '</div>';
  }

  function finalHtml(s) {
    var f = s.final, fc = s.finalClue, p;
    var names = f.eligible.map(nameOf).map(esc).join(', ');
    switch (f.step) {
      case 'category':
        return '<div class="card-big final"><div class="cb-kicker">FINAL JEOPARDY</div><div class="fin-cat">' + esc(fc.category) + '</div>' +
          '<div class="cb-note">Playing: <b>' + names + '</b></div>' + controls(s, btn('advance', 'Collect wagers', 'Space', 'primary')) + '</div>';
      case 'wager': {
        var pid = f.eligible[f.wi]; p = engine.player(pid);
        if (link && wagerCover !== pid) {
          var got = f.eligible.map(function (id) {
            var done = id in f.wagers || id in link.pendingWagers;
            return '<li class="' + (done ? 'done' : '') + '">' + (done ? '&#10003; ' : '&hellip; ') + esc(nameOf(id)) + '</li>';
          }).join('');
          return '<div class="card-big final"><div class="cb-kicker">FINAL JEOPARDY &middot; ' + esc(fc.category) + '</div>' +
            '<div class="cb-note">Players: enter your secret wager on your device.</div><ul class="remote-wagers">' + got + '</ul>' +
            '<div class="ov-controls">' + btn('cover-off', 'Enter ' + esc(p.name) + '&rsquo;s wager here', '', 'ghost', ' data-pid="' + pid + '"') + '</div></div>';
        }
        if (wagerCover !== pid) {
          return '<div class="card-big final"><div class="cb-kicker">FINAL JEOPARDY &middot; ' + esc(fc.category) + '</div><div class="fin-who">' + esc(p.name) + '</div>' +
            '<div class="cb-note">Wager in private. Everyone else, look away.<br>(' + (f.wi + 1) + ' of ' + f.eligible.length + ')</div>' +
            '<div class="ov-controls">' + btn('cover-off', 'I&rsquo;m ' + esc(p.name) + ' &mdash; show my wager box', '', 'primary', ' data-pid="' + pid + '"') + '</div></div>';
        }
        return '<div class="card-big final"><div class="cb-kicker">FINAL JEOPARDY &middot; ' + esc(fc.category) + '</div><div class="fin-who">' + esc(p.name) + '</div>' +
          '<div class="cb-note">You have <b>' + money(p.score) + '</b>. Wager $0 to ' + money(p.score) + '.</div>' +
          '<div class="wager-row"><input id="fwager-input" class="wager-input" type="password" inputmode="numeric" autocomplete="off" placeholder="Wager" data-pid="' + pid + '"> ' +
          btn('fwager', 'Lock in', 'Enter', 'primary', ' data-pid="' + pid + '"') + '</div></div>';
      }
      case 'ready':
        return '<div class="card-big final"><div class="cb-kicker">FINAL JEOPARDY</div><div class="fin-cat">' + esc(fc.category) + '</div>' +
          '<div class="cb-note">All wagers are locked in.</div>' + controls(s, btn('advance', 'Reveal the clue', 'Space', 'primary')) + '</div>';
      case 'clue':
        return '<div class="ov-meta"><span class="ov-cat">' + esc(fc.category) + '</span><span class="ov-val">FINAL JEOPARDY</span></div>' +
          (fc.media ? '<div class="ov-media-slot"></div>' : '') +
          '<div class="ov-text" id="ov-text">' + esc(fc.clue) + '</div>' +
          '<div class="ov-status" id="ov-status"><span id="timer-text" class="timer-text big"></span>' + (f.timeUp ? ' <span class="timesup">TIME&rsquo;S UP &mdash; pens down</span>' : '') + '</div>' +
          '<div class="final-bar"><i id="final-bar"></i></div>' +
          (link ? '<ul class="remote-wagers fin-answered">' + f.eligible.map(function (id) {
            var done = !!(s.fresp && s.fresp[id]);
            return '<li class="' + (done ? 'done' : '') + '">' + (done ? '&#10003; ' : '&hellip; ') + esc(nameOf(id)) + '</li>';
          }).join('') + '</ul>' : '') +
          controls(s, btn('advance', f.timeUp ? 'Reveal answers' : 'End timer &amp; reveal', 'Space', 'primary'));
      case 'reveal':
      case 'done': {
        var done = f.step === 'done';
        var cur = done ? null : engine.player(f.order[f.ri]);
        var h = '<div class="card-big final"><div class="cb-kicker">FINAL JEOPARDY &middot; ' + esc(fc.category) + '</div><div class="fin-clue">' + esc(fc.clue) + '</div>';
        h += f.answerShown ? '<div class="ov-answer"><span class="ov-answer-l">CORRECT RESPONSE</span>' + esc(fc.answer) + '</div>' +
          (fc.answerMedia ? '<div class="ov-media-slot fin-media"></div>' : '') : '';
        if (!done) {
          h += '<div class="fin-who">' + esc(cur.name) + '</div>';
          if (!f.shown) {
            h += '<div class="cb-note">Ready to reveal ' + esc(cur.name) + '&rsquo;s response and wager?</div>' +
              controls(s, btn('advance', 'Reveal response &amp; wager', 'Space', 'primary') + (f.answerShown ? '' : btn('final-answer', 'Show correct response', 'A', 'ghost')));
          } else {
            h += (s.room ? responseHtml(s, cur.id) : '') + '<div class="cb-note">Wagered <b>' + money(f.wagers[cur.id] || 0) + '</b></div>' +
              controls(s, btn('judge', '&#10003; Correct', 'Y', 'good', ' data-v="1"') + btn('judge', '&#10007; Incorrect', 'N', 'bad', ' data-v="0"') + (f.answerShown ? '' : btn('final-answer', 'Show correct response', 'A', 'ghost')));
          }
        } else {
          h += controls(s, btn('advance', 'See final results', 'Space', 'primary'));
        }
        h += '<div class="fin-mini">' + standingsHtml(s, false) + '</div></div>';
        return h;
      }
    }
    return '';
  }

  function overHtml(s) {
    var w = engine.winners();
    var title = w.length > 1 ? 'IT&rsquo;S A TIE' : 'CHAMPION';
    return '<div class="card-big champion"><img src="/static/img/logo-light.svg" alt="" class="title-logo"><div class="cb-kicker">' + title + '</div>' +
      '<div class="champ-name">' + w.map(function (p) { return esc(p.name); }).join(' &amp; ') + '</div>' +
      '<div class="champ-score">' + money(w[0].score) + '</div>' + standingsHtml(s, true) +
      '<div class="ov-controls">' + btn('exit', 'Back to lobby', '', 'primary') + btn('undo', 'Undo last judgment', 'U', 'ghost') + '</div></div>';
  }

  /* ---- reading: read aloud / auto-open ---- */

  /* Prefer neural voices (Edge "Natural", Google) over the robotic built-in desktop voices. */
  function pickVoice() {
    if (!global.speechSynthesis) return null;
    var top = -1, best = null, chosen = FJ.loadPrefs().voice;
    speechSynthesis.getVoices().forEach(function (v) {
      if (chosen && v.name === chosen) { top = Infinity; best = v; return; }
      if (!/^en/i.test(v.lang)) return;
      var sc = FJ.voiceScore(v);
      if (sc > top) { top = sc; best = v; }
    });
    return best;
  }
  if (global.speechSynthesis) speechSynthesis.getVoices();

  function afterRender(s) {
    var k = s.clue;
    var reading = s.phase === 'clue' && k && (k.step === 'reading' || (k.reading && (k.step === 'open' || k.step === 'answering')));
    var sig = reading ? k.id + ':' + (k.wager || 0) : '';
    if (sig === readSig) return;
    clearTimeout(autoTimer);
    if (global.speechSynthesis) speechSynthesis.cancel();
    readSig = sig;
    if (!sig) return;
    var text = engine.cell(k.c, k.r).clue;
    // Video and sound clues carry their own reading; auto-open then waits for the media to end.
    if (hasSoundMedia(s)) return;
    var done = function () {
      if (!engine || !engine.s.clue) return;
      if (engine.s.clue.reading) engine.finishReading();
      else if (engine.s.clue.step === 'reading') engine.openBuzzers();
    };
    var open = function () { autoTimer = setTimeout(done, 350); };
    var auto = s.opts.autoOpen || k.reading;
    if (s.opts.readAloud && s.opts.sound && global.speechSynthesis) {
      var u = new SpeechSynthesisUtterance(text);
      var v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
      u.rate = 1.12;
      u.volume = s.opts.volume;
      if (auto) { u.onend = open; u.onerror = open; }
      speechSynthesis.speak(u);
    } else if (auto) {
      autoTimer = setTimeout(done, 1400 + FJ.wordCount(text) * 380);
    }
  }

  /* ------------------------------------------------------------------ clock */

  function loop() {
    if (!engine) return;
    engine.tick();
    updateTimers();
    raf = requestAnimationFrame(loop);
  }

  function setLights(frac) {
    var el = $('lights');
    if (!el) return;
    var lit = Math.ceil(5 * Math.max(0, Math.min(1, frac)));
    var key = String(lit);
    if (el.dataset.lit === key) return;
    el.dataset.lit = key;
    [].forEach.call(el.children, function (i, idx) { i.classList.toggle('on', Math.abs(idx - 4) < lit); });
  }

  function updateTimers() {
    var s = engine.s, t = Date.now(), o = s.opts, k = s.clue;
    if (s.phase === 'clue' && k) {
      var tt = $('timer-text');
      if (k.step === 'open') {
        var f = k.deadline ? (k.deadline - t) / (o.buzzSeconds * 1000) : 0;
        setLights(f);
        if (tt) tt.textContent = k.deadline ? Math.ceil((k.deadline - t) / 1000) : '';
      } else {
        setLights(0);
        if (k.step === 'answering') {
          var total = (k.dd ? o.ddSeconds : o.answerSeconds) * 1000;
          var fr = k.deadline ? Math.max(0, (k.deadline - t) / total) : 0;
          if (tt) tt.textContent = k.deadline ? Math.ceil((k.deadline - t) / 1000) : '';
          var bar = document.querySelector('.pod[data-pid="' + k.answerer + '"] .pod-bar i');
          if (bar) bar.style.transform = 'scaleX(' + fr + ')';
        }
      }
    } else if (s.phase === 'final' && s.final && s.final.step === 'clue') {
      var left = s.final.deadline ? Math.max(0, s.final.deadline - t) : 0;
      var tx = $('timer-text'), fb = $('final-bar');
      if (tx) tx.textContent = s.final.deadline ? Math.ceil(left / 1000) : '0';
      if (fb) fb.style.transform = 'scaleX(' + (left / (o.finalSeconds * 1000)) + ')';
    }
  }

  /* ------------------------------------------------------------------ input */

  function onAct(act, el) {
    var s = engine.s;
    switch (act) {
      case 'advance': engine.advance(); break;
      case 'open': engine.openBuzzers(); break;
      case 'skip': engine.skipClue(); break;
      case 'undo': engine.undo(); break;
      case 'judge': exec('judge', [el.dataset.v === '1']); break;
      case 'final-answer': engine.finalShowAnswer(); break;
      case 'wager': submitWager(); break;
      case 'wager-max': exec('wager', [engine.ddMax()]); break;
      case 'cover-off': wagerCover = el.dataset.pid; render(s); break;
      case 'fwager': submitFinalWager(); break;
      case 'exit': leave(); break;
      case 'pod':
        if (s.phase === 'clue' && s.clue && !s.clue.dd) ringIn(el.dataset.pid);
        else if (s.phase === 'board' || s.phase === 'intro') exec('control', [el.dataset.pid]);
        break;
      case 'score': openScoreDialog(el.dataset.pid); break;
    }
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
  }

  function submitWager() {
    var inp = $('wager-input');
    if (inp) exec('wager', [inp.value]);
  }

  function submitFinalWager() {
    var inp = $('fwager-input');
    if (inp) exec('finalWager', [inp.dataset.pid, inp.value]);
  }

  function leave() {
    if (engine && engine.s.phase !== 'over' && !confirm('Leave this game? You can resume it from the lobby.')) return;
    stop();
    if (onExit) onExit();
  }

  function onKey(e) {
    if (!engine || $('screen-game').hidden) return;
    if (document.querySelector('dialog[open]')) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Enter') {
        if (t.id === 'wager-input') { e.preventDefault(); submitWager(); }
        else if (t.id === 'fwager-input') { e.preventDefault(); submitFinalWager(); }
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if ((e.key === 'z' || e.key === 'Z') && !e.altKey) { e.preventDefault(); engine.undo(); }
      return;
    }
    var s = engine.s, key = e.key, handled = true;
    if (key === ' ' || key === 'Spacebar') engine.advance();
    else if (key === 'y' || key === 'Y' || (key === 'Enter' && tag !== 'BUTTON')) exec('judge', [true]);
    else if (key === 'n' || key === 'N' || key === 'x' || key === 'X') exec('judge', [false]);
    else if (key === 'r' || key === 'R') { if (s.phase === 'clue') engine.skipClue(); }
    else if (key === 'a' || key === 'A') engine.finalShowAnswer();
    else if (key === 'p' || key === 'P') toggleMedia();
    else if (key === 'u' || key === 'U') engine.undo();
    else if (key === 'm' || key === 'M') setOpt('sound', !s.opts.sound);
    else if (key === 'f' || key === 'F') toggleFullscreen();
    else if (key === 'h' || key === 'H') openHost();
    else if (key === '?') openHelp();
    else if (key === 'Escape') openMenu();
    else if (/^[1-6]$/.test(key)) {
      var p = s.players[Number(key) - 1];
      if (p && s.phase === 'clue' && s.clue && !s.clue.dd) ringIn(p.id);
      else if (p && (s.phase === 'board')) exec('control', [p.id]);
    } else handled = false;
    if (handled) e.preventDefault();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  }

  function openHost() {
    var w = window.open(location.pathname + '?host=1', 'fj-host', 'popup,width=600,height=900');
    if (!w) toast('Allow pop-ups to open the host console.');
    else { engine.s.opts.hideHostControls = true; render(engine.s); toast('Host buttons are hidden on this screen. Turn them back on in the menu.'); }
  }

  /* ------------------------------------------------------------------ dialogs */

  function closeOnBackdrop(dlg) {
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  }

  function openMenu() {
    var s = engine.s, o = s.opts, dlg = $('dlg-menu');
    var tog = function (key, label) {
      return '<div class="opt-row"><span>' + label + '</span><div class="toggle-group toggle-group--small" data-set="' + key + '">' +
        '<button type="button" class="toggle-pill' + (o[key] ? ' active' : '') + '" data-v="1">On</button>' +
        '<button type="button" class="toggle-pill' + (!o[key] ? ' active' : '') + '" data-v="0">Off</button></div></div>';
    };
    var num = function (key, label, min, max) {
      return '<div class="opt-row"><label>' + label + '</label><input type="number" class="num-input" data-num="' + key + '" min="' + min + '" max="' + max + '" value="' + o[key] + '"></div>';
    };
    dlg.innerHTML = '<div class="dlg-h"><h2>Game menu</h2><button class="dlg-x" type="button" data-close>&times;</button></div><div class="dlg-b">' +
      '<div class="dlg-actions">' +
      '<button type="button" class="btn" data-m="host">Open host console (H)</button>' +
      '<button type="button" class="btn" data-m="mod">Moderator answers link</button>' +
      '<button type="button" class="btn" data-m="full">Full screen (F)</button>' +
      '<button type="button" class="btn" data-m="help">Keys &amp; rules (?)</button>' +
      '<button type="button" class="btn" data-m="scores">Adjust scores</button>' +
      (s.phase === 'board' ? '<button type="button" class="btn" data-m="endround">End this round now</button>' : '') +
      '<button type="button" class="btn" data-m="quit">Leave game</button></div>' +
      '<h3>Settings</h3>' + tog('sound', 'Sound effects') +
      '<div class="opt-row"><label>Volume</label><input type="range" min="0" max="100" value="' + Math.round(o.volume * 100) + '" data-vol></div>' +
      tog('readAloud', 'Read clues aloud') + tog('autoOpen', 'Open buzzers automatically') +
      (o.autoOpen ? tog('openImmediately', '&nbsp;&nbsp;&#8627; Open immediately (as reading starts)') : '') +
      tog('hideHostControls', 'Hide host buttons on this screen') +
      num('buzzSeconds', 'Ring-in window (s)', 2, 30) + num('answerSeconds', 'Time to answer (s)', 2, 60) +
      num('ddSeconds', 'Daily Double answer time (s)', 5, 60) + num('finalSeconds', 'Final think time (s)', 10, 120) + '</div>';
    if (!dlg.open) dlg.showModal();
  }

  function openHelp() {
    var dlg = $('dlg-help');
    dlg.innerHTML = '<div class="dlg-h"><h2>Keys &amp; rules</h2><button class="dlg-x" type="button" data-close>&times;</button></div><div class="dlg-b">' +
      '<table class="keys"><tbody>' +
      '<tr><td><kbd>Space</kbd></td><td>Next step: open buzzers, continue, reveal</td></tr>' +
      '<tr><td><kbd>1</kbd>&ndash;<kbd>6</kbd></td><td>Ring in as that player (on the board: give that player control)</td></tr>' +
      '<tr><td><kbd>Y</kbd> / <kbd>Enter</kbd></td><td>Response was correct</td></tr>' +
      '<tr><td><kbd>N</kbd></td><td>Response was incorrect</td></tr>' +
      '<tr><td><kbd>R</kbd></td><td>Skip the clue and reveal the answer</td></tr>' +
      '<tr><td><kbd>A</kbd></td><td>Final Jeopardy: show the correct response</td></tr>' +
      '<tr><td><kbd>P</kbd></td><td>Play / pause a video or sound clue</td></tr>' +
      '<tr><td><kbd>U</kbd> / <kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>Undo the last action</td></tr>' +
      '<tr><td><kbd>M</kbd></td><td>Sound on / off</td></tr>' +
      '<tr><td><kbd>F</kbd></td><td>Full screen</td></tr>' +
      '<tr><td><kbd>H</kbd></td><td>Open the host console</td></tr>' +
      '<tr><td><kbd>Esc</kbd></td><td>Game menu</td></tr></tbody></table>' +
      '<ul class="rules"><li>Ringing in before the buzzers open freezes you out for a quarter second.</li>' +
      '<li>A wrong answer costs the clue value. The other players may ring in; nobody left means the answer is revealed.</li>' +
      '<li>Daily Double: wager $5 up to your score, or the round&rsquo;s top value if that is higher.</li>' +
      '<li>The player who answers correctly picks next. Double Jeopardy starts with the lowest score.</li>' +
      '<li>Final Jeopardy: only players above $0 take part; answers are revealed from the lowest score up.</li></ul></div>';
    if (!$('dlg-menu').open) { if (!dlg.open) dlg.showModal(); }
    else { $('dlg-menu').close(); dlg.showModal(); }
  }

  function openScoreDialog(pid) {
    var dlg = $('dlg-score'), s = engine.s;
    dlg.innerHTML = '<div class="dlg-h"><h2>Adjust scores</h2><button class="dlg-x" type="button" data-close>&times;</button></div><div class="dlg-b">' +
      '<p class="field-note">Fix a mistake or award a bonus. Every change can be undone.</p>' +
      s.players.map(function (p) {
        return '<div class="score-row" data-pid="' + p.id + '"><span class="sr-name">' + esc(p.name) + '</span>' +
          '<button type="button" class="btn" data-d="-100">&minus;100</button><button type="button" class="btn" data-d="100">+100</button>' +
          '<input type="number" class="num-input" value="' + p.score + '" aria-label="Score for ' + esc(p.name) + '"><button type="button" class="btn" data-set-score>Set</button></div>';
      }).join('') + '</div>';
    if ($('dlg-menu').open) $('dlg-menu').close();
    dlg.showModal();
    var row = dlg.querySelector('.score-row[data-pid="' + pid + '"] input');
    if (row) { row.focus(); row.select(); }
  }

  function wireDialogs() {
    ['dlg-menu', 'dlg-help', 'dlg-score', 'dlg-mod'].forEach(function (id) { closeOnBackdrop($(id)); });
    $('dlg-mod').addEventListener('click', onModDialogClick);
    document.addEventListener('click', function (e) {
      var close = e.target.closest('[data-close]');
      if (close) { close.closest('dialog').close(); return; }
    });
    $('dlg-menu').addEventListener('click', function (e) {
      var m = e.target.closest('[data-m]'), pill = e.target.closest('.toggle-pill');
      if (pill) {
        var key = pill.parentNode.dataset.set;
        setOpt(key, pill.dataset.v === '1');
        openMenu();
        return;
      }
      if (!m) return;
      var what = m.dataset.m;
      $('dlg-menu').close();
      if (what === 'host') openHost();
      else if (what === 'mod') openModDialog();
      else if (what === 'full') toggleFullscreen();
      else if (what === 'help') openHelp();
      else if (what === 'scores') openScoreDialog();
      else if (what === 'endround') { if (confirm('End this round now? Unplayed clues are skipped.')) engine.endRound(); }
      else if (what === 'quit') leave();
    });
    $('dlg-menu').addEventListener('input', function (e) {
      if (e.target.matches('[data-vol]')) setOpt('volume', Number(e.target.value) / 100);
    });
    $('dlg-menu').addEventListener('change', function (e) {
      var n = e.target.dataset.num;
      if (n) {
        var v = Math.max(Number(e.target.min), Math.min(Number(e.target.max), Number(e.target.value) || Number(e.target.min)));
        setOpt(n, v);
      }
    });
    $('dlg-score').addEventListener('click', function (e) {
      var row = e.target.closest('.score-row');
      if (!row) return;
      var pid = row.dataset.pid;
      if (e.target.dataset.d) { exec('adjust', [pid, Number(e.target.dataset.d)]); openScoreDialog(pid); }
      else if (e.target.hasAttribute('data-set-score')) { exec('setScore', [pid, row.querySelector('input').value]); openScoreDialog(pid); }
    });
    $('dlg-score').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.matches('.num-input')) {
        var row = e.target.closest('.score-row');
        exec('setScore', [row.dataset.pid, e.target.value]);
        openScoreDialog(row.dataset.pid);
      }
    });
  }

  /* ------------------------------------------------------------------ confetti */

  function startConfetti() {
    var cv = $('confetti'), ctx = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    cv.style.display = 'block';
    var colors = ['#c41e3a', '#ff6b6b', '#ffcc33', '#ffffff', '#3ddc84'];
    var parts = [];
    for (var i = 0; i < 160; i++) parts.push({ x: Math.random() * cv.width, y: -Math.random() * cv.height, w: 6 + Math.random() * 8, h: 8 + Math.random() * 10, vy: 2 + Math.random() * 4, vx: -1 + Math.random() * 2, r: Math.random() * 6, vr: -0.2 + Math.random() * 0.4, c: colors[i % colors.length] });
    var id = ++confettiRun, until = Date.now() + 7000;
    (function frame() {
      if (id !== confettiRun) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        if (p.y > cv.height && Date.now() < until) { p.y = -10; p.x = Math.random() * cv.width; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      });
      if (Date.now() < until || parts.some(function (p) { return p.y < cv.height; })) requestAnimationFrame(frame);
      else stopConfetti();
    })();
  }

  function stopConfetti() {
    confettiRun++;
    var cv = $('confetti');
    cv.style.display = 'none';
  }

  /* ------------------------------------------------------------------ wire-up */

  function init() {
    document.addEventListener('keydown', onKey);
    $('screen-game').addEventListener('click', function (e) {
      if (!engine) return;
      var tile = e.target.closest('.b-tile[data-c]');
      if (tile) {
        selectTile(Number(tile.dataset.c), Number(tile.dataset.r), tile);
        tile.blur();             // a focused button would swallow Enter (= correct)
        return;
      }
      var actEl = e.target.closest('[data-act]');
      if (actEl) { onAct(actEl.dataset.act, actEl); return; }
      if (engine.s.phase === 'intro') engine.advance();
    });
    $('t-undo').addEventListener('click', function () { engine.undo(); });
    $('t-sound').addEventListener('click', function () { setOpt('sound', !engine.s.opts.sound); });
    $('t-full').addEventListener('click', toggleFullscreen);
    $('t-menu').addEventListener('click', openMenu);
    wireDialogs();
    window.addEventListener('resize', placeMedia);
    // Clicking a video's controls or a YouTube frame takes keyboard focus; hand it back so the host keys keep working.
    $('media-layer').addEventListener('pointerup', function () {
      setTimeout(function () { var a = document.activeElement; if (a && /^(VIDEO|AUDIO)$/.test(a.tagName)) a.blur(); }, 0);
    });
    window.addEventListener('blur', function () {
      setTimeout(function () { var a = document.activeElement; if (engine && a && a.tagName === 'IFRAME') a.blur(); }, 0);
    });
    window.addEventListener('beforeunload', function () {
      if (!engine) return;
      try {
        if (engine.s.phase === 'over') localStorage.removeItem(FJ.SAVE_KEY);
        else localStorage.setItem(FJ.SAVE_KEY, JSON.stringify(engine.s));
      } catch (e) { /* ignore */ }
      if (chan) chan.postMessage({ t: 'state', s: null });   // tell the host console the board went away
    });
  }

  global.FJGame = { init: init, start: start, resume: resume, stop: stop, openModDialog: openModDialog };
})(window);

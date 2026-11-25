/* Bootstrap, lobby (setup) and question manager. */
(function (global) {
  'use strict';

  var FJ = global.FJ, esc = FJ.esc, api = FJ.api;
  var $ = function (id) { return document.getElementById(id); };

  var me = { user: '', isAdmin: false, adminConfigured: false, canStore: false, canStoreMedia: false };
  var games = [], listInfo = { source: 'sample', warning: null };
  var prefs = FJ.loadPrefs();
  var players = (prefs.players && prefs.players.length ? prefs.players : ['Player 1', 'Player 2', 'Player 3']).slice(0, 6);
  var OPT_KEYS = ['sound', 'readAloud', 'autoOpen', 'openImmediately', 'buzzSeconds', 'answerSeconds', 'ddSeconds', 'finalSeconds', 'doubleJeopardy', 'thinkMusic'];
  var opts = optsFromPrefs(prefs);
  var remoteMode = !!prefs.remotePlayers;
  var lobby = new global.FJRemote.Lobby(function () { renderRoom(); });

  /* The in-game menu also saves these, so the lobby re-reads them whenever it is shown. */
  function optsFromPrefs(p) {
    var d = global.JeopardyEngine.DEFAULT_OPTS;
    return {
      sound: p.sound !== false, doubleJeopardy: p.doubleJeopardy !== false, readAloud: !!p.readAloud, autoOpen: !!p.autoOpen, openImmediately: !!p.openImmediately,
      buzzSeconds: p.buzzSeconds || d.buzzSeconds, answerSeconds: p.answerSeconds || d.answerSeconds,
      ddSeconds: p.ddSeconds || d.ddSeconds, finalSeconds: p.finalSeconds || d.finalSeconds,
      thinkMusic: typeof p.thinkMusic === 'string' ? p.thinkMusic : ''
    };
  }

  /* Final think music: the host's own choice, else the app default (THINK_MUSIC); "built-in" forces the synth loop. */
  function isBuiltIn(v) { return /^built[\s-]?in$/i.test(String(v || '').trim()); }

  function thinkMusicFor(choice) {
    if (isBuiltIn(choice)) return '';
    return choice || me.thinkMusic || '';
  }

  function showScreen(name) {
    $('screen-setup').hidden = name !== 'setup';
    $('screen-admin').hidden = name !== 'admin';
    $('screen-game').hidden = true;
    document.body.classList.add('ui');
    document.body.classList.remove('in-game');
    document.title = 'Christmas Jeopardy';
    if (name === 'setup') {
      prefs = FJ.loadPrefs();
      opts = optsFromPrefs(prefs);
      renderOpts();
      refreshResume();
      if (remoteMode) lobby.open();
    } else lobby.pause();
    if (name === 'admin') { loadAdmin(); loadMedia(); }
  }

  /* ------------------------------------------------------------------ lobby */

  function renderPlayers() {
    $('player-list').innerHTML = players.map(function (n, i) {
      return '<div class="player-row"><span class="player-key">' + (i + 1) + '</span>' +
        '<input class="text-input" type="text" maxlength="20" value="' + esc(n) + '" data-i="' + i + '" aria-label="Contestant ' + (i + 1) + ' name"></div>';
    }).join('');
    renderFirst();
    $('btn-add-player').disabled = players.length >= 6;
    $('btn-remove-player').disabled = players.length <= 1;
  }

  function contestantNames() {
    return remoteMode ? lobby.players.map(function (p) { return p.name; }) : players;
  }

  function renderFirst() {
    var first = $('sel-first'), cur = first.value, names = contestantNames();
    first.innerHTML = '<option value="-1">Random</option>' + names.map(function (n, i) {
      return '<option value="' + i + '">' + esc(n || 'Player ' + (i + 1)) + '</option>';
    }).join('');
    first.value = cur && Number(cur) < names.length ? cur : '-1';
  }

  /* ---- players on their own devices ---- */

  function renderRingMode() {
    $('ring-mode').querySelectorAll('.toggle-pill').forEach(function (p) { p.classList.toggle('active', (p.dataset.v === '1') === remoteMode); });
    $('local-players').hidden = remoteMode;
    $('local-player-btns').hidden = remoteMode;
    $('room-panel').hidden = !remoteMode;
    $('players-note').textContent = remoteMode
      ? 'Players tap Join as a player (or open the link), type the code and their name, and get a buzzer. The host can still ring anyone in with the number keys.'
      : 'Ring in with the number key shown next to each name, or by clicking the podium.';
    if (remoteMode && !$('screen-setup').hidden) lobby.open();
    renderRoom();
    renderPlayers();
  }

  function renderRoom() {
    var room = lobby.room;
    $('room-code').textContent = room ? room.code : '\u2026';
    $('room-link').value = room ? global.FJRemote.joinLink(room.code) : '';
    $('room-count').textContent = lobby.players.length;
    $('room-players').innerHTML = lobby.players.length ? lobby.players.map(function (p, i) {
      var sig = lobby.sigs && lobby.sigs[p.id];
      return '<li><span class="player-key">' + (i + 1) + '</span><span class="rp-name">' + esc(p.name) + '</span>' +
        (sig ? '<span class="rp-sig"><img src="' + esc(sig) + '" alt="' + esc(p.name) + '&rsquo;s handwritten name"></span>' : '') +
        '<span class="rp-dot' + (p.online ? ' on' : '') + '" title="' + (p.online ? 'Connected' : 'Not connected') + '"></span>' +
        '<button class="btn rp-kick" type="button" data-kick="' + esc(p.id) + '" title="Remove ' + esc(p.name) + '">&times;</button></li>';
    }).join('') : '<li class="rp-empty">Nobody yet. Share the code or link.</li>';
    var err = $('room-error');
    err.hidden = !lobby.error;
    err.textContent = lobby.error ? 'Could not open a game code: ' + lobby.error : '';
    if (remoteMode) renderFirst();
  }

  function renderOpts() {
    document.querySelectorAll('[data-opt-toggle]').forEach(function (g) {
      var on = !!opts[g.dataset.optToggle];
      g.querySelectorAll('.toggle-pill').forEach(function (p) { p.classList.toggle('active', (p.dataset.v === '1') === on); });
    });
    $('opt-row-immediate').hidden = !opts.autoOpen;
    $('opt-buzz').value = opts.buzzSeconds;
    $('opt-answer').value = opts.answerSeconds;
    $('opt-final').value = opts.finalSeconds;
    $('opt-think').value = opts.thinkMusic;
  }

  function renderVoices() {
    var sel = $('opt-voice');
    if (!global.speechSynthesis) { sel.innerHTML = '<option value="">Not supported in this browser</option>'; sel.disabled = true; return; }
    var list = speechSynthesis.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
    list.sort(function (a, b) { return FJ.voiceScore(b) - FJ.voiceScore(a) || a.name.localeCompare(b.name); });
    var cur = FJ.loadPrefs().voice || '';
    sel.innerHTML = '<option value="">Automatic (most natural)</option>' + list.map(function (v) {
      return '<option value="' + esc(v.name) + '">' + esc(v.name.replace(/^Microsoft /, '')) + '</option>';
    }).join('');
    sel.value = list.some(function (v) { return v.name === cur; }) ? cur : '';
  }

  function previewVoice() {
    if (!global.speechSynthesis) return;
    var name = $('opt-voice').value, list = speechSynthesis.getVoices(), v = null;
    if (name) v = list.filter(function (x) { return x.name === name; })[0];
    if (!v) list.forEach(function (x) { if (/^en/i.test(x.lang) && (!v || FJ.voiceScore(x) > FJ.voiceScore(v))) v = x; });
    var u = new SpeechSynthesisUtterance('Santa Claus is said to live at the North Pole.');
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = 1.12;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function renderGames() {
    var sel = $('sel-game'), cur = sel.value || prefs.lastGame || '';
    sel.innerHTML = games.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.title) + '</option>'; }).join('');
    if (games.some(function (g) { return g.id === cur; })) sel.value = cur;
    showGameInfo();
    var w = $('game-warning');
    w.hidden = !listInfo.warning;
    w.textContent = listInfo.warning || '';
  }

  function showGameInfo() {
    var g = games.filter(function (x) { return x.id === $('sel-game').value; })[0];
    $('game-info').textContent = g
      ? g.rounds + (g.rounds === 1 ? ' round' : ' rounds') + ', ' + g.categories + ' categories, ' + g.clues + ' clues' + (g.hasFinal ? ', plus Final Jeopardy' : ', no Final Jeopardy clue') + (g.source === 'sample' ? ' (built-in sample)' : '')
      : 'No question sets found.';
    $('btn-start').disabled = !g;
  }

  function loadGames(refresh) {
    return api('/api/games' + (refresh ? '?refresh=true' : '')).then(function (r) {
      games = r.games;
      listInfo = r;
      renderGames();
    }).catch(function (e) {
      games = [];
      listInfo = { warning: e.message };
      renderGames();
    });
  }

  function savePrefs() {
    var p = FJ.loadPrefs();
    p.players = players;
    if ($('sel-game').value) p.lastGame = $('sel-game').value;
    OPT_KEYS.forEach(function (k) { p[k] = opts[k]; });
    FJ.savePrefs(p);
    prefs = p;
  }

  function clampInt(el, lo, hi, dflt) {
    var v = Math.round(Number(el.value));
    if (!isFinite(v) || !v) v = dflt;
    v = Math.max(lo, Math.min(hi, v));
    el.value = v;
    return v;
  }

  function startGame() {
    var id = $('sel-game').value;
    $('btn-start').disabled = true;
    $('start-note').textContent = 'Loading questions...';
    api('/api/games/' + encodeURIComponent(id)).then(function (data) {
      var usable = data.rounds.filter(function (r) { return r.categories.some(function (c) { return c.clues.length; }); });
      if (!usable.length) throw new Error('That question set has no playable clues.');
      data.rounds = opts.doubleJeopardy ? usable : usable.slice(0, 1);
      if (!remoteMode) return { data: data, room: null, names: players };
      if (!lobby.players.length) throw new Error('Nobody has joined yet. Players join with the code ' + (lobby.room ? lobby.room.code : '') + '.');
      return lobby.start().then(function (room) {
        var sigs = {};
        room.roster.forEach(function (r) { if (room.sigs[r.id]) sigs[r.slot] = room.sigs[r.id]; });
        delete room.sigs;
        return { data: data, room: room, sigs: sigs, names: room.roster.map(function (r) { return r.name; }) };
      });
    }).then(function (ready) {
      savePrefs();
      var p = FJ.loadPrefs();
      var cfg = {
        data: ready.data,
        room: ready.room,
        sigs: ready.sigs || {},
        players: ready.names.map(function (n, i) { return { name: (n || '').trim() || 'Player ' + (i + 1) }; }),
        firstPlayer: Number($('sel-first').value),
        opts: Object.assign({}, opts, { volume: p.volume == null ? 0.7 : p.volume, hideHostControls: !!p.hideHostControls, thinkMusic: thinkMusicFor(opts.thinkMusic) })
      };
      $('start-note').textContent = '';
      global.FJGame.start(cfg, function () { showScreen('setup'); });
    }).catch(function (e) {
      $('start-note').textContent = e.message;
    }).then(function () { $('btn-start').disabled = !games.length; });
  }

  function refreshResume() {
    var box = $('resume-box'), raw = null;
    try { raw = localStorage.getItem(FJ.SAVE_KEY); } catch (e) { /* storage blocked */ }
    if (!raw) { box.hidden = true; return; }
    var s;
    try { s = JSON.parse(raw); } catch (e) { box.hidden = true; return; }
    if (!s || !s.players || s.phase === 'over') { box.hidden = true; return; }
    var scores = s.players.map(function (p) { return esc(p.name) + ' ' + FJ.money(p.score); }).join(' &middot; ');
    box.hidden = false;
    box.innerHTML = '<div><b>Game in progress</b> &middot; ' + esc(s.title) + ' &middot; ' + esc(FJ.roundLabel(s)) + '<div class="resume-scores">' + scores + '</div></div>' +
      '<div class="resume-actions"><button class="btn btn-primary" id="btn-resume" type="button">Resume</button><button class="btn" id="btn-discard" type="button">Discard</button></div>';
    $('btn-resume').onclick = function () { lobby.pause(); global.FJGame.resume(s, function () { showScreen('setup'); }); };
    $('btn-discard').onclick = function () {
      if (confirm('Discard the saved game?')) { localStorage.removeItem(FJ.SAVE_KEY); refreshResume(); }
    };
  }

  function wireSetup() {
    $('player-list').addEventListener('input', function (e) {
      var i = e.target.dataset.i;
      if (i != null) { players[Number(i)] = e.target.value; var first = $('sel-first'); first.options[Number(i) + 1].textContent = e.target.value || 'Player ' + (Number(i) + 1); }
    });
    $('btn-add-player').onclick = function () { if (players.length < 6) { players.push('Player ' + (players.length + 1)); renderPlayers(); } };
    $('btn-remove-player').onclick = function () { if (players.length > 1) { players.pop(); renderPlayers(); } };
    document.querySelectorAll('[data-opt-toggle]').forEach(function (g) {
      g.addEventListener('click', function (e) {
        var p = e.target.closest('.toggle-pill');
        if (!p) return;
        opts[g.dataset.optToggle] = p.dataset.v === '1';
        renderOpts();
        savePrefs();
      });
    });
    $('opt-buzz').onchange = function () { opts.buzzSeconds = clampInt($('opt-buzz'), 2, 30, 5); savePrefs(); };
    $('opt-answer').onchange = function () { opts.answerSeconds = clampInt($('opt-answer'), 2, 60, 5); savePrefs(); };
    $('opt-final').onchange = function () { opts.finalSeconds = clampInt($('opt-final'), 10, 120, 30); savePrefs(); };
    $('opt-think').onchange = function () {
      var v = $('opt-think').value.trim(), builtIn = isBuiltIn(v), info = v && !builtIn && FJ.mediaInfo(v);
      var bad = v && !builtIn && (!info || info.kind !== 'audio');
      $('opt-think-err').textContent = bad ? 'Use an uploaded .mp3, .wav, .m4a or .ogg file name, a direct link to one, or "built-in".' : '';
      opts.thinkMusic = bad ? '' : (builtIn ? 'built-in' : v);
      if (builtIn) $('opt-think').value = 'built-in';
      savePrefs();
    };
    $('opt-voice').onchange = function () {
      var p = FJ.loadPrefs();
      if ($('opt-voice').value) p.voice = $('opt-voice').value; else delete p.voice;
      FJ.savePrefs(p);
      prefs = p;
      previewVoice();
    };
    renderVoices();
    if (global.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', renderVoices);
    $('sel-game').onchange = showGameInfo;
    $('ring-mode').addEventListener('click', function (e) {
      var pill = e.target.closest('.toggle-pill');
      if (!pill || (pill.dataset.v === '1') === remoteMode) return;
      remoteMode = pill.dataset.v === '1';
      if (!remoteMode) lobby.close();
      var p = FJ.loadPrefs();
      p.remotePlayers = remoteMode;
      FJ.savePrefs(p);
      renderRingMode();
    });
    $('btn-copy-link').onclick = function () {
      var inp = $('room-link');
      inp.select();
      if (navigator.clipboard) navigator.clipboard.writeText(inp.value).catch(function () { document.execCommand('copy'); });
      else document.execCommand('copy');
      $('btn-copy-link').textContent = 'Copied';
      setTimeout(function () { $('btn-copy-link').textContent = 'Copy'; }, 1500);
    };
    $('room-players').addEventListener('click', function (e) {
      var k = e.target.closest('[data-kick]');
      if (k && confirm('Remove this player from the game?')) lobby.kick(k.dataset.kick).catch(function (err) { alert(err.message); });
    });
    $('btn-reload-games').onclick = function () { loadGames(true); };
    $('btn-start').onclick = startGame;
    document.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.nav === 'admin' && !me.isAdmin) unlockAdmin(); else showScreen(b.dataset.nav);
      });
    });
    $('btn-admin-signout').onclick = function () {
      try { localStorage.removeItem(FJ.ADMIN_KEY); } catch (e) { /* storage blocked */ }
      me.isAdmin = false;
      showScreen('setup');
    };
  }

  function loadMe() {
    return api('/api/me').then(function (m) {
      me = m;
      $('opt-think').placeholder = m.thinkMusic ? 'Default: ' + m.thinkMusic : 'Built-in music';
    }).catch(function () { /* the lobby still works without this call */ });
  }

  function unlockAdmin() {
    if (!me.adminConfigured) { alert('Manage questions is off until an ADMIN_PASSWORD is set in the Vercel project settings.'); return; }
    var pw = prompt('Admin password:');
    if (!pw) return;
    try { localStorage.setItem(FJ.ADMIN_KEY, pw); } catch (e) { /* storage blocked */ }
    loadMe().then(function () {
      if (me.isAdmin) showScreen('admin');
      else { try { localStorage.removeItem(FJ.ADMIN_KEY); } catch (e) { /* storage blocked */ } alert('That password is not right.'); }
    });
  }

  /* ------------------------------------------------------------------ question manager */

  function loadAdmin() {
    return api('/api/games?refresh=true').then(function (r) {
      games = r.games;
      listInfo = r;
      var real = r.source === 'supabase';
      var rows = r.games.map(function (g) {
        return '<tr><td>' + esc(g.title) + (g.source === 'sample' ? ' <span class="badge-review">built-in</span>' : '') + '</td><td>' + g.rounds + '</td><td>' + g.categories + '</td><td>' + g.clues + '</td><td>' + (g.hasFinal ? 'Yes' : 'No') + '</td>' +
          '<td>' + (g.updated ? esc(g.updated.replace('T', ' ').slice(0, 16)) : '') + '</td><td class="row-actions">' +
          '<button class="btn" data-preview="' + esc(g.id) + '" type="button">Preview</button>' +
          (real ? '<button class="btn" data-delete="' + esc(g.id) + '" type="button">Delete</button>' : '') + '</td></tr>';
      }).join('');
      $('sets-table').innerHTML = '<table class="ui-table"><thead><tr><th>Set</th><th>Rounds</th><th>Categories</th><th>Clues</th><th>Final</th><th>Updated</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
        (r.warning ? '<p class="notice">' + esc(r.warning) + '</p>' : '');
    }).catch(function (e) { $('sets-table').innerHTML = '<p class="notice">' + esc(e.message) + '</p>'; });
  }

  function upload() {
    var f = $('up-file').files[0], name = $('up-name').value.trim();
    var out = $('upload-result');
    out.hidden = false;
    if (!name) { out.className = 'upload-result bad'; out.textContent = 'Give the question set a name.'; return; }
    if (!f) { out.className = 'upload-result bad'; out.textContent = 'Choose an Excel or CSV file first.'; return; }
    out.className = 'upload-result';
    out.textContent = 'Uploading...';
    $('btn-upload').disabled = true;
    fetch('/api/admin/import?game_id=' + encodeURIComponent(name) + '&filename=' + encodeURIComponent(f.name), { method: 'POST', body: f })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.detail || 'Upload failed'); return b; }); })
      .then(function (r) {
        var parts = Object.keys(r.imported).map(function (k) { return esc(k) + ': ' + r.imported[k] + ' clues'; }).join(', ');
        out.className = 'upload-result good';
        out.innerHTML = 'Saved. ' + parts + (r.warnings.length ? '<ul>' + r.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '');
        loadAdmin();
      })
      .catch(function (e) { out.className = 'upload-result bad'; out.textContent = e.message; })
      .then(function () { $('btn-upload').disabled = false; });
  }

  function preview(id) {
    api('/api/games/' + encodeURIComponent(id)).then(function (g) {
      var mediaCell = function (ref) {
        var info = FJ.mediaInfo(ref);
        if (!info) return ref ? ' <span class="badge-review">' + esc(ref) + '</span>' : '';
        return ' <a class="badge-review" href="' + esc(info.kind === 'embed' ? ref : info.src) + '" target="_blank" rel="noopener">' + esc(info.kind === 'embed' ? 'video link' : info.kind) + '</a>';
      };
      var h = '';
      g.rounds.forEach(function (r) {
        h += '<h3 class="pv-round">' + esc(r.name) + '</h3>';
        r.categories.forEach(function (c) {
          h += '<table class="ui-table pv"><thead><tr><th colspan="3" class="pv-cat">' + esc(c.name) + '</th></tr></thead><tbody>' +
            c.clues.map(function (cl) { return '<tr><td>' + FJ.money(cl.value) + (cl.dd ? ' <span class="badge-review">DD</span>' : '') + '</td><td>' + esc(cl.clue) + mediaCell(cl.media) + '</td><td>' + esc(cl.answer) + mediaCell(cl.answerMedia) + '</td></tr>'; }).join('') + '</tbody></table>';
        });
      });
      if (g.final) h += '<h3 class="pv-round">Final Jeopardy</h3><table class="ui-table pv"><thead><tr><th colspan="3" class="pv-cat">' + esc(g.final.category) + '</th></tr></thead><tbody><tr><td></td><td>' + esc(g.final.clue) + mediaCell(g.final.media) + '</td><td>' + esc(g.final.answer) + mediaCell(g.final.answerMedia) + '</td></tr></tbody></table>';
      $('preview-title').textContent = 'Preview: ' + g.title;
      $('preview-body').innerHTML = h;
      $('preview-card').hidden = false;
      $('preview-card').scrollIntoView({ behavior: 'smooth' });
    }).catch(function (e) { alert(e.message); });
  }

  /* ---- media files ---- */

  function fileSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function loadMedia() {
    var table = $('media-table');
    if (!me.canStoreMedia) {
      $('btn-media-upload').disabled = true;
      table.innerHTML = '<p class="notice">Media storage is not set up for this app yet (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY). Web links in the Media column still work.</p>';
      return Promise.resolve();
    }
    $('btn-media-upload').disabled = false;
    return api('/api/admin/media').then(function (r) {
      if (!r.files.length) { table.innerHTML = '<p class="field-note">No media files uploaded yet.</p>'; return; }
      table.innerHTML = '<table class="ui-table"><thead><tr><th></th><th>File name (use this in the Media column)</th><th>Type</th><th>Size</th><th></th></tr></thead><tbody>' +
        r.files.map(function (f) {
          var src = '/api/media/' + encodeURIComponent(f.name);
          var thumb = f.kind === 'image' ? '<img class="media-thumb" src="' + esc(src) + '" alt="" loading="lazy">' : '';
          return '<tr><td>' + thumb + '</td><td><code>' + esc(f.name) + '</code></td><td>' + esc(f.kind) + '</td><td>' + fileSize(f.size) + '</td><td class="row-actions">' +
            '<a class="btn" href="' + esc(src) + '" target="_blank" rel="noopener">Open</a>' +
            '<button class="btn" type="button" data-media-delete="' + esc(f.name) + '">Delete</button></td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) { table.innerHTML = '<p class="notice">' + esc(e.message) + '</p>'; });
  }

  function uploadMedia() {
    var files = [].slice.call($('media-file').files), out = $('media-result');
    out.hidden = false;
    if (!files.length) { out.className = 'upload-result bad'; out.textContent = 'Choose one or more files first.'; return; }
    var big = files.filter(function (f) { return f.size > 50 * 1024 * 1024; });
    if (big.length) { out.className = 'upload-result bad'; out.textContent = 'Larger than 50 MB: ' + big.map(function (f) { return f.name; }).join(', '); return; }
    $('btn-media-upload').disabled = true;
    out.className = 'upload-result';
    var done = [], failed = [];
    files.reduce(function (chain, f, i) {
      return chain.then(function () {
        out.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + ': ' + f.name + '...';
        return fetch('/api/admin/media/sign?size=' + f.size + '&filename=' + encodeURIComponent(f.name), { method: 'POST' })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw new Error(b.detail || 'Upload failed (' + r.status + ')'); return b; }); })
          .then(function (sig) {
            var form = new FormData();
            form.append('cacheControl', '3600');
            form.append('', f);
            return fetch(sig.url, { method: 'PUT', body: form }).then(function (r) {
              if (!r.ok) throw new Error('Storage rejected the file (' + r.status + ')');
              done.push(sig.name);
            });
          })
          .catch(function (e) { failed.push(f.name + ': ' + e.message); });
      });
    }, Promise.resolve()).then(function () {
      out.className = 'upload-result ' + (failed.length ? 'bad' : 'good');
      out.innerHTML = (done.length ? 'Uploaded: ' + done.map(esc).join(', ') + '.' : '') +
        (failed.length ? '<ul>' + failed.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>' : '');
      $('media-file').value = '';
      $('btn-media-upload').disabled = false;
      loadMedia();
    });
  }

  function wireAdmin() {
    $('btn-upload').onclick = upload;
    $('btn-media-upload').onclick = uploadMedia;
    $('media-table').addEventListener('click', function (e) {
      var d = e.target.closest('[data-media-delete]');
      if (!d || !confirm('Delete the media file "' + d.dataset.mediaDelete + '"? Clues that use it will show as text only.')) return;
      fetch('/api/admin/media/' + encodeURIComponent(d.dataset.mediaDelete), { method: 'DELETE' })
        .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.detail || 'Delete failed'); }); })
        .then(loadMedia).catch(function (err) { alert(err.message); });
    });
    $('btn-close-preview').onclick = function () { $('preview-card').hidden = true; };
    $('sets-table').addEventListener('click', function (e) {
      var p = e.target.closest('[data-preview]'), d = e.target.closest('[data-delete]');
      if (p) preview(p.dataset.preview);
      if (d && confirm('Delete the question set "' + d.dataset.delete + '"? This cannot be undone.')) {
        fetch('/api/admin/games/' + encodeURIComponent(d.dataset.delete), { method: 'DELETE' })
          .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.detail || 'Delete failed'); }); })
          .then(loadAdmin).catch(function (err) { alert(err.message); });
      }
    });
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    var q = new URLSearchParams(location.search);
    if (q.get('host') === '1') { global.FJHost.mount(); return; }
    if (q.has('mod')) { global.FJMod.mount(q.get('mod'), q.get('k') || ''); return; }
    if (q.has('join') || q.get('play') === '1') { global.FJPlayer.mount(q.get('join') || ''); return; }
    global.FJGame.init();
    $('btn-mod-link').onclick = function () { global.FJGame.openModDialog(); };
    wireSetup();
    wireAdmin();
    renderPlayers();
    renderOpts();
    showScreen('setup');
    renderRingMode();
    loadMe().then(function () {
      $('who').textContent = '';
      $('who2').textContent = '';
    });
    loadGames(false);
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);

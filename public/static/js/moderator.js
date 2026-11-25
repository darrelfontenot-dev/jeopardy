/* Moderator screen (?mod=ID&k=KEY): follows the game from any device and shows the correct response
 * for the clue being read. Read-only; the game screen pushes its state through /api/mod. */
(function (global) {
  'use strict';

  var FJ = global.FJ, esc = FJ.esc, money = FJ.money;
  var $ = function (id) { return document.getElementById(id); };
  var fid = '', key = '', ver = -1, state = null, error = '', gen = 0;

  var STEPS = {
    dd_splash: 'Daily Double', dd_wager: 'Taking the Daily Double wager', reading: 'Reading the clue',
    open: 'Buzzers open', answering: 'Answering', reveal: 'Answer revealed'
  };

  function mount(id, k) {
    fid = id; key = k;
    document.body.classList.add('ui');
    ['screen-setup', 'screen-admin', 'screen-game', 'screen-host', 'screen-player'].forEach(function (n) { if ($(n)) $(n).hidden = true; });
    $('screen-mod').hidden = false;
    document.title = 'Moderator answers - Christmas Jeopardy';
    render();
    poll(++gen);
  }

  function poll(g) {
    if (g !== gen) return;
    fetch('/api/mod/' + encodeURIComponent(fid) + '?view=' + encodeURIComponent(key) + '&since=' + ver, { cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok) { var e = new Error(b.detail || 'Request failed (' + r.status + ')'); e.status = r.status; throw e; }
          return b;
        });
      })
      .then(function (b) {
        error = '';
        if (b.ver !== ver) { ver = b.ver; state = b.state; }
        render();
        poll(g);
      }, function (e) {
        error = e.message || 'Connection lost';
        // The game screen recreates the feed when it next connects; keep trying.
        if (e.status === 404 || e.status === 403) ver = -1;
        render();
        setTimeout(function () { poll(g); }, e.status === 403 ? 15000 : 3000);
      });
  }

  function head(sub) {
    return '<header class="host-head"><img src="/static/img/logo-dark.svg" alt="" class="host-logo"><div><div class="host-title">Moderator answers</div>' +
      '<div class="host-sub">' + sub + '</div></div></header>';
  }

  function scores(s) {
    if (!s.players || !s.players.length) return '';
    return '<div class="mod-scores">' + s.players.map(function (p) {
      return '<span class="' + (p.score < 0 ? 'neg' : '') + '">' + esc(p.name) + ' <b>' + money(p.score) + '</b></span>';
    }).join('') + '</div>';
  }

  function clueCard(c) {
    var status = STEPS[c.step] || '';
    if (c.reading && (c.step === 'open' || c.step === 'answering')) status += ' &middot; still reading';
    if (c.step === 'answering' && c.answerer) status = '<b>' + esc(c.answerer) + '</b> is answering' + (c.reading ? ' &middot; still reading' : '');
    if (c.step === 'reveal') status = c.outcome === 'correct' && c.winner ? '<b>' + esc(c.winner) + '</b> got it' : 'Answer revealed';
    var val = c.dd ? 'Daily Double' + (c.wager != null ? ' &middot; ' + money(c.wager) : '') : money(c.value);
    var hidden = c.step === 'dd_splash' || c.step === 'dd_wager';
    return '<div class="mod-card"><div class="host-meta">' + esc(c.category) + ' &middot; <b>' + val + '</b></div>' +
      (hidden ? '<div class="host-clue mod-muted">The clue appears once the wager is in.</div>' : '<div class="host-clue mod-clue">' + esc(c.text) + '</div>') +
      (c.media ? '<div class="host-line mod-muted">Includes media: ' + esc(c.media) + '</div>' : '') +
      '<div class="host-answer mod-answer"><span>CORRECT RESPONSE</span>' + esc(c.answer) + '</div>' +
      '<div class="host-line">' + status + '</div></div>';
  }

  function render() {
    var root = $('screen-mod'), s = state, body;
    var warn = error ? '<div class="mod-warn">' + esc(error) + ' &mdash; retrying&hellip;</div>' : '';
    if (!s || s.phase === 'none') {
      root.innerHTML = head('Waiting for the game') + '<div class="host-body">' + warn +
        '<div class="host-wait">Start or resume the game on the main screen. This page updates by itself.</div></div>';
      return;
    }
    if (s.clue) body = clueCard(s.clue);
    else if (s.final) {
      var resp = (s.final.responses || []).map(function (r) {
        var shown = r.ink ? '<i>handwritten &mdash; see the main screen</i>' : r.sent ? esc(r.text) : '<i>no response yet</i>';
        return '<li' + (r.name === s.final.judging ? ' class="mod-judging"' : '') + '><b>' + esc(r.name) + ':</b> ' + shown + '</li>';
      }).join('');
      body = '<div class="mod-card"><div class="host-meta">Final Jeopardy &middot; <b>' + esc(s.final.category) + '</b></div>' +
        '<div class="host-clue mod-clue">' + esc(s.final.text) + '</div>' +
        '<div class="host-answer mod-answer"><span>CORRECT RESPONSE</span>' + esc(s.final.answer) + '</div>' +
        (resp ? '<div class="host-line">Players&rsquo; responses</div><ul class="mod-resp">' + resp + '</ul>' : '') + '</div>';
    } else if (s.phase === 'over') body = '<div class="host-wait">The game is over.</div>';
    else if (s.phase === 'round_end') body = '<div class="host-wait">End of the round.</div>';
    else body = '<div class="host-wait">Waiting for the next clue to be picked&hellip;</div>';
    root.innerHTML = head(esc(s.title || '') + (s.round ? ' &middot; ' + esc(s.round) : '')) +
      '<div class="host-body">' + warn + body + scores(s) + '</div>';
  }

  global.FJMod = { mount: mount };
})(window);

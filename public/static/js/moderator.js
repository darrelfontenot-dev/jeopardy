/* Moderator phone (?mod=ID&k=KEY): follows the game through /api/mod and sends the host's commands back.
 * The console itself is the host console (host.js); the game screen pushes its state and runs the commands. */
(function (global) {
  'use strict';

  var fid = '', key = '', ver = -1, ui = null, gen = 0;

  function mount(id, k) {
    fid = id; key = k;
    ui = global.FJHost.mountRemote({ send: send });
    poll(++gen);
  }

  function send(name, args) {
    fetch('/api/mod/' + encodeURIComponent(fid) + '/cmd?view=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, args: args })
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) { ui.notice(b.detail || 'Command failed (' + r.status + ')'); });
      ui.notice('');
    }).catch(function () { ui.notice('Connection lost - that tap may not have been sent.'); });
    if (navigator.vibrate) navigator.vibrate(15);
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
        ui.notice('');
        if (b.ver !== ver) { ver = b.ver; ui.update(b.state); }
        poll(g);
      }, function (e) {
        ui.notice((e.message || 'Connection lost') + ' \u2014 retrying\u2026');
        // The game screen recreates the feed when it next connects; keep trying.
        if (e.status === 404 || e.status === 403) ver = -1;
        setTimeout(function () { poll(g); }, e.status === 403 ? 15000 : 3000);
      });
  }

  global.FJMod = { mount: mount };
})(window);

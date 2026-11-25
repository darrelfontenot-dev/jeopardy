/* Player devices, host side: the lobby on the setup screen and the live link from the game screen.
 * The game screen stays the referee. Buzzes, Final wagers and Final responses from phones arrive as events, in
 * the order the server got them, and go through the same engine calls as the keyboard. The game state is pushed
 * back to the phones without any answers (or other players' responses) in it. */
(function (global) {
  'use strict';

  var FJ = global.FJ;
  var LOBBY_KEY = 'fj.lobby.v1';

  function api(method, url, body) {
    return fetch(url, {
      method: method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) { var e = new Error(b.detail || 'Request failed (' + r.status + ')'); e.status = r.status; throw e; }
        return b;
      });
    });
  }

  function roomUrl(code, path, key, extra) {
    return '/api/rooms/' + encodeURIComponent(code) + path + '?key=' + encodeURIComponent(key) + (extra || '');
  }

  function joinLink(code) { return location.origin + location.pathname + '?join=' + encodeURIComponent(code); }

  /* Handwritten names: fetched only when a player's signature version changes. Resolves true if any changed. */
  function syncSigs(holder, room, players) {
    holder.sigvs = holder.sigvs || {};
    var changed = players.some(function (p) { return (holder.sigvs[p.id] || 0) !== (p.sigv || 0); });
    if (!changed) return Promise.resolve(false);
    players.forEach(function (p) { holder.sigvs[p.id] = p.sigv || 0; });
    return api('GET', roomUrl(room.code, '/sigs', room.hostKey)).then(function (sigs) { holder.sigs = sigs; return true; })
      .catch(function () { holder.sigvs = {}; return false; });
  }

  /* ------------------------------------------------------------------ lobby (setup screen) */

  function Lobby(onChange) {
    this.onChange = onChange;
    this.room = null;
    this.players = [];
    this.ver = -1;
    this.gen = 0;
    this.error = '';
  }

  Lobby.prototype.open = function () {
    var self = this, saved = null;
    if (this.room) { this._poll(); return Promise.resolve(this.room); }
    try { saved = JSON.parse(sessionStorage.getItem(LOBBY_KEY)); } catch (e) { /* none */ }
    var check = saved && saved.code
      ? api('GET', roomUrl(saved.code, '/host', saved.hostKey, '&since=-1')).then(function (d) { self.players = d.players; return saved; })
      : Promise.reject(new Error('none'));
    return check.catch(function () { return api('POST', '/api/rooms'); }).then(function (room) {
      self.room = room;
      self.error = '';
      try { sessionStorage.setItem(LOBBY_KEY, JSON.stringify(room)); } catch (e) { /* private mode */ }
      self.ver = -1;
      self._poll();
      self.onChange();
      return room;
    }).catch(function (e) { self.error = e.message; self.onChange(); });
  };

  /* Stop listening (leaving the setup screen). The room stays open so a refresh or return picks it up. */
  Lobby.prototype.pause = function () { this.gen++; };

  Lobby.prototype.close = function () {
    this.gen++;
    if (this.room) api('DELETE', roomUrl(this.room.code, '', this.room.hostKey)).catch(function () {});
    this.forget();
  };

  Lobby.prototype.forget = function () {
    this.gen++;
    this.room = null;
    this.players = [];
    this.sigs = {};
    this.sigvs = {};
    try { sessionStorage.removeItem(LOBBY_KEY); } catch (e) { /* ignore */ }
  };

  Lobby.prototype._poll = function () {
    var self = this, gen = ++this.gen;
    (function loop() {
      if (gen !== self.gen || !self.room) return;
      api('GET', roomUrl(self.room.code, '/host', self.room.hostKey, '&since=' + self.ver)).then(function (d) {
        if (gen !== self.gen) return;
        self.ver = d.ver;
        self.players = d.players;
        self.onChange();
        syncSigs(self, self.room, d.players).then(function (ch) { if (ch && gen === self.gen) self.onChange(); });
        loop();
      }).catch(function (e) {
        if (gen !== self.gen) return;
        if (e.status === 404 || e.status === 403) { self.forget(); self.open(); return; }
        setTimeout(loop, 2000);
      });
    })();
  };

  Lobby.prototype.kick = function (id) {
    if (!this.room) return Promise.resolve();
    return api('POST', roomUrl(this.room.code, '/kick', this.room.hostKey), { id: id });
  };

  /* Fix the roster and hand the room to the game. Resolves to the cfg.room the engine keeps. */
  Lobby.prototype.start = function () {
    var self = this, room = this.room, sigs = this.sigs || {};
    if (!room) return Promise.reject(new Error('The join code is not ready yet.'));
    return api('POST', roomUrl(room.code, '/start', room.hostKey), { order: this.players.map(function (p) { return p.id; }) })
      .then(function (d) {
        self.forget();
        return { code: room.code, hostKey: room.hostKey, sigs: sigs, roster: d.players.map(function (p) { return { slot: p.slot, name: p.name, id: p.id }; }) };
      });
  };

  /* ------------------------------------------------------------------ live link (game screen) */

  function Link(engine, hooks) {
    this.e = engine;
    this.hooks = hooks;       // { buzz(pid), finalWager(pid, n) -> error|null, finalResponse(pid, resp) -> error|null, onRoster(players) }
    this.room = engine.s.room;
    this.ver = -1;
    this.after = 0;
    this.gen = 0;
    this.pushing = false;
    this.dirty = false;
    this.pendingWagers = {};
    this.errors = {};
    this.ferrors = {};
    this.online = {};
  }

  Link.prototype.start = function () {
    var self = this, gen = ++this.gen;
    this.push();
    (function loop() {
      if (gen !== self.gen) return;
      var r = self.room;
      api('GET', roomUrl(r.code, '/host', r.hostKey, '&since=' + self.ver + '&after=' + self.after)).then(function (d) {
        if (gen !== self.gen) return;
        if (d.seq < self.after) self.after = 0;   // the server restarted and numbering began again
        self.ver = d.ver;
        self.online = {};
        d.players.forEach(function (p) { if (p.slot) self.online[p.slot] = p.online; });
        d.events.forEach(function (ev) {
          if (ev.seq <= self.after) return;
          self.after = ev.seq;
          self._handle(ev);
        });
        if (self.hooks.onRoster) self.hooks.onRoster(d.players);
        syncSigs(self, r, d.players).then(function (ch) {
          if (!ch || gen !== self.gen) return;
          var map = self.e.s.sigs = self.e.s.sigs || {};
          d.players.forEach(function (p) {
            if (!p.slot) return;
            if (self.sigs[p.id]) map[p.slot] = self.sigs[p.id]; else delete map[p.slot];
          });
          if (self.hooks.onRoster) self.hooks.onRoster(d.players);
        });
        loop();
      }).catch(function (e) {
        if (gen !== self.gen) return;
        if (e.status === 404) {
          // The app restarted and forgot the room: bring it back so players can rejoin by name.
          api('POST', '/api/rooms/' + encodeURIComponent(r.code) + '/restore', { hostKey: r.hostKey, roster: r.roster || [] })
            .then(function () { self.ver = -1; self.after = 0; self.push(); loop(); })
            .catch(function () { setTimeout(loop, 3000); });
          return;
        }
        setTimeout(loop, 1500);
      });
    })();
  };

  Link.prototype.stop = function () { this.gen++; this.stopped = true; };

  Link.prototype._handle = function (ev) {
    if (ev.t === 'buzz') this.hooks.buzz(ev.pid);
    else if (ev.t === 'fwager') {
      this.pendingWagers[ev.pid] = ev.value;
      delete this.errors[ev.pid];
      this.settleWagers();
      this.push();
      if (this.hooks.onRoster) this.hooks.onRoster();
    }
    else if (ev.t === 'fresp') {
      var err = this.hooks.finalResponse ? this.hooks.finalResponse(ev.pid, ev.data || {}) : 'Not accepting responses.';
      if (err) this.ferrors[ev.pid] = err; else delete this.ferrors[ev.pid];
      this.push();
    }
  };

  /* Final wagers are taken in turn order by the engine; phones can send theirs whenever they like. */
  Link.prototype.settleWagers = function () {
    if (this.settling) return;
    this.settling = true;
    var f = this.e.s.final;
    while (f && f.step === 'wager') {
      var pid = f.eligible[f.wi];
      if (!(pid in this.pendingWagers)) break;
      var n = this.pendingWagers[pid];
      delete this.pendingWagers[pid];
      var err = this.hooks.finalWager(pid, n);
      if (err) { this.errors[pid] = err; break; }
      f = this.e.s.final;
    }
    this.settling = false;
  };

  Link.prototype.push = function () {
    var self = this;
    if (this.stopped) return;
    if (this.pushing) { this.dirty = true; return; }
    this.pushing = true;
    this.dirty = false;
    var failed = false;
    api('POST', roomUrl(this.room.code, '/state', this.room.hostKey), this.view())
      .catch(function () { failed = true; })
      .then(function () {
        self.pushing = false;
        if (failed || self.dirty) setTimeout(function () { self.push(); }, failed ? 1000 : 0);
      });
  };

  /* What the phones see: no clue text and no answers. */
  Link.prototype.view = function () {
    var e = this.e, s = e.s, k = s.clue, f = s.final, b = e.board(), pending = this.pendingWagers;
    var v = {
      title: s.title, phase: s.phase, round: FJ.roundLabel(s), control: s.control,
      players: s.players.map(function (p) { return { id: p.id, name: p.name, score: p.score }; }),
      errors: this.errors, ferrors: this.ferrors
    };
    if (s.phase === 'clue' && k) {
      v.clue = {
        id: k.id, category: b.categories[k.c], value: k.value, dd: k.dd, step: k.step, answerer: k.answerer,
        locked: k.locked.slice(), early: Object.keys(k.early || {}), outcome: k.outcome, winner: k.winner,
        timedOut: !!k.timedOut
      };
    }
    if (s.phase === 'final' && f) {
      v.final = {
        step: f.step, category: s.finalClue ? s.finalClue.category : '', eligible: f.eligible.slice(),
        wagered: Object.keys(f.wagers).concat(Object.keys(pending)), results: f.results,
        answered: Object.keys(s.fresp || {}), timeUp: !!f.timeUp,
        revealing: f.step === 'reveal' ? f.order[f.ri] : null
      };
    }
    if (s.phase === 'over') v.winners = e.winners().map(function (p) { return p.id; });
    return v;
  };

  global.FJRemote = { Lobby: Lobby, Link: Link, joinLink: joinLink, api: api };
})(window);

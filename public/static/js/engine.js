/* Jeopardy rules engine: no DOM, no timers. The UI calls tick() and renders state.
 *
 * Rules implemented (as on the TV show):
 *  - Round 1 and Double round, then Final. Daily Doubles: 1 in round 1, 2 in round 2 (or as flagged in the data).
 *  - The player who last answered correctly picks next. A new round starts with the lowest score.
 *  - Ring in only after the host finishes reading; ringing in early freezes you out for a moment.
 *  - A wrong answer costs the clue value and locks you out of that clue; the others may ring in again.
 *  - Nobody correct (or nobody rings in): the answer is revealed and control stays where it was.
 *  - Daily Double: only the player in control, wager $5 up to the larger of their score or the round's top value.
 *  - Final: only players above $0 play, secret wagers up to their score, answers revealed from lowest score up.
 */
(function (global) {
  'use strict';

  var MAX_UNDO = 80;
  var DD_MIN = 5;
  var FINAL_GRACE_MS = 4000;  // a response sent as the Final clock hits zero still counts if it lands this soon after

  var DEFAULT_OPTS = {
    buzzSeconds: 5,
    answerSeconds: 5,
    ddSeconds: 15,
    finalSeconds: 30,
    thinkMusic: '',       // uploaded file name or link for the Final think music; blank = the built-in loop
    lockoutMs: 250,
    autoOpen: false,
    openImmediately: false,
    readAloud: false,
    sound: true,
    volume: 0.7,
    hideHostControls: false
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function randInt(n) { return Math.floor(Math.random() * n); }

  /* Lay a round's clues out on a grid[category][row], aligned by dollar value. */
  function layoutRound(round, ri) {
    var values = [];
    round.categories.forEach(function (cat) {
      cat.clues.forEach(function (cl) { if (values.indexOf(cl.value) < 0) values.push(cl.value); });
    });
    values.sort(function (a, b) { return a - b; });
    var rowValues = values.slice();
    var grid = round.categories.map(function (cat, ci) {
      var col = [];
      cat.clues.forEach(function (cl, k) {
        var row = values.indexOf(cl.value);
        while (col[row]) {            // same value twice in one category: use the next free row
          row++;
          if (row >= rowValues.length) rowValues.push(cl.value);
        }
        col[row] = {
          id: ri + '-' + ci + '-' + row,
          value: cl.value, clue: cl.clue, answer: cl.answer, media: cl.media || null, answerMedia: cl.answerMedia || null, dd: !!cl.dd, done: false
        };
      });
      return col;
    });
    var rows = rowValues.length;
    grid.forEach(function (col) { for (var r = 0; r < rows; r++) if (!col[r]) col[r] = null; });
    return {
      name: round.name, categories: round.categories.map(function (c) { return c.name; }),
      rowValues: rowValues, grid: grid
    };
  }

  /* Place Daily Doubles when the data does not say where they go: lower rows are likelier, one per category. */
  function placeDailyDoubles(board, wanted) {
    var flagged = 0;
    board.grid.forEach(function (col) { col.forEach(function (c) { if (c && c.dd) flagged++; }); });
    if (flagged > 0) return;
    var usedCols = {};
    for (var n = 0; n < wanted; n++) {
      var pool = [];
      board.grid.forEach(function (col, ci) {
        if (usedCols[ci]) return;
        col.forEach(function (cell, ri) {
          if (!cell) return;
          var weight = 1 + ri;                       // row 1 is lightest, bottom rows heaviest
          for (var w = 0; w < weight; w++) pool.push([ci, ri]);
        });
      });
      if (!pool.length) return;
      var pick = pool[randInt(pool.length)];
      board.grid[pick[0]][pick[1]].dd = true;
      usedCols[pick[0]] = true;
    }
  }

  function Engine(state, hooks) {
    this.s = state;
    this.hooks = hooks || {};
    this.now = this.hooks.now || function () { return Date.now(); };
    this.listeners = [];
    this.cueListeners = [];
  }

  Engine.DEFAULT_OPTS = DEFAULT_OPTS;
  Engine.DD_MIN = DD_MIN;

  /* ---- construction ---------------------------------------------------- */

  Engine.create = function (cfg, hooks) {
    var data = cfg.data;
    var boards = data.rounds.map(layoutRound);
    boards.forEach(function (b, i) {
      placeDailyDoubles(b, boards.length === 1 ? 1 : (i === 0 ? 1 : 2));
    });
    var players = cfg.players.map(function (p, i) {
      return { id: 'p' + (i + 1), name: p.name, score: 0 };
    });
    var first = typeof cfg.firstPlayer === 'number' && cfg.firstPlayer >= 0 ? cfg.firstPlayer : randInt(players.length);
    var state = {
      v: 1,
      gameId: data.id, title: data.title, source: data.source,
      opts: Object.assign({}, DEFAULT_OPTS, cfg.opts || {}),
      players: players,
      boards: boards,
      finalClue: data.final ? clone(data.final) : null,
      round: 0,
      phase: 'intro',
      control: players[first].id,
      clue: null,
      final: null,
      history: [],
      room: cfg.room || null,
      sigs: cfg.sigs || {},          // handwritten names by player id (kept out of undo snapshots)
      startedAt: Date.now()
    };
    return new Engine(state, hooks);
  };

  Engine.restore = function (json, hooks) {
    var e = new Engine(clone(json), hooks);
    e._rehydrate();
    return e;
  };

  /* ---- plumbing ---------------------------------------------------------- */

  Engine.prototype.on = function (fn) { this.listeners.push(fn); };
  Engine.prototype.onCue = function (fn) { this.cueListeners.push(fn); };
  Engine.prototype._emit = function () { var s = this.s, self = this; this.listeners.forEach(function (fn) { fn(s, self); }); };
  Engine.prototype._cue = function (name, data) { this.cueListeners.forEach(function (fn) { fn(name, data || {}); }); };

  Engine.prototype._cellStates = function () {
    return this.s.boards.map(function (b) {
      return b.grid.map(function (col) {
        return col.map(function (c) { return c ? [c.done ? 1 : 0, c.outcome || null, c.winner || null] : null; });
      });
    });
  };

  /* Snapshots leave out the (large, unchanging) clue text and keep only which tiles are played. */
  Engine.prototype._snapshot = function () {
    var s = this.s, copy = {};
    Object.keys(s).forEach(function (k) {
      if (k !== 'history' && k !== 'boards' && k !== 'opts' && k !== 'sigs' && k !== 'fresp') copy[k] = clone(s[k]);
    });
    copy.cells = this._cellStates();
    s.history.push(copy);
    if (s.history.length > MAX_UNDO) s.history.shift();
  };

  Engine.prototype.canUndo = function () { return this.s.history.length > 0; };

  Engine.prototype.undo = function () {
    if (!this.s.history.length) return false;
    var prev = this.s.history.pop(), cur = this.s;
    var cells = prev.cells;
    delete prev.cells;
    prev.history = cur.history;
    prev.boards = cur.boards;
    prev.opts = cur.opts;               // settings are not part of the game
    prev.sigs = cur.sigs;
    prev.fresp = cur.fresp;
    prev.boards.forEach(function (b, bi) {
      b.grid.forEach(function (col, ci) {
        col.forEach(function (c, ri) {
          if (!c) return;
          var st = cells[bi][ci][ri];
          c.done = !!st[0]; c.outcome = st[1]; c.winner = st[2];
        });
      });
    });
    this.s = prev;
    this._rehydrate();
    this._cue('undo');
    this._emit();
    return true;
  };

  /* Timers are absolute timestamps, so after a reload or an undo they restart from full. */
  Engine.prototype._rehydrate = function () {
    var s = this.s, k = s.clue, t = this.now();
    if (k) {
      k.lockUntil = {};
      if (k.reading && (k.step === 'open' || k.step === 'answering')) { k.deadline = null; k.timedOut = false; }
      else if (k.step === 'open') k.deadline = t + s.opts.buzzSeconds * 1000;
      else if (k.step === 'answering') { k.deadline = t + (k.dd ? s.opts.ddSeconds : s.opts.answerSeconds) * 1000; k.timedOut = false; }
      else k.deadline = null;
      k.early = {};
    }
    if (s.final && s.final.step === 'clue') { s.final.deadline = t + s.opts.finalSeconds * 1000; s.final.timeUp = false; }
  };

  Engine.prototype.toJSON = function () { return this.s; };

  /* ---- selectors -------------------------------------------------------- */

  Engine.prototype.player = function (id) {
    for (var i = 0; i < this.s.players.length; i++) if (this.s.players[i].id === id) return this.s.players[i];
    return null;
  };

  Engine.prototype.board = function () { return this.s.boards[this.s.round]; };

  Engine.prototype.cell = function (c, r) { var b = this.board(); return b.grid[c] && b.grid[c][r]; };

  Engine.prototype.remaining = function () {
    var n = 0;
    this.board().grid.forEach(function (col) { col.forEach(function (c) { if (c && !c.done) n++; }); });
    return n;
  };

  Engine.prototype.roundTopValue = function () {
    var v = this.board().rowValues;
    return v[v.length - 1] || 0;
  };

  Engine.prototype.ddMax = function (pid) {
    var p = this.player(pid || this.s.control);
    return Math.max(p ? p.score : 0, this.roundTopValue());
  };

  Engine.prototype.lowestPlayers = function () {
    var min = Infinity, ids = [];
    this.s.players.forEach(function (p) { if (p.score < min) min = p.score; });
    this.s.players.forEach(function (p) { if (p.score === min) ids.push(p.id); });
    return ids;
  };

  Engine.prototype.winners = function () {
    var max = -Infinity;
    this.s.players.forEach(function (p) { if (p.score > max) max = p.score; });
    return this.s.players.filter(function (p) { return p.score === max; });
  };

  /* ---- board play ---------------------------------------------------------- */

  Engine.prototype.startBoard = function () {
    if (this.s.phase !== 'intro') return false;
    this.s.phase = 'board';
    this._emit();
    return true;
  };

  Engine.prototype.setControl = function (pid) {
    if (!this.player(pid) || this.s.phase !== 'board' && this.s.phase !== 'intro') return false;
    this._snapshot();
    this.s.control = pid;
    this._emit();
    return true;
  };

  Engine.prototype.selectClue = function (c, r) {
    var s = this.s;
    if (s.phase !== 'board') return false;
    var cell = this.cell(c, r);
    if (!cell || cell.done) return false;
    this._snapshot();
    s.clue = {
      c: c, r: r, id: cell.id, value: cell.value, dd: cell.dd,
      step: cell.dd ? 'dd_splash' : 'reading',
      locked: [], early: {}, lockUntil: {}, answerer: null, wager: null,
      log: [], outcome: null, winner: null, deadline: null, timedOut: false,
      startedAt: this.now()
    };
    s.phase = 'clue';
    this._cue(cell.dd ? 'dailydouble' : 'select');
    if (!cell.dd && s.opts.autoOpen && s.opts.openImmediately) {
      // Buzzers go live as the reading starts; the clocks wait for finishReading().
      s.clue.step = 'open';
      s.clue.reading = true;
    }
    this._emit();
    return true;
  };

  /* The clue has been read in full (open-immediately mode): start whichever clock is now due. */
  Engine.prototype.finishReading = function () {
    var k = this.s.clue, t = this.now(), o = this.s.opts;
    if (!k || !k.reading) return false;
    k.reading = false;
    if (k.step === 'open') k.deadline = t + o.buzzSeconds * 1000;
    else if (k.step === 'answering') k.deadline = t + o.answerSeconds * 1000;
    this._emit();
    return true;
  };

  /* The host key (Space): moves the current clue to its next step. */
  Engine.prototype.advance = function () {
    var s = this.s;
    if (s.phase === 'intro') return this.startBoard();
    if (s.phase === 'round_end') return this.nextRound();
    if (s.phase === 'final') return this.finalAdvance();
    if (s.phase !== 'clue') return false;
    var k = s.clue;
    switch (k.step) {
      case 'dd_splash': this._snapshot(); k.step = 'dd_wager'; this._emit(); return true;
      case 'reading': return this.openBuzzers();
      case 'open':
      case 'answering': return k.reading ? this.finishReading() : false;
      case 'reveal': return this.finishClue();
      default: return false;
    }
  };

  Engine.prototype.openBuzzers = function () {
    var k = this.s.clue, t = this.now(), o = this.s.opts;
    if (!k || k.step !== 'reading') return false;
    if (k.dd) {
      k.step = 'answering';
      k.answerer = this.s.control;
      k.deadline = t + o.ddSeconds * 1000;
      this._cue('ring', { pid: k.answerer });
    } else {
      k.step = 'open';
      k.deadline = t + o.buzzSeconds * 1000;
      Object.keys(k.early).forEach(function (pid) { k.lockUntil[pid] = t + o.lockoutMs; });
      k.early = {};
      this._cue('open');
    }
    this._emit();
    return true;
  };

  /* A player rings in. Returns 'ok' | 'early' | 'locked' | 'frozen' | 'ignored'. */
  Engine.prototype.buzz = function (pid) {
    var k = this.s.clue;
    if (!k || k.dd || !this.player(pid)) return 'ignored';
    if (k.step === 'reading') {
      if (!k.early[pid]) { k.early[pid] = true; this._cue('early', { pid: pid }); this._emit(); }
      return 'early';
    }
    if (k.step !== 'open') return 'ignored';
    if (k.locked.indexOf(pid) >= 0) return 'locked';
    if (k.lockUntil[pid] && this.now() < k.lockUntil[pid]) { this._cue('frozen', { pid: pid }); return 'frozen'; }
    k.step = 'answering';
    k.answerer = pid;
    k.timedOut = false;
    k.deadline = k.reading ? null : this.now() + this.s.opts.answerSeconds * 1000;
    this._cue('ring', { pid: pid });
    this._emit();
    return 'ok';
  };

  Engine.prototype.setWager = function (n) {
    var k = this.s.clue;
    if (!k || k.step !== 'dd_wager') return 'Not waiting for a wager.';
    n = Math.floor(Number(n));
    var max = this.ddMax();
    if (!isFinite(n) || n < DD_MIN) return 'The smallest wager is $' + DD_MIN + '.';
    if (n > max) return 'The largest wager is $' + max.toLocaleString('en-US') + '.';
    this._snapshot();
    k.wager = n;
    k.step = 'reading';
    this._cue('select');
    this._emit();
    return null;
  };

  Engine.prototype.judge = function (correct) {
    var s = this.s, k = s.clue;
    if (!k || k.step !== 'answering') return false;
    this._snapshot();
    var pid = k.answerer, p = this.player(pid), amount = k.dd ? k.wager : k.value;
    k.deadline = null;
    k.timedOut = false;
    k.log.push({ pid: pid, correct: !!correct, amount: amount });
    if (correct) {
      p.score += amount;
      k.outcome = 'correct';
      k.winner = pid;
      s.control = pid;
      k.step = 'reveal';
      this._cue(k.dd ? 'ddcorrect' : 'correct', { pid: pid });
    } else {
      p.score -= amount;
      this._cue('wrong', { pid: pid });
      if (k.dd) {
        k.outcome = 'wrong';
        k.step = 'reveal';
      } else {
        k.locked.push(pid);
        k.answerer = null;
        if (k.locked.length >= s.players.length) {
          k.outcome = 'none';
          k.step = 'reveal';
          this._cue('timeup');
        } else {
          k.step = 'open';
          k.early = {};
          k.lockUntil = {};
          k.deadline = k.reading ? null : this.now() + s.opts.buzzSeconds * 1000;
        }
      }
    }
    this._emit();
    return true;
  };

  /* Show the answer without scoring (nobody got it, or the host moves on). */
  Engine.prototype.skipClue = function () {
    var k = this.s.clue;
    if (!k || k.step === 'reveal') return false;
    this._snapshot();
    k.step = 'reveal';
    k.outcome = k.outcome || 'none';
    k.answerer = null;
    k.deadline = null;
    this._emit();
    return true;
  };

  /* Called by the UI clock. Returns the event name when something just ran out. */
  Engine.prototype.tick = function () {
    var s = this.s, t = this.now();
    if (s.phase === 'clue' && s.clue && s.clue.deadline && t >= s.clue.deadline) {
      var k = s.clue;
      if (k.step === 'open') {
        k.deadline = null;
        k.outcome = 'none';
        k.step = 'reveal';
        this._cue('timeup');
        this._emit();
        return 'window';
      }
      if (k.step === 'answering' && !k.timedOut) {
        k.timedOut = true;
        k.deadline = null;
        this._cue('timeup');
        this._emit();
        return 'answer';
      }
    }
    if (s.phase === 'final' && s.final && s.final.step === 'clue' && s.final.deadline && t >= s.final.deadline) {
      s.final.deadline = null;
      s.final.timeUp = true;
      s.final.closedAt = t;
      this._cue('timeup');
      this._emit();
      return 'final';
    }
    return null;
  };

  Engine.prototype.finishClue = function () {
    var s = this.s, k = s.clue;
    if (!k || k.step !== 'reveal') return false;
    this._snapshot();
    this.cell(k.c, k.r).done = true;
    this.cell(k.c, k.r).outcome = k.outcome;
    this.cell(k.c, k.r).winner = k.winner;
    s.clue = null;
    s.phase = this.remaining() === 0 ? 'round_end' : 'board';
    if (s.phase === 'round_end') this._cue('roundend');
    this._emit();
    return true;
  };

  /* Host ends the round before every clue has been played (as when time runs out on TV). */
  Engine.prototype.endRound = function () {
    if (this.s.phase !== 'board') return false;
    this._snapshot();
    this.s.phase = 'round_end';
    this._cue('roundend');
    this._emit();
    return true;
  };

  Engine.prototype.nextRound = function () {
    var s = this.s;
    if (s.phase !== 'round_end') return false;
    this._snapshot();
    if (s.round + 1 < s.boards.length) {
      s.round += 1;
      s.phase = 'intro';
      var low = this.lowestPlayers();
      s.control = low[randInt(low.length)];
      this._emit();
      return true;
    }
    this._startFinal();
    return true;
  };

  Engine.prototype.adjustScore = function (pid, delta) {
    var p = this.player(pid);
    if (!p || !isFinite(delta) || !delta) return false;
    this._snapshot();
    p.score += Math.round(delta);
    this._emit();
    return true;
  };

  Engine.prototype.setScore = function (pid, value) {
    var p = this.player(pid);
    value = Math.round(Number(value));
    if (!p || !isFinite(value)) return false;
    this._snapshot();
    p.score = value;
    this._emit();
    return true;
  };

  /* ---- Final Jeopardy ---------------------------------------------------------- */

  Engine.prototype._startFinal = function () {
    var s = this.s;
    var eligible = s.players.filter(function (p) { return p.score > 0; });
    if (!s.finalClue || !eligible.length) {
      s.phase = 'over';
      s.clue = null;
      this._cue('gameover');
      this._emit();
      return;
    }
    eligible.sort(function (a, b) { return a.score - b.score; });
    s.phase = 'final';
    s.fresp = {};   // responses typed or written on players' devices (kept out of undo snapshots, like sigs)
    s.final = {
      step: 'category',
      eligible: eligible.map(function (p) { return p.id; }),
      order: eligible.map(function (p) { return p.id; }),
      wagers: {}, wi: 0, ri: 0, shown: false, answerShown: false,
      deadline: null, timeUp: false, results: {}
    };
    this._cue('final');
    this._emit();
  };

  Engine.prototype.finalWager = function (pid, n) {
    var f = this.s.final, p = this.player(pid);
    if (!f || f.step !== 'wager' || !p || f.eligible[f.wi] !== pid) return 'Not this player’s turn to wager.';
    n = Math.floor(Number(n));
    if (!isFinite(n) || n < 0 || n > p.score) return 'The wager must be between $0 and $' + p.score.toLocaleString('en-US') + '.';
    this._snapshot();
    f.wagers[pid] = n;
    f.wi += 1;
    if (f.wi >= f.eligible.length) f.step = 'ready';
    this._cue('select');
    this._emit();
    return null;
  };

  /* A response typed or handwritten on a player's device. It can be changed while the clock runs;
   * one sent automatically as time ran out still counts if it arrives within a moment. */
  Engine.prototype.finalResponse = function (pid, resp) {
    var f = this.s.final, t = this.now();
    if (!f || this.s.phase !== 'final') return 'Final Jeopardy is not being played.';
    if (f.eligible.indexOf(pid) < 0) return 'Only players with a score above $0 play Final Jeopardy.';
    var open = f.step === 'clue' && !f.timeUp;
    var grace = f.closedAt && t - f.closedAt <= FINAL_GRACE_MS && (f.step === 'clue' || (f.step === 'reveal' && f.order.indexOf(pid) >= f.ri && !(f.shown && f.order[f.ri] === pid)));
    if (!open && !grace) return f.step === 'clue' || f.step === 'reveal' || f.step === 'done' ? 'Time is up. Pens down!' : 'Wait for the clue.';
    var text = String(resp && resp.text || '').slice(0, 200), ink = String(resp && resp.ink || '');
    if (!text && !ink) return 'Type or write your response first.';
    this.s.fresp = this.s.fresp || {};
    this.s.fresp[pid] = { text: ink ? '' : text, ink: ink, at: t };
    this._emit();
    return null;
  };

  Engine.prototype.finalAdvance = function () {
    var f = this.s.final;
    if (!f) return false;
    var t = this.now();
    var movable = f.step === 'category' || f.step === 'ready' || f.step === 'clue' || f.step === 'done' || (f.step === 'reveal' && !f.shown);
    if (!movable) return false;
    this._snapshot();
    switch (f.step) {
      case 'category': f.step = 'wager'; break;
      case 'ready': f.step = 'clue'; f.deadline = t + this.s.opts.finalSeconds * 1000; f.timeUp = false; this._cue('thinkstart'); break;
      case 'clue': f.step = 'reveal'; f.deadline = null; f.ri = 0; f.shown = false; f.closedAt = f.closedAt || t; this._cue('thinkstop'); break;
      case 'reveal': f.shown = true; this._cue('select'); break;
      case 'done': this.s.phase = 'over'; this._cue('gameover'); break;
    }
    this._emit();
    return true;
  };

  Engine.prototype.finalShowAnswer = function () {
    var f = this.s.final;
    if (!f || f.step !== 'reveal' || f.answerShown) return false;
    f.answerShown = true;
    this._emit();
    return true;
  };

  Engine.prototype.finalJudge = function (correct) {
    var f = this.s.final;
    if (!f || f.step !== 'reveal' || !f.shown) return false;
    var pid = f.order[f.ri], p = this.player(pid);
    this._snapshot();
    var w = f.wagers[pid] || 0;
    p.score += correct ? w : -w;
    f.results[pid] = correct ? 'correct' : 'wrong';
    f.ri += 1;
    f.shown = false;
    this._cue(correct ? 'correct' : 'wrong', { pid: pid });
    if (f.ri >= f.order.length) { f.step = 'done'; f.answerShown = true; }
    this._emit();
    return true;
  };

  global.JeopardyEngine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);

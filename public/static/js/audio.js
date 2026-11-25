/* Sound effects and the Final round "think" loop, synthesised with Web Audio (no audio files).
 * All melodies are original to this app. A host can swap the think loop for their own sound file
 * (game option "Final Jeopardy music"). */
(function (global) {
  'use strict';

  var ctx = null, master = null, enabled = true, volume = 0.7;
  var thinkTimer = null, thinkNext = 0, thinkStep = 0, thinkGain = null;
  var track = null, trackSrc = '', trackFade = 0;

  function ensure() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  function tone(freq, at, dur, o) {
    o = o || {};
    var osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + dur);
    if (o.detune) osc.detune.value = o.detune;
    var peak = (o.gain == null ? 0.25 : o.gain);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + (o.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    var out = o.dest || master;
    if (o.lowpass) {
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = o.lowpass;
      osc.connect(f); f.connect(g);
    } else osc.connect(g);
    g.connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  function noise(at, dur, gainPeak, hp) {
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 2000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gainPeak || 0.1, at + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(at);
  }

  var N = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, E6: 1318.5, G6: 1568, C7: 2093 };

  var CUES = {
    select: function (t) {
      tone(520, t, 0.09, { type: 'triangle', gain: 0.2 });
      tone(780, t + 0.07, 0.14, { type: 'triangle', gain: 0.2 });
    },
    fill: function (t, d) {
      tone(600 + (d && d.i || 0) * 18, t, 0.05, { type: 'square', gain: 0.07, lowpass: 3000 });
    },
    category: function (t) {
      tone(330, t, 0.12, { type: 'triangle', gain: 0.22 });
      tone(495, t + 0.06, 0.18, { type: 'triangle', gain: 0.18 });
    },
    open: function (t) { tone(1500, t, 0.08, { type: 'sine', gain: 0.12 }); },
    ring: function (t) {
      tone(N.A5, t, 0.22, { type: 'square', gain: 0.12, lowpass: 3500 });
      tone(N.E6, t, 0.22, { type: 'sine', gain: 0.12 });
    },
    early: function (t) { tone(140, t, 0.16, { type: 'sawtooth', gain: 0.18, lowpass: 600 }); },
    frozen: function (t) { tone(140, t, 0.1, { type: 'sawtooth', gain: 0.12, lowpass: 600 }); },
    correct: function (t) {
      tone(N.C6, t, 0.3, { type: 'sine', gain: 0.22 });
      tone(N.E6, t + 0.09, 0.3, { type: 'sine', gain: 0.2 });
      tone(N.G6, t + 0.18, 0.5, { type: 'sine', gain: 0.2 });
    },
    ddcorrect: function (t) {
      [N.C5, N.E5, N.G5, N.C6, N.E6, N.G6, N.C7].forEach(function (f, i) {
        tone(f, t + i * 0.07, 0.4, { type: 'triangle', gain: 0.18 });
      });
    },
    wrong: function (t) {
      tone(110, t, 0.75, { type: 'sawtooth', gain: 0.28, lowpass: 900 });
      tone(116, t, 0.75, { type: 'square', gain: 0.14, lowpass: 900 });
    },
    timeup: function (t) {
      tone(N.C5, t, 0.35, { type: 'triangle', gain: 0.25 });
      tone(N.G4, t + 0.3, 0.35, { type: 'triangle', gain: 0.25 });
      tone(N.C4, t + 0.6, 0.7, { type: 'triangle', gain: 0.28 });
    },
    dailydouble: function (t) {
      noise(t, 0.9, 0.08, 3000);
      var seq = [N.C5, N.E5, N.G5, N.C6, N.G5, N.C6, N.E6, N.G6];
      seq.forEach(function (f, i) {
        tone(f, t + i * 0.11, 0.35, { type: 'sawtooth', gain: 0.12, lowpass: 2600 });
        tone(f * 2, t + i * 0.11, 0.2, { type: 'sine', gain: 0.07 });
      });
      tone(N.C6, t + 0.95, 1.2, { type: 'sawtooth', gain: 0.14, lowpass: 2600, detune: 8 });
      tone(N.E6, t + 0.95, 1.2, { type: 'sine', gain: 0.1 });
    },
    roundend: function (t) {
      [N.G4, N.C5, N.E5, N.G5].forEach(function (f, i) { tone(f, t + i * 0.14, 0.5, { type: 'triangle', gain: 0.2 }); });
    },
    final: function (t) {
      tone(98, t, 2.2, { type: 'sawtooth', gain: 0.1, lowpass: 400 });
      tone(147, t, 2.2, { type: 'sawtooth', gain: 0.07, lowpass: 400 });
      [N.G4, N.D5, N.G5].forEach(function (f, i) { tone(f, t + 0.8 + i * 0.25, 0.9, { type: 'triangle', gain: 0.14 }); });
    },
    gameover: function (t) {
      var chord = function (at, freqs, dur) { freqs.forEach(function (f) { tone(f, at, dur, { type: 'triangle', gain: 0.16 }); }); };
      chord(t, [N.C5, N.E5, N.G5], 0.35);
      chord(t + 0.35, [N.D5, N.F5, N.A5], 0.35);
      chord(t + 0.7, [N.E5, N.G5, N.B5], 0.35);
      chord(t + 1.05, [N.C5, N.E5, N.G5, N.C6], 1.6);
    },
    undo: function (t) { tone(600, t, 0.08, { type: 'triangle', gain: 0.15, to: 380 }); }
  };

  /* Think loop: a calm minor arpeggio over a soft pulse, about 30 seconds long at 92 BPM. */
  var CHORDS = [
    [220, 261.63, 329.63, 440],   // Am
    [174.61, 220, 261.63, 349.23], // F
    [196, 246.94, 293.66, 392],   // G
    [164.81, 207.65, 246.94, 329.63] // E
  ];
  var PATTERN = [0, 1, 2, 3, 2, 1, 2, 3];
  var STEP = 60 / 92 / 2;

  function scheduleThink() {
    while (thinkNext < ctx.currentTime + 0.25) {
      var bar = Math.floor(thinkStep / 8) % CHORDS.length, pos = thinkStep % 8;
      var chord = CHORDS[bar];
      tone(chord[PATTERN[pos]] * 2, thinkNext, STEP * 1.6, { type: 'triangle', gain: 0.1, dest: thinkGain });
      if (pos === 0) tone(chord[0] / 2, thinkNext, STEP * 7, { type: 'sine', gain: 0.16, dest: thinkGain });
      if (pos % 4 === 0) tone(1800, thinkNext, 0.03, { type: 'square', gain: 0.025, dest: thinkGain });
      thinkNext += STEP;
      thinkStep += 1;
    }
  }

  var Sound = {
    unlock: function () { return ensure(); },
    setEnabled: function (on) { enabled = !!on; if (!enabled) Sound.thinkStop(); },
    isEnabled: function () { return enabled; },
    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume;
      if (track && !track.paused && !trackFade) track.volume = volume;
    },
    play: function (name, data) {
      if (!enabled || !CUES[name] || !ensure()) return;
      CUES[name](ctx.currentTime + 0.01, data);
    },
    /* Use a sound file (the host's own, e.g. uploaded in Media files) as the Final think music; '' = built-in loop. */
    setThinkTrack: function (src) {
      src = src || '';
      if (src === trackSrc) return;
      if (track) track.pause();
      trackSrc = src;
      track = null;
      if (src) { track = new Audio(); track.preload = 'auto'; track.src = src; }
    },
    thinkStart: function () {
      if (!enabled) return;
      if (track) {
        if (!track.paused && !trackFade) return;
        clearInterval(trackFade); trackFade = 0;
        track.volume = volume;
        try { track.currentTime = 0; } catch (e) { /* not loaded yet: it starts from 0 anyway */ }
        var playing = track.play();
        // A missing or unplayable file falls back to the built-in music so Final is never silent.
        if (playing && playing.catch) playing.catch(function () { if (trackSrc) startLoop(); });
        return;
      }
      startLoop();
    },
    thinkStop: function () {
      if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
      if (thinkGain && ctx) {
        thinkGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
        thinkGain = null;
      }
      if (track && !track.paused && !trackFade) {
        var t = track;
        trackFade = setInterval(function () {
          t.volume = Math.max(0, t.volume - 0.08);
          if (t.volume <= 0.01) { clearInterval(trackFade); trackFade = 0; t.pause(); }
        }, 30);
      }
    }
  };

  function startLoop() {
    if (!ensure() || thinkTimer) return;
    thinkGain = ctx.createGain();
    thinkGain.gain.value = 1;
    thinkGain.connect(master);
    thinkNext = ctx.currentTime + 0.05;
    thinkStep = 0;
    scheduleThink();
    thinkTimer = setInterval(scheduleThink, 50);
  }

  global.FJSound = Sound;
})(window);

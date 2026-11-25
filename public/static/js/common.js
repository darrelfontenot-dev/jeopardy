/* Small helpers shared by the setup, game and host screens. */
(function (global) {
  'use strict';

  var FJ = {};

  FJ.esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  FJ.money = function (n) {
    var abs = Math.abs(Math.round(n)).toLocaleString('en-US');
    return (n < 0 ? '-$' : '$') + abs;
  };

  FJ.ADMIN_KEY = 'fj.admin.v1';

  /* The admin password (saved by the Manage questions unlock prompt) rides along on admin calls. */
  var nativeFetch = global.fetch.bind(global);
  global.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/^\/api\/(admin|me)/.test(url)) {
      var key = '';
      try { key = localStorage.getItem(FJ.ADMIN_KEY) || ''; } catch (e) { /* storage blocked */ }
      if (key) { init = Object.assign({}, init); init.headers = Object.assign({}, init.headers, { 'x-admin-key': key }); }
    }
    return nativeFetch(input, init);
  };

  FJ.api = function (path, opts) {
    return fetch(path, opts).then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(function () { return {}; }).then(function (b) {
        var err = new Error(b.detail || ('Request failed (' + r.status + ')'));
        err.status = r.status;
        throw err;
      });
    });
  };

  FJ.wordCount = function (text) { return String(text || '').trim().split(/\s+/).filter(Boolean).length; };

  var MEDIA_EXT = {
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
    mp4: 'video', webm: 'video', m4v: 'video', mov: 'video',
    mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio'
  };

  /* A clue's Media cell -> { kind: 'image'|'video'|'audio'|'embed', src, name } or null.
   * Plain names are files uploaded in Manage questions; links can be direct files, YouTube or Vimeo. */
  FJ.mediaInfo = function (ref) {
    ref = String(ref || '').trim();
    if (!ref) return null;
    var m;
    if (/^https?:\/\//i.test(ref)) {
      if ((m = ref.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i))) {
        return { kind: 'embed', src: 'https://www.youtube-nocookie.com/embed/' + m[1] + '?autoplay=1&rel=0&modestbranding=1', name: ref };
      }
      if ((m = ref.match(/vimeo\.com\/(?:video\/)?(\d+)/i))) {
        return { kind: 'embed', src: 'https://player.vimeo.com/video/' + m[1] + '?autoplay=1', name: ref };
      }
      var ext = (ref.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1];
      return { kind: MEDIA_EXT[(ext || '').toLowerCase()] || 'image', src: ref, name: ref };
    }
    var kind = MEDIA_EXT[((ref.match(/\.(\w+)$/) || [])[1] || '').toLowerCase()];
    return kind ? { kind: kind, src: '/api/media/' + encodeURIComponent(ref), name: ref } : null;
  };

  FJ.SAVE_KEY = 'fj.save.v1';
  FJ.PREFS_KEY = 'fj.prefs.v1';
  FJ.CHANNEL = 'fj-sync-v1';

  FJ.loadPrefs = function () {
    try { return JSON.parse(localStorage.getItem(FJ.PREFS_KEY)) || {}; } catch (e) { return {}; }
  };
  FJ.savePrefs = function (p) {
    try { localStorage.setItem(FJ.PREFS_KEY, JSON.stringify(p)); } catch (e) { /* storage full or blocked */ }
  };

  /* How human a speech voice sounds: neural (Edge "Natural", Google) beats the old desktop voices. */
  FJ.voiceScore = function (v) {
    var n = v.name, sc = 0;
    if (/natural/i.test(n)) sc += 100;
    if (/online/i.test(n)) sc += 20;
    if (/^Google/i.test(n)) sc += 60;
    if (/(Andrew|Guy|Christopher|Eric|Brian|Davis|Aria|Jenny|Ava|Emma)/i.test(n)) sc += 15;
    if (/en-US/i.test(v.lang)) sc += 10;
    if (/(David|Zira|Mark|Hazel|George)/i.test(n) && !/natural/i.test(n)) sc -= 20;
    return sc;
  };

  FJ.roundLabel = function (s) {
    if (s.phase === 'final' || s.phase === 'over' && s.final) return 'FINAL JEOPARDY';
    var b = s.boards[s.round];
    return b ? b.name.toUpperCase() : '';
  };

  /* Which step wording the host sees, shared by the display and the host console. */
  FJ.stepHint = function (s) {
    var k = s.clue;
    if (s.phase === 'intro') return 'Meet the categories';
    if (s.phase === 'board') return 'Waiting for a clue to be picked';
    if (s.phase === 'round_end') return 'Round complete';
    if (s.phase === 'over') return 'Game over';
    if (s.phase === 'final') {
      return { category: 'Reveal the category', wager: 'Collecting secret wagers', ready: 'Wagers are in', clue: 'Players are writing their answers', reveal: 'Revealing answers', done: 'All answers judged' }[s.final.step] || '';
    }
    if (!k) return '';
    return {
      dd_splash: 'Daily Double!', dd_wager: 'Waiting for the wager', reading: k.dd ? 'Read the clue, then start the answer clock' : 'Read the clue aloud, then open the buzzers',
      open: 'Buzzers are open', answering: 'Judge the response', reveal: 'Answer revealed'
    }[k.step] || '';
  };

  global.FJ = FJ;
})(window);

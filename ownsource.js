/* BEOOND TV · "Eigene Quelle" in the online version – everything stays on this device.
   The M3U address (it carries user name and password) is kept only in this browser's storage and is never sent to
   a BEOOND server: the playlist is fetched by the browser itself, or imported as a file, and every stream plays
   straight from the provider into this device's video element. BEOOND only supplies the interface.

   What the browser allows (no library changes this):
   - Fetching the playlist needs the provider to allow other sites (CORS). Without it: import the .m3u file.
   - An https page cannot play http streams (mixed content). The address must be https.
   - Live channels play as HLS (.m3u8) in the device's own player (Android Chrome, Safari) without CORS; hls.js in
     other browsers needs CORS. Raw MPEG-TS is not played by any browser on its own.
   - A stream address handed to Chromecast (the Cast button in the player) includes the credentials – the
     Chromecast fetches the stream itself. */
(() => {
  const $ = s => document.querySelector(s);
  const KEY = 'beoond-own-src', DB = 'beoond-own', STORE = 'lists';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const cloud = () => typeof ACCOUNT !== 'undefined' && ACCOUNT && ACCOUNT.mode === 'cloud';
  const STANDALONE = document.documentElement.dataset.player === 'own';   // play.beoond.co: the http player page
  const PLAY = 'http://play.beoond.co/';
  let LIST = null, view = {kind: 'live', group: '', q: ''}, hls = null, current = null, watchdog = 0;

  /* ---------- storage: this device only ---------- */
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {} },
  };
  function idb(mode, fn) {
    return new Promise((ok, bad) => {
      let r; try { r = indexedDB.open(DB, 1); } catch (e) { return bad(e); }
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onerror = () => bad(r.error);
      r.onsuccess = () => { const t = r.result.transaction(STORE, mode), s = t.objectStore(STORE), q = fn(s); t.oncomplete = () => ok(q && q.result); t.onerror = () => bad(t.error); };
    });
  }
  const saveList = l => idb('readwrite', s => s.put(l, 'main')).catch(() => {});
  const loadList = () => idb('readonly', s => s.get('main')).catch(() => null);
  const dropList = () => idb('readwrite', s => s.delete('main')).catch(() => {});

  /* ---------- M3U / M3U Plus ---------- */
  const attr = (line, name) => { const m = line.match(new RegExp(name + '="([^"]*)"', 'i')); return m ? m[1].trim() : ''; };
  function kindOf(url, group) {
    if (/\/movie\//i.test(url)) return 'movie';
    if (/\/series\//i.test(url)) return 'series';
    if (/\.(mp4|mkv|avi|mov)(\?|$)/i.test(url) && !/\/live\//i.test(url)) return /serie|staffel|season|s\d\de\d\d/i.test(group) ? 'series' : 'movie';
    return 'live';
  }
  function parse(text) {
    if (!/^\s*#EXTM3U/i.test(text)) throw new Error('Das ist keine M3U-Senderliste.');
    const out = [], lines = text.split(/\r?\n/);
    let info = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        const comma = line.lastIndexOf(',');
        info = {name: (comma >= 0 ? line.slice(comma + 1) : '').trim() || attr(line, 'tvg-name'), logo: attr(line, 'tvg-logo'), epg: attr(line, 'tvg-id'), group: attr(line, 'group-title') || 'Ohne Gruppe'};
      } else if (!line.startsWith('#') && info) {
        out.push({n: info.name.slice(0, 160), l: info.logo.slice(0, 500), e: info.epg.slice(0, 120), g: info.group.slice(0, 120), u: line, k: kindOf(line, info.group)});
        info = null;
      }
    }
    if (!out.length) throw new Error('In der Liste wurden keine Einträge gefunden.');
    return out;
  }

  /* ---------- import: straight from the provider, or from a file ---------- */
  async function fetchPlaylist(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('Das ist keine gültige Adresse.'); }
    if (u.protocol !== 'https:' && location.protocol === 'https:') { const e = new Error('Dein Anbieter liefert nur über http://. Lade die Liste als Datei: „Liste herunterladen“ antippen, danach hier „Datei wählen“.'); e.http = u.href; throw e; }
    let r;
    try { r = await fetch(u.href, {credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'}); }
    catch { const e = new Error('Dein Anbieter erlaubt den direkten Abruf im Browser nicht (CORS). Lade die Liste stattdessen als Datei: Adresse im Browser öffnen, Datei speichern, hier „Datei wählen“.'); e.cors = true; throw e; }
    if (r.status === 401 || r.status === 403) throw new Error('Der Anbieter lehnt den Zugang ab (' + r.status + '). Benutzername und Passwort prüfen.');
    if (!r.ok) throw new Error('Der Anbieter antwortet mit Fehler ' + r.status + '.');
    return r.text();
  }
  async function importText(text, src) {
    const entries = parse(text);
    LIST = {at: Date.now(), entries};
    await saveList(LIST);
    store.set(src);
    return entries;
  }

  /* ---------- player: provider -> this device ---------- */
  function variants(url) {
    // Xtream: http(s)://host:port/[live/]user/pass/123[.ts|.m3u8] – the HLS form plays in the device's own player
    const out = [];
    const m = url.match(/^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.(ts|m3u8))?(\?.*)?$/i);
    if (m && !/\/(movie|series)\//i.test(url)) out.push(`${m[1]}/live/${m[2]}/${m[3]}/${m[4]}.m3u8`);
    out.push(url);
    return [...new Set(out)];
  }
  function stop() {
    clearTimeout(watchdog);
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    const v = $('#own-video');
    if (v) { try { v.pause(); } catch {} v.removeAttribute('src'); v.load(); }
  }
  function say(t, bad) { const s = $('#own-status'); if (s) { s.textContent = t; s.classList.toggle('bad', !!bad); s.hidden = !t; } }
  async function play(entry) {
    current = entry;
    const d = $('#own-player');
    if (!d.open) d.showModal();
    $('#own-title').textContent = entry.n;
    stop();
    if (window.duckRadio) duckRadio();
    const v = $('#own-video'), tries = variants(entry.u), nativeHls = v.canPlayType('application/vnd.apple.mpegurl') !== '';
    for (const u of tries) {
      if (location.protocol === 'https:' && u.startsWith('http:')) { external(entry); return; }
      const isHls = /\.m3u8(\?|$)/i.test(u);
      say('Wird geladen …');
      const ok = await new Promise(res => {
        const done = r => { clearTimeout(watchdog); v.onplaying = v.onerror = null; res(r); };
        v.onplaying = () => done(true);
        v.onerror = () => done(false);
        watchdog = setTimeout(() => done(false), 15000);
        if (isHls && !nativeHls && window.Hls && Hls.isSupported()) {
          hls = new Hls({maxBufferLength: 30, enableWorker: true});
          hls.on(Hls.Events.ERROR, (_, e) => { if (e.fatal) done(false); });
          hls.loadSource(u); hls.attachMedia(v);
        } else if (!isHls || nativeHls) {
          v.src = u;
        } else { done(false); return; }
        v.play().catch(() => {});
      });
      if (ok) { say(''); return; }
      stop();
    }
    say(nativeHls ? 'Der Stream ließ sich nicht abspielen. Mögliche Ursachen: Sender offline, Format/Codec nicht unterstützt oder Zugang abgelaufen.'
      : 'Der Stream ließ sich nicht abspielen. Dieser Browser braucht für Live-Sender eine CORS-Freigabe des Anbieters – auf dem Handy (Chrome/Safari) klappt es oft trotzdem.', true);
  }

  /* http streams cannot play inside an https page (mixed content), so they open in VLC on this device.
     The address goes straight from this page to the VLC app – still provider -> device, nothing via BEOOND. */
  function external(entry) {
    const u = entry.url || entry.u, ua = navigator.userAgent, android = /Android/i.test(ua), ios = /iPhone|iPad|iPod/i.test(ua);
    const vlc = android ? `intent://${u.replace(/^https?:\/\//, '')}#Intent;scheme=${u.split(':')[0]};package=org.videolan.vlc;type=video/*;S.title=${encodeURIComponent(entry.n)};end`
      : ios ? 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(u) : '';
    const s = $('#own-status');
    s.hidden = false; s.classList.remove('bad');
    s.innerHTML = `Dieser Sender kommt über http:// – im Browser auf einer https-Seite gesperrt. Er öffnet sich deshalb direkt in VLC (der Stream läuft weiter nur vom Anbieter auf dein Gerät; in VLC kannst du auch an Chromecast senden).<br>
      ${vlc ? `<a class="btn primary own-vlc" href="${esc(vlc)}">▶ In VLC öffnen</a>` : ''} <button class="btn own-copy">Stream-Adresse kopieren</button>`;
    const c = s.querySelector('.own-copy');
    c.onclick = () => navigator.clipboard.writeText(u).then(() => { c.textContent = 'Kopiert'; }, () => {});
    if (vlc) location.href = vlc;
  }

  /* ---------- the screen ---------- */
  function shell() {
    if ($('#own-dialog')) return;
    document.body.insertAdjacentHTML('beforeend', `
<dialog id="own-dialog" class="own-sheet"><button class="close" aria-label="Schließen">×</button><div class="own-body"></div></dialog>
<dialog id="own-player" class="own-player"><div class="own-ph"><strong id="own-title"></strong><span class="own-ph-a"><button id="own-fs" class="icon-btn" aria-label="Vollbild">⛶</button><button class="close" aria-label="Schließen">×</button></span></div>
<video id="own-video" controls playsinline preload="none"></video><p id="own-status" hidden></p></dialog>`);
    $('#own-dialog .close').onclick = () => STANDALONE ? (location.href = 'https://tv.beoond.co/') : $('#own-dialog').close();
    if (STANDALONE) $('#own-dialog').addEventListener('cancel', e => e.preventDefault());
    $('#own-player .close').onclick = () => { stop(); $('#own-player').close(); };
    $('#own-player').addEventListener('close', stop);
    $('#own-fs').onclick = () => { const v = $('#own-video'); (v.requestFullscreen || v.webkitEnterFullscreen || (() => {})).call(v); };
  }
  function setupForm(msg) {
    const d = $('#own-dialog');
    d.querySelector('.own-body').innerHTML = `<p class="eyebrow">EIGENE QUELLE · NUR AUF DIESEM GERÄT</p><h2>Deine Bibliothek verbinden</h2>
      <p class="muted">Füge die M3U-Adresse deines Anbieters ein. Sie bleibt nur in diesem Browser gespeichert und wird nie an BEOOND gesendet. Die Streams laufen direkt vom Anbieter auf dieses Gerät.</p>
      <label class="own-field">M3U-Adresse<input id="own-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://anbieter:8080/get.php?username=…&password=…&type=m3u_plus&output=ts"></label>
      <div class="own-actions"><button class="primary" id="own-load">Liste laden</button><label class="btn own-file">Datei wählen (.m3u)<input id="own-file" type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/x-mpegurl,text/plain" hidden></label></div>
      <p id="own-msg" class="own-msg ${msg ? 'bad' : ''}">${esc(msg || '')}</p>
      ${STANDALONE ? '<p class="muted small">Dieser Player läuft bewusst über http, damit dein Browser die http-Streams deines Anbieters abspielen darf. Konto und Login bleiben auf tv.beoond.co.</p>' : ''}<p class="muted small">Nur für Inhalte, die du nutzen darfst. BEOOND speichert, sieht und überträgt deine Quelle nicht.</p>`;
    const m = $('#own-msg');
    $('#own-load').onclick = async () => {
      const url = $('#own-url').value.trim(); if (!url) return;
      m.className = 'own-msg'; m.textContent = 'Liste wird geladen …';
      try { const e = await importText(await fetchPlaylist(url), {url}); browse(`${e.length} Einträge geladen.`); }
      catch (e) {
        m.className = 'own-msg bad'; m.textContent = e.message;
        if (e.http || e.cors) { const a = document.createElement('a'); a.className = 'btn own-dl'; a.textContent = 'Liste herunterladen'; a.href = e.http || url; a.target = '_blank'; a.rel = 'noopener noreferrer'; m.append(document.createElement('br'), a); }
      }
    };
    $('#own-file').onchange = async ev => {
      const f = ev.target.files[0]; if (!f) return;
      m.className = 'own-msg'; m.textContent = 'Datei wird gelesen …';
      try { const e = await importText(await f.text(), {file: f.name}); browse(`${e.length} Einträge aus der Datei geladen.`); }
      catch (e) { m.className = 'own-msg bad'; m.textContent = e.message; }
    };
  }
  function browse(note) {
    const d = $('#own-dialog'), all = (LIST && LIST.entries) || [];
    const counts = {live: 0, movie: 0, series: 0}; all.forEach(x => counts[x.k]++);
    if (!counts[view.kind]) view.kind = ['live', 'movie', 'series'].find(k => counts[k]) || 'live';
    const ofKind = all.filter(x => x.k === view.kind);
    const groups = [...new Set(ofKind.map(x => x.g))];
    const q = view.q.toLowerCase();
    const shown = ofKind.filter(x => (!view.group || x.g === view.group) && (!q || x.n.toLowerCase().includes(q))).slice(0, 300);
    const src = store.get() || {};
    d.querySelector('.own-body').innerHTML = `<p class="eyebrow">EIGENE QUELLE · NUR AUF DIESEM GERÄT</p>
      <div class="own-top"><h2>Meine Bibliothek</h2><span class="muted small">${esc(src.file ? 'aus Datei ' + src.file : 'direkt vom Anbieter')} · ${all.length} Einträge</span></div>
      ${note ? `<p class="own-msg ok">${esc(note)}</p>` : ''}
      <div class="own-tabs">${[['live', 'Live-TV'], ['movie', 'Filme'], ['series', 'Serien']].filter(([k]) => counts[k]).map(([k, t]) => `<button class="chip${view.kind === k ? ' on' : ''}" data-k="${k}">${t} <span>${counts[k]}</span></button>`).join('')}</div>
      <div class="own-filter"><input id="own-q" type="search" placeholder="Suchen …" value="${esc(view.q)}"><select id="own-g"><option value="">Alle Gruppen (${groups.length})</option>${groups.map(g => `<option${g === view.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
      <div class="own-list">${shown.map((x, i) => `<button class="own-item" data-i="${all.indexOf(x)}"><span class="own-logo">${esc((x.n || '?').slice(0, 2).toUpperCase())}</span><span><strong>${esc(x.n)}</strong><small>${esc(x.g)}</small></span><span class="own-play" aria-hidden="true">▶</span></button>`).join('') || '<p class="muted">Nichts gefunden.</p>'}</div>
      ${shown.length >= 300 ? '<p class="muted small">Die ersten 300 – Suche oder Gruppe eingrenzen.</p>' : ''}
      <div class="own-actions"><button class="btn" id="own-reload">Neu laden</button><button class="btn" id="own-change">Andere Quelle</button><button class="btn danger" id="own-remove">Von diesem Gerät entfernen</button></div>`;
    d.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { view = {kind: b.dataset.k, group: '', q: view.q}; browse(); });
    $('#own-g').onchange = e => { view.group = e.target.value; browse(); };
    let t = 0; $('#own-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { view.q = e.target.value; browse(); const i = $('#own-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    d.querySelectorAll('[data-i]').forEach(b => b.onclick = () => play(all[+b.dataset.i]));
    $('#own-change').onclick = () => setupForm();
    $('#own-reload').onclick = async () => {
      if (!src.url) return setupForm('Die Liste kam aus einer Datei – bitte die neue Datei wählen.');
      try { await importText(await fetchPlaylist(src.url), src); browse('Aktualisiert.'); } catch (e) { setupForm(e.message); }
    };
    $('#own-remove').onclick = async () => { store.set(null); LIST = null; await dropList(); setupForm(); };
  }
  async function open() {
    shell();
    const d = $('#own-dialog');
    if (!LIST) LIST = await loadList();
    LIST && LIST.entries && LIST.entries.length ? browse() : setupForm();
    if (!d.open) d.showModal();
  }
  window.openOwnSource = () => cloud() && location.protocol === 'https:' ? (location.href = PLAY) : open();
  if (STANDALONE) addEventListener('DOMContentLoaded', open);
  window.ownMenu = menu => {
    if (!cloud()) return;
    const kids = typeof ACCOUNT !== 'undefined' && ACCOUNT && ACCOUNT.kids && ACCOUNT.kids.active;
    if (kids) return;
    const at = menu.querySelector('[data-am="film"]'), html = `<button data-own>＋ Eigene Quelle · nur auf diesem Gerät</button>`;
    at ? at.insertAdjacentHTML('afterend', html) : menu.insertAdjacentHTML('beforeend', html);
    menu.querySelector('[data-own]').onclick = e => { e.stopPropagation(); menu.hidden = true; location.href = PLAY; };
  };
})();

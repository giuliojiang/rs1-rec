'use strict';
/* rs1-rec — encrypted choir recording browser (no build step, no external deps)
 *
 * Same vault as automatic-bassoon-v3: PBKDF2-SHA256 -> AES-256-GCM.
 * Each file on disk is IV(12) || ciphertext+tag, named "<name>.mp3.enc".
 * The browser decrypts in memory only after the PIN check against probe.enc.
 */

const app = document.getElementById('app');

const VAULT_SALT = 'fd133808a8e34abd69bf5d4c08f6efeb';
const VAULT_ITERATIONS = 20000000;
const PROBE_URL = 'probe.enc';
const PROBE_TEXT = 'rs1-vault-probe::ok';
const PIN_LENGTH = 6;

let manifest = null;
let keyHandler = null;
let vaultKey = null;

function setKeyHandler(fn) {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = fn;
  if (fn) document.addEventListener('keydown', fn);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= PIN ================= */

async function deriveVaultKey(pin) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(VAULT_SALT), iterations: VAULT_ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function renderPin() {
  let entry = '';
  let verifying = false;
  app.innerHTML = `
    <div class="pin-screen" id="pinScreen">
      <div class="pin-title">RS1 Recordings</div>
      <div class="pin-dots" id="pinDots">${'<div class="pin-dot"></div>'.repeat(PIN_LENGTH)}</div>
      <div class="pin-loading" id="pinLoading" hidden>Loading…</div>
      <div class="pin-pad" id="pinPad"></div>
    </div>`;

  const dots = document.getElementById('pinDots').children;
  const pad = document.getElementById('pinPad');
  // WebCrypto needs a secure context; on plain HTTP the PIN can never verify,
  // so say so instead of shaking on every attempt.
  if (!window.crypto || !crypto.subtle) {
    pad.innerHTML = '<div class="pin-insecure">Unlocking needs a secure connection.<br>Please open<br><b>https://giuliojiang.github.io/rs1-rec</b></div>';
    return;
  }
  const keys = ['1','2','3','4','5','6','7','8','9','C','0','⌫'];
  for (const k of keys) {
    const b = document.createElement('button');
    b.className = 'pin-key' + (k === 'C' || k === '⌫' ? ' fn' : '');
    b.textContent = k;
    b.addEventListener('click', () => press(k));
    pad.appendChild(b);
  }

  function draw() {
    for (let i = 0; i < PIN_LENGTH; i++) dots[i].classList.toggle('filled', i < entry.length);
  }
  function deny() {
    const screen = document.getElementById('pinScreen');
    screen.classList.remove('shake');
    void screen.offsetWidth; // restart animation
    screen.classList.add('shake');
    entry = '';
    draw();
  }
  async function submit() {
    if (entry.length !== PIN_LENGTH || verifying) return;
    verifying = true;
    // Show the loading state and let the browser paint it before the
    // ~1s key derivation blocks the main thread.
    const loading = document.getElementById('pinLoading');
    loading.hidden = false;
    pad.style.visibility = 'hidden';
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const key = await deriveVaultKey(entry);
      const res = await fetch(PROBE_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('probe fetch failed');
      const buf = new Uint8Array(await res.arrayBuffer());
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf.slice(0, 12) },
        key, buf.slice(12));
      if (new TextDecoder().decode(pt) !== PROBE_TEXT) throw new Error('bad pin');
      vaultKey = key;
      renderFolders();
    } catch (e) {
      deny();
    } finally {
      verifying = false;
      loading.hidden = true;
      pad.style.visibility = '';
    }
  }
  function press(k) {
    if (verifying) return;
    if (k === 'C') { entry = ''; }
    else if (k === '⌫') { entry = entry.slice(0, -1); }
    else if (entry.length < PIN_LENGTH) { entry += k; if (entry.length === PIN_LENGTH) { draw(); submit(); return; } }
    draw();
  }

  setKeyHandler(e => {
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') { entry = ''; draw(); }
  });
  draw();
}

/* ================= HELPERS ================= */

function recUrl(folder, file) {
  return 'recordings/' + encodeURIComponent(folder.name) + '/' + encodeURIComponent(file);
}
function encUrl(folder, file) {
  return recUrl(folder, file) + '.enc';
}

/* ================= PLAYER (minimal, same as automatic-bassoon-v3) ================= */
/* One persistent player bar, pinned to the top of the screen in both views.
 * It lives outside #app, so re-rendering a view never interrupts playback.
 * Audio files are encrypted exactly like the vault (AES-256-GCM, same vault
 * key, "<name>.mp3.enc") and decrypted in memory; the <audio> element plays
 * from a blob URL, so seeking works. */

let audioEl = null;
let playerBar = null;
let playerEls = null; // { toggle, seek, time, title, close }
let playerTrack = null; // { folder, file, encUrl, blobUrl, title }
let playerSeeking = false;
const audioBlobs = new Map(); // enc url -> blob url

function fmtTime(s) {
  if (!isFinite(s) || s == null) return '0:00';
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function createPlayerBar() {
  const bar = document.createElement('div');
  bar.id = 'playerBar';
  bar.className = 'player-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="player-title" id="playerTitle"></div>
    <div class="player-row">
      <button class="player-btn" id="playerToggle" aria-label="Play or pause">▶</button>
      <input class="player-seek" id="playerSeek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
      <span class="player-time" id="playerTime">0:00 / 0:00</span>
      <button class="player-btn ghost" id="playerClose" aria-label="Stop and close">✕</button>
    </div>`;
  document.body.appendChild(bar);
  playerBar = bar;
  playerEls = {
    toggle: bar.querySelector('#playerToggle'),
    seek: bar.querySelector('#playerSeek'),
    time: bar.querySelector('#playerTime'),
    title: bar.querySelector('#playerTitle'),
    close: bar.querySelector('#playerClose'),
  };

  audioEl = new Audio();
  audioEl.preload = 'metadata';
  audioEl.addEventListener('loadedmetadata', updatePlayerUi);
  audioEl.addEventListener('timeupdate', updatePlayerUi);
  audioEl.addEventListener('play', () => { playerEls.toggle.textContent = '❚❚'; markPlayingRow(); });
  audioEl.addEventListener('pause', () => { playerEls.toggle.textContent = '▶'; markPlayingRow(); });
  audioEl.addEventListener('ended', () => { playerEls.toggle.textContent = '▶'; markPlayingRow(); });

  playerEls.toggle.addEventListener('click', onPlayerToggle);
  playerEls.close.addEventListener('click', stopPlayer);
  playerEls.seek.addEventListener('pointerdown', () => { playerSeeking = true; });
  playerEls.seek.addEventListener('input', () => {
    if (audioEl.duration) audioEl.currentTime = (playerEls.seek.value / 1000) * audioEl.duration;
    updatePlayerUi();
  });
  playerEls.seek.addEventListener('change', () => { playerSeeking = false; });
  playerEls.seek.addEventListener('pointerup', () => { playerSeeking = false; });
}

function updatePlayerUi() {
  if (!playerEls || !playerTrack) return;
  const d = audioEl.duration || 0;
  const c = audioEl.currentTime || 0;
  playerEls.time.textContent = fmtTime(c) + ' / ' + fmtTime(d);
  if (!playerSeeking && d > 0) {
    const v = Math.round((c / d) * 1000);
    playerEls.seek.value = v;
    playerEls.seek.style.background =
      'linear-gradient(90deg, #1a1a1e ' + (v / 10) + '%, #e0e0e6 ' + (v / 10) + '%)';
  }
}

function showPlayerBar() {
  playerBar.hidden = false;
  document.body.classList.add('has-player');
}
function hidePlayerBar() {
  playerBar.hidden = true;
  document.body.classList.remove('has-player');
}

function syncPlayerBar() {
  if (playerTrack) {
    playerEls.title.textContent = playerTrack.title;
    playerEls.toggle.textContent = audioEl.paused ? '▶' : '❚❚';
    showPlayerBar();
    updatePlayerUi();
    return;
  }
  hidePlayerBar();
}

async function onPlayerToggle() {
  if (!playerTrack) return;
  if (audioEl.paused) { try { await audioEl.play(); } catch {} }
  else audioEl.pause();
}

async function decryptedBlobUrl(folder, file) {
  const url = encUrl(folder, file);
  let blobUrl = audioBlobs.get(url);
  if (blobUrl) return blobUrl;
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('fetch failed: ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.slice(0, 12) }, vaultKey, buf.slice(12));
  blobUrl = URL.createObjectURL(new Blob([pt], { type: 'audio/mpeg' }));
  audioBlobs.set(url, blobUrl);
  return blobUrl;
}

async function loadTrack(folder, file) {
  if (!vaultKey) return;
  const url = encUrl(folder, file);
  const label = file.replace(/\.mp3$/i, '');
  // Tapping the loaded track's row toggles play/pause.
  if (playerTrack && playerTrack.encUrl === url) { onPlayerToggle(); return; }
  playerTrack = null;
  audioEl.pause();
  showPlayerBar();
  playerEls.title.textContent = folder.title + ' — ' + label;
  playerEls.toggle.textContent = '▶';
  playerEls.time.textContent = 'Loading…';
  playerEls.seek.value = 0;
  playerEls.seek.style.background = '#e0e0e6';
  markPlayingRow();
  try {
    const blobUrl = await decryptedBlobUrl(folder, file);
    playerTrack = { folder, file, encUrl: url, blobUrl, title: folder.title + ' — ' + label };
    audioEl.src = blobUrl;
    markPlayingRow();
    try { await audioEl.play(); } catch {
      // Some browsers only allow play() from a direct tap: the bar now
      // shows ▶, so one more tap starts it.
    }
  } catch (e) {
    playerEls.title.textContent = 'Could not load audio — ' + label;
    playerEls.time.textContent = '0:00 / 0:00';
  }
}

function stopPlayer() {
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  playerTrack = null;
  markPlayingRow();
  syncPlayerBar();
}

function markPlayingRow() {
  document.querySelectorAll('.track-row').forEach(row => {
    const isCurrent = !!(playerTrack && !audioEl.paused &&
      row.dataset.folder === playerTrack.folder.name && row.dataset.file === playerTrack.file);
    row.classList.toggle('playing', isCurrent);
    const btn = row.querySelector('.play-btn');
    if (btn) btn.textContent = isCurrent ? '❚❚' : '▶';
  });
}

/* ================= FOLDER / TRACK BROWSER ================= */

let folderQuery = '';

function renderFolders() {
  setKeyHandler(null);
  app.innerHTML = `
    <div class="library">
      <h1>RS1 Recordings</h1>
      <div class="sub" id="libSub"></div>
      <input class="search" id="search" placeholder="Search…" autocomplete="off">
      <div class="grid" id="grid"></div>
      <div class="empty" id="empty" style="display:none">No folders found.</div>
    </div>`;
  document.getElementById('libSub').textContent =
    (manifest.folders || []).length + ' session' + ((manifest.folders || []).length === 1 ? '' : 's');
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');

  function drawGrid() {
    const q = folderQuery.toLowerCase();
    const folders = (manifest.folders || []).filter(f =>
      f.title.toLowerCase().includes(q));
    grid.innerHTML = '';
    empty.style.display = folders.length ? 'none' : 'block';
    for (const f of folders) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-body">
          <div class="card-title">${esc(f.title)}</div>
          <div class="card-meta">${f.files.length} track${f.files.length === 1 ? '' : 's'}</div>
        </div>`;
      card.addEventListener('click', () => renderFolder(f));
      grid.appendChild(card);
    }
  }

  search.addEventListener('input', e => { folderQuery = e.target.value; search.value = folderQuery; drawGrid(); });
  search.value = folderQuery;
  drawGrid();
  syncPlayerBar();
}

function renderFolder(folder) {
  setKeyHandler(null);
  app.innerHTML = `
    <div class="library">
      <button class="back-btn" id="backBtn">‹ Folders</button>
      <h1>${esc(folder.title)}</h1>
      <div class="sub" id="libSub"></div>
      <input class="search" id="search" placeholder="Search tracks…" autocomplete="off">
      <div class="track-list" id="trackList"></div>
      <div class="empty" id="empty" style="display:none">No tracks found.</div>
    </div>`;
  document.getElementById('libSub').textContent =
    folder.files.length + ' track' + (folder.files.length === 1 ? '' : 's');
  const list = document.getElementById('trackList');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');
  let q = '';

  document.getElementById('backBtn').addEventListener('click', () => renderFolders());

  function drawList() {
    const files = folder.files.filter(f => f.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = '';
    empty.style.display = files.length ? 'none' : 'block';
    for (const file of files) {
      const label = file.replace(/\.mp3$/i, '');
      const row = document.createElement('div');
      row.className = 'track-row';
      row.dataset.folder = folder.name;
      row.dataset.file = file;
      row.innerHTML = `
        <button class="play-btn" aria-label="Play ${esc(label)}">▶</button>
        <span class="track-label">${esc(label)}</span>
        <button class="dl-btn small" data-stop="1" aria-label="Download ${esc(label)}">⭳</button>`;
      row.addEventListener('click', () => loadTrack(folder, file));
      const dlBtn = row.querySelector('.dl-btn');
      dlBtn.addEventListener('click', (e) => { e.stopPropagation(); onTrackDownload(folder, file, dlBtn); });
      list.appendChild(row);
    }
    markPlayingRow();
  }

  search.addEventListener('input', e => { q = e.target.value; drawList(); });
  drawList();
  syncPlayerBar();
}

async function onTrackDownload(folder, file, btn) {
  if (!vaultKey) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const blobUrl = await decryptedBlobUrl(folder, file);
    const res = await fetch(blobUrl);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    btn.textContent = '✕';
    setTimeout(() => { btn.textContent = prev; }, 1500);
    return;
  }
  btn.disabled = false;
  btn.textContent = prev;
}

/* ================= BOOT ================= */

(async function boot() {
  createPlayerBar();
  try {
    const res = await fetch('manifest.json', { cache: 'no-cache' });
    manifest = await res.json();
  } catch (e) {
    app.innerHTML = '<div class="empty">Could not load manifest.json</div>';
    return;
  }
  renderPin();
})();

/**
 * SoundGuess — client (auth site, rooms, blind test musical)
 */

const API_BASE_URL = (() => {
  const el = document.querySelector('meta[name="api-base"]');
  if (el?.content) return el.content.replace(/\/$/, '');
  const params = new URLSearchParams(window.location.search);
  const q = params.get('api');
  if (q) return q.replace(/\/$/, '');
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://127.0.0.1:3000';
  }
  if (/\.onrender\.com$/i.test(host)) {
    return '';
  }
  return 'https://you-liked-what-backend.onrender.com';
})();

function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (/^https?:\/\//i.test(p)) return p;
  if (!API_BASE_URL) return p;
  return `${API_BASE_URL}${p}`;
}

function $(id) {
  return document.getElementById(id);
}

const ROUNDS_OPTIONS = [5, 10, 15, 20, 30, 50];
const TIME_OPTIONS = [10, 20, 30, 45, 60];

let me = null;
let verifyMode = 'register';
let socket = null;
let currentRoom = null;
let roundDeadline = null;
let timerInterval = null;
let guessLocked = false;
let suggestTimer = null;
let inRoundReveal = false;

const HANDOFF_PROOF_KEY = 'ylw_handoff_proof';
let lastBootstrap = null;

const screens = {
  login: $('screen-login'),
  lobby: $('screen-lobby'),
  room: $('screen-room'),
  game: $('screen-game'),
  end: $('screen-end'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    if (!el) return;
    el.classList.toggle('hidden', k !== name);
  });
}

function persistHandoffProofFromPayload(payload) {
  const p = payload?.handoffProof;
  if (typeof p === 'string' && p.length > 20) {
    try {
      sessionStorage.setItem(HANDOFF_PROOF_KEY, p);
    } catch (_) {}
  }
}

function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  let p = path;
  if (!/^https?:\/\//i.test(p) && method === 'GET') {
    const sep = p.includes('?') ? '&' : '?';
    p = `${p}${sep}_nc=${Date.now()}`;
  }
  const { headers: optHeaders, ...rest } = options;
  const h = new Headers(optHeaders || {});
  h.set('ngrok-skip-browser-warning', '69420');
  return fetch(apiUrl(p), { credentials: 'include', cache: 'no-store', ...rest, headers: h });
}

function setUserPill(user) {
  const pill = $('user-pill');
  if (!user) {
    pill?.classList.add('hidden');
    $('profile-modal')?.classList.add('hidden');
    return;
  }
  pill?.classList.remove('hidden');
  $('user-name').textContent = user.username || 'Joueur';
  $('user-avatar').alt = user.username || '';
  setAvatar($('user-avatar'), user.profile_picture, user.username);
}

function fallbackAvatarFor(name) {
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="#333" width="64" height="64"/><text x="32" y="40" text-anchor="middle" fill="#ccc" font-size="28" font-family="sans-serif">${(name || '?')[0].toUpperCase()}</text></svg>`
    )
  );
}

function resolveAvatarUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return apiUrl(url);
  return url;
}

function setAvatar(imgEl, url, username) {
  if (!imgEl) return;
  const fallback = fallbackAvatarFor(username);
  imgEl.referrerPolicy = 'no-referrer';
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = fallback;
  };
  imgEl.src = resolveAvatarUrl(url) || fallback;
}

function msToHuman(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function renderPodium(list) {
  const podium = $('profile-podium');
  if (!podium) return;
  podium.innerHTML = '';
  if (!Array.isArray(list) || list.length === 0) {
    podium.innerHTML = '<p class="hint">Pas assez de parties pour afficher un podium.</p>';
    return;
  }
  function card(rank, p) {
    const div = document.createElement('div');
    div.className = 'podium-place';
    if (!p) {
      div.innerHTML = `<p>#${rank}</p><p class="hint">—</p>`;
      podium.appendChild(div);
      return;
    }
    const img = document.createElement('img');
    setAvatar(img, p.profile_picture || null, p.username);
    img.alt = p.username;
    const title = document.createElement('p');
    title.innerHTML = `<strong>#${rank}</strong> ${p.username}`;
    const sub = document.createElement('p');
    sub.className = 'hint';
    sub.textContent = `${p.gamesTogether} partie(s)`;
    div.appendChild(img);
    div.appendChild(title);
    div.appendChild(sub);
    podium.appendChild(div);
  }
  if (list.length === 1) {
    const div = document.createElement('div');
    div.className = 'podium-place podium-place-single';
    const p = list[0];
    const img = document.createElement('img');
    setAvatar(img, p.profile_picture || null, p.username);
    const title = document.createElement('p');
    title.innerHTML = `<strong>#1</strong> ${p.username}`;
    const sub = document.createElement('p');
    sub.className = 'hint';
    sub.textContent = `${p.gamesTogether} partie(s)`;
    div.appendChild(img);
    div.appendChild(title);
    div.appendChild(sub);
    podium.appendChild(div);
    return;
  }
  if (list.length === 2) {
    card(2, list[1]);
    card(1, list[0]);
    card(3, null);
    return;
  }
  card(2, list[1]);
  card(1, list[0]);
  card(3, list[2]);
}

function renderProfileModal(profile) {
  const username = profile?.username || me?.user?.username || 'Joueur';
  setAvatar($('profile-big-avatar'), profile?.profile_picture || me?.user?.profile_picture, username);
  $('profile-username').textContent = `@${username}`;
  $('profile-bio-input').value = profile?.bio || '';
  $('profile-bio-count').textContent = `${(profile?.bio || '').length} / 500`;
  $('profile-wins').textContent = String(profile?.stats?.wins ?? 0);
  $('profile-games').textContent = String(profile?.stats?.gamesPlayed ?? 0);
  $('profile-reaction').textContent = msToHuman(profile?.stats?.avgReactionMs ?? null);
  const winRate = Math.max(0, Math.min(100, Number(profile?.stats?.winRate || 0)));
  $('profile-winrate-label').textContent = `${winRate}% de victoires`;
  $('profile-winrate-chart').style.background = `conic-gradient(var(--accent) ${Math.round((winRate / 100) * 360)}deg, rgba(255,255,255,0.1) 0deg 360deg)`;
  renderPodium(profile?.podium || []);
}

async function openProfileModal() {
  if (!me?.authenticated) return;
  $('profile-modal').classList.remove('hidden');
  $('profile-modal').setAttribute('aria-hidden', 'false');
  const isSite = String(me.user?.id || '').startsWith('site_');
  $('profile-change-avatar-btn')?.classList.toggle('hidden', !isSite);
  try {
    const res = await apiFetch('/auth/profile');
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      $('auth-error').textContent = body.error || 'Impossible de charger le profil.';
      $('auth-error').classList.remove('hidden');
      return;
    }
    renderProfileModal(body.profile);
  } catch (_) {
    $('auth-error').textContent = 'Erreur réseau lors du chargement du profil.';
    $('auth-error').classList.remove('hidden');
  }
}

function closeProfileModal() {
  const modal = $('profile-modal');
  if (!modal) return;
  if (document.activeElement && modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function renderScores(scores, players) {
  const ul = $('scores-list');
  if (!ul) return;
  ul.innerHTML = '';
  const entries = Object.entries(scores || {}).sort((a, b) => b[1] - a[1]);
  entries.forEach(([id, score]) => {
    const pl = (players || []).find((p) => String(p.playerId) === String(id));
    const li = document.createElement('li');
    li.textContent = `${pl?.username || id} — ${score} pts`;
    ul.appendChild(li);
  });
}

let visualizerRaf = null;
/** @type {{ audioEl: HTMLAudioElement|null, ctx: AudioContext|null, analyser: AnalyserNode|null, source: MediaElementAudioSourceNode|null }|null} */
let audioGraph = null;

const VOLUME_STORAGE_KEY = 'soundguess_volume';

function getStoredVolume() {
  try {
    const v = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  } catch (_) {}
  return 0.75;
}

function applyVolumeToAudio(audioEl) {
  if (!audioEl) return;
  audioEl.volume = getStoredVolume();
}

function wireVolumeControl() {
  const slider = $('volume-slider');
  const label = $('volume-value');
  if (!slider) return;
  const pct = Math.round(getStoredVolume() * 100);
  slider.value = String(pct);
  slider.setAttribute('aria-valuenow', String(pct));
  if (label) label.textContent = String(pct);
  slider.addEventListener('input', () => {
    const vol = Math.max(0, Math.min(100, Number(slider.value))) / 100;
    const pctNow = Math.round(vol * 100);
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(vol));
    } catch (_) {}
    slider.setAttribute('aria-valuenow', String(pctNow));
    if (label) label.textContent = String(pctNow);
    applyVolumeToAudio($('round-audio'));
  });
}

function drawIdleVisualizer() {
  const canvas = $('audio-visualizer');
  if (!canvas) return;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx2d.clearRect(0, 0, w, h);
  const bars = 48;
  const gap = 3;
  const barW = (w - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i += 1) {
    const barH = 5 + (i % 4) * 2;
    const x = i * (barW + gap);
    ctx2d.fillStyle = 'rgba(99, 102, 241, 0.22)';
    ctx2d.fillRect(x, h - barH, barW, barH);
  }
}

function stopRoundAudio() {
  const audio = $('round-audio');
  if (!audio) return;
  audio.pause();
  audio.loop = false;
  audio.onended = null;
  try {
    audio.currentTime = 0;
  } catch (_) {}
  audio.removeAttribute('src');
  audio.load();
}

function stopRoundTimer(frozen = false) {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (frozen) $('timer-display').textContent = '—';
}

function startRoundTimer(timeLimitSec) {
  stopRoundTimer();
  roundDeadline = Date.now() + (timeLimitSec || 20) * 1000;
  const tick = () => {
    if (inRoundReveal) return;
    const left = Math.max(0, Math.ceil((roundDeadline - Date.now()) / 1000));
    $('timer-display').textContent = `${left}s`;
    if (left <= 0) stopRoundTimer();
  };
  tick();
  timerInterval = setInterval(tick, 200);
}

function lockGuessForm() {
  guessLocked = true;
  $('guess-input').disabled = true;
  $('btn-guess').disabled = true;
  $('guess-suggestions')?.classList.add('hidden');
}

function showRoundReveal(track, gained) {
  const wrap = $('round-reveal');
  const answer = $('round-reveal-answer');
  const points = $('round-reveal-points');
  const next = $('round-reveal-next');
  if (!wrap || !answer) return;
  answer.textContent = `${track.artist || '?'} — ${track.title || '?'}`;
  if (gained?.correct && points) {
    points.textContent = `+${gained.total} pts · bonus vitesse +${gained.bonus}`;
    points.classList.remove('hidden');
  } else {
    points?.classList.add('hidden');
  }
  next?.classList.add('hidden');
  wrap.classList.remove('hidden');
}

function hideRoundReveal() {
  $('round-reveal')?.classList.add('hidden');
  $('round-reveal-next')?.classList.add('hidden');
  $('round-reveal-points')?.classList.add('hidden');
}

function stopVisualizerAnimation() {
  if (visualizerRaf) {
    cancelAnimationFrame(visualizerRaf);
    visualizerRaf = null;
  }
}

function ensureAudioGraph(audioEl) {
  if (audioGraph?.audioEl === audioEl && audioGraph.source) return audioGraph;
  if (audioGraph?.ctx) {
    try {
      audioGraph.ctx.close();
    } catch (_) {}
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaElementSource(audioEl);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  audioGraph = { audioEl, ctx, analyser, source };
  return audioGraph;
}

function startVisualizer(audioEl, canvas) {
  stopVisualizerAnimation();
  if (!audioEl || !canvas) return;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;

  const graph = ensureAudioGraph(audioEl);

  function draw() {
    if (!graph.analyser) return;
    const w = canvas.width;
    const h = canvas.height;
    const buf = new Uint8Array(graph.analyser.frequencyBinCount);
    graph.analyser.getByteFrequencyData(buf);
    ctx2d.clearRect(0, 0, w, h);
    const bars = 48;
    const step = Math.floor(buf.length / bars);
    const gap = 3;
    const barW = (w - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i += 1) {
      let sum = 0;
      for (let j = 0; j < step; j += 1) sum += buf[i * step + j];
      const v = sum / step / 255;
      const barH = Math.max(4, v * h * 0.92);
      const x = i * (barW + gap);
      const grad = ctx2d.createLinearGradient(0, h, 0, h - barH);
      grad.addColorStop(0, '#6366f1');
      grad.addColorStop(1, '#c084fc');
      ctx2d.fillStyle = grad;
      ctx2d.fillRect(x, h - barH, barW, barH);
    }
    visualizerRaf = requestAnimationFrame(draw);
  }

  if (graph.ctx?.state === 'suspended') void graph.ctx.resume();
  draw();
}

async function playRoundAudio(audioUrl) {
  const audio = $('round-audio');
  if (!audio || !audioUrl) return;
  stopVisualizerAnimation();
  stopRoundAudio();
  applyVolumeToAudio(audio);
  audio.src = audioUrl;
  audio.loop = false;
  audio.load();
  try {
    const graph = ensureAudioGraph(audio);
    if (graph.ctx?.state === 'suspended') await graph.ctx.resume();
    await audio.play();
    startVisualizer(audio, $('audio-visualizer'));
  } catch (e) {
    console.warn('[Audio] lecture impossible', e);
  }
}

function resetGuessUi() {
  guessLocked = false;
  const input = $('guess-input');
  const btn = $('btn-guess');
  input.value = '';
  input.disabled = false;
  btn.disabled = false;
  $('guess-suggestions')?.classList.add('hidden');
  $('answer-feedback')?.classList.add('hidden');
}

async function fetchSuggestions(q) {
  if (!q || q.length < 2) {
    $('guess-suggestions')?.classList.add('hidden');
    return;
  }
  try {
    const res = await apiFetch(`/api/tracks/suggest?q=${encodeURIComponent(q)}`);
    const body = await res.json().catch(() => ({}));
    const ul = $('guess-suggestions');
    if (!ul) return;
    ul.innerHTML = '';
    const list = body.suggestions || [];
    if (!list.length) {
      ul.classList.add('hidden');
      return;
    }
    list.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = s.label;
      li.role = 'option';
      li.tabIndex = 0;
      li.addEventListener('click', () => {
        $('guess-input').value = s.title;
        ul.classList.add('hidden');
        $('guess-input').focus();
      });
      ul.appendChild(li);
    });
    ul.classList.remove('hidden');
  } catch (_) {}
}

function wireSocketEvents(sock) {
  sock.on('connect', () => console.log('[Socket] connecté', sock.id));
  sock.on('disconnect', (reason) => console.log('[Socket] déconnecté', reason));

  sock.on('error_message', (msg) => {
    const t = msg?.error || 'Erreur';
    if (!$('screen-room').classList.contains('hidden')) {
      $('room-msg').textContent = t;
      $('room-msg').classList.remove('hidden');
    }
    if (!$('screen-lobby').classList.contains('hidden')) {
      $('lobby-msg').textContent = t;
      $('lobby-msg').classList.remove('hidden');
    }
  });

  sock.on('game_preparing', () => {
    if (!$('screen-game').classList.contains('hidden')) {
      $('round-reveal-next')?.classList.remove('hidden');
      return;
    }
    if ($('start-hint')) $('start-hint').textContent = 'Chargement du morceau…';
    $('room-msg')?.classList.add('hidden');
    const btn = $('btn-start');
    if (btn) btn.disabled = true;
  });

  sock.on('room_joined', (room) => {
    currentRoom = room;
    $('room-msg')?.classList.add('hidden');
    showRoomUI(room);
  });

  sock.on('room_update', (room) => {
    currentRoom = room;
    if (!$('screen-room').classList.contains('hidden')) showRoomUI(room);
  });

  sock.on('new_round', (payload) => {
    inRoundReveal = false;
    hideRoundReveal();
    showScreen('game');
    $('scores-panel')?.classList.remove('hidden');
    resetGuessUi();
    $('round-label').textContent = `Morceau ${payload.round} / ${payload.totalRounds}`;
    startRoundTimer(payload.timeLimitSec || 20);
    if (payload.audioUrl) void playRoundAudio(payload.audioUrl);
    renderScores(currentRoom?.scores || {}, currentRoom?.players || []);
  });

  sock.on('score_update', (p) => {
    if (currentRoom) currentRoom.scores = p.scores;
    renderScores(p.scores, currentRoom?.players || []);
  });

  sock.on('round_end', (p) => {
    inRoundReveal = true;
    stopRoundAudio();
    stopVisualizerAnimation();
    drawIdleVisualizer();
    stopRoundTimer(true);
    lockGuessForm();
    const track = p.track || {};
    const mine = me?.user?.id;
    const gained = p.pointsThisRound?.[mine];
    showRoundReveal(track, gained);
  });

  sock.on('end_game', (p) => {
    inRoundReveal = false;
    hideRoundReveal();
    stopRoundAudio();
    stopVisualizerAnimation();
    stopRoundTimer();
    showScreen('end');
    const err = $('end-error');
    if (p.error) {
      err.textContent = p.error;
      err.classList.remove('hidden');
    } else {
      err.classList.add('hidden');
    }
    const ol = $('leaderboard');
    ol.innerHTML = '';
    (p.leaderboard || []).forEach((row, i) => {
      const li = document.createElement('li');
      li.textContent = `#${i + 1} ${row.username} — ${row.score} pts`;
      ol.appendChild(li);
    });
    currentRoom = null;
  });
}

function reconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  socket = io(apiUrl(''), { withCredentials: true, transports: ['websocket', 'polling'] });
  wireSocketEvents(socket);
}

function connectSocket() {
  if (!socket) reconnectSocket();
}

async function refreshSessionFromServer() {
  try {
    const res = await apiFetch('/auth/me');
    const session = await res.json().catch(() => ({ authenticated: false }));
    me = session;
    if (session.authenticated) {
      setUserPill(session.user);
    } else {
      setUserPill(null);
    }
    if (lastBootstrap) lastBootstrap.session = session;
    return session;
  } catch (_) {
    me = { authenticated: false };
    setUserPill(null);
    return me;
  }
}

async function afterAuthSuccess(body) {
  persistHandoffProofFromPayload(body);
  await refreshSessionFromServer();
  if (!me?.authenticated && body?.user) {
    me = { authenticated: true, user: body.user };
    setUserPill(body.user);
  }
  reconnectSocket();
  showScreen('lobby');
  $('auth-error')?.classList.add('hidden');
  $('auth-warn')?.classList.add('hidden');
}

function showRoomUI(room) {
  showScreen('room');
  $('room-code-display').textContent = room.code;
  $('room-phase').textContent =
    room.phase === 'lobby' ? 'En attente' : room.phase === 'ended' ? 'Terminée' : 'En cours';
  const ul = $('players-list');
  ul.innerHTML = '';
  (room.players || []).forEach((p) => {
    const li = document.createElement('li');
    const isHost = p.playerId === room.hostPlayerId;
    if (isHost) li.classList.add('is-host');
    const img = document.createElement('img');
    img.className = 'player-chip__avatar';
    setAvatar(img, p.profile_picture, p.username);
    img.alt = '';
    const span = document.createElement('span');
    span.className = 'player-chip__name';
    span.textContent = p.username;
    li.appendChild(img);
    li.appendChild(span);
    if (isHost) {
      const badge = document.createElement('span');
      badge.className = 'player-chip__badge';
      badge.textContent = 'Hôte';
      li.appendChild(badge);
    }
    ul.appendChild(li);
  });
  const isHost = me?.user?.id === room.hostPlayerId;
  $('host-actions').classList.toggle('hidden', !isHost || room.phase !== 'lobby');
  const btnStart = $('btn-start');
  if (btnStart && isHost && room.phase === 'lobby') btnStart.disabled = false;
  $('start-hint').textContent =
    room.players.length < 2 ? 'Il faut au moins 2 joueurs.' : 'Prêt à lancer le blind test.';
  renderScores(room.scores, room.players);
}

function initLobbySelects() {
  const sr = $('opt-rounds');
  const st = $('opt-time');
  if (!sr || !st) return;
  sr.innerHTML = '';
  st.innerHTML = '';
  ROUNDS_OPTIONS.forEach((n) => {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = `${n} morceaux`;
    if (n === 10) o.selected = true;
    sr.appendChild(o);
  });
  TIME_OPTIONS.forEach((n) => {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = `${n} s`;
    if (n === 30) o.selected = true;
    st.appendChild(o);
  });
}

async function checkBackend() {
  const b = $('backend-banner');
  try {
    const res = await apiFetch('/api/health');
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json().catch(() => null);
    if (!j || !j.ok || j.v < 4) throw new Error('Bootstrap invalide');
    lastBootstrap = j;
    persistHandoffProofFromPayload(j);
    b?.classList.add('hidden');
    return true;
  } catch (e) {
    lastBootstrap = null;
    b?.classList.remove('hidden');
    return false;
  }
}

async function applySessionFromBootstrap() {
  const session = await refreshSessionFromServer();
  if (!session?.authenticated) {
    showScreen('login');
    return;
  }
  showScreen('lobby');
  reconnectSocket();
}

async function bootstrap() {
  wireApiAnchors();
  initLobbySelects();
  readQueryError();
  const ok = await checkBackend();
  if (!ok) return;
  await applySessionFromBootstrap();
}

function readQueryError() {
  const e = new URLSearchParams(window.location.search).get('auth_error');
  if (e) {
    $('auth-error').textContent = decodeURIComponent(e);
    $('auth-error').classList.remove('hidden');
    window.history.replaceState({}, '', '/');
  }
}

function wireApiAnchors() {
  const lo = $('logout-btn');
  if (lo) lo.href = apiUrl('/auth/logout');
}

function openVerificationPanel(email, mode = 'register') {
  verifyMode = mode;
  $('site-verify-panel')?.classList.remove('hidden');
  if (email) $('site-verify-email').value = email;
  $('site-verify-code').value = '';
  $('verify-resend-status').textContent = '';
  const title = $('site-verify-title');
  const hint = $('site-verify-hint');
  const btn = $('btn-site-verify');
  if (mode === 'login2fa') {
    if (title) title.textContent = 'Double authentification';
    if (hint) hint.textContent = 'Entre le code de connexion reçu par e-mail (valide 10 min).';
    if (btn) btn.textContent = 'Confirmer la connexion';
  } else {
    if (title) title.textContent = 'Vérification e-mail';
    if (hint) hint.textContent = 'Code à 6 chiffres reçu par e-mail (vérifie les spams).';
    if (btn) btn.textContent = 'Valider le code';
  }
}

async function submitGuess(e) {
  e.preventDefault();
  if (guessLocked || inRoundReveal || !socket) return;
  const guess = $('guess-input').value.trim();
  if (!guess) return;
  $('btn-guess').disabled = true;
  socket.emit('player_answer', { guess }, (ack) => {
    if (ack?.error) {
      $('answer-feedback').classList.remove('hidden');
      $('answer-feedback').textContent = ack.error;
      $('answer-feedback').style.color = '#ffb4b4';
      if (ack.error.includes('Mauvaise')) {
        guessLocked = true;
        $('guess-input').disabled = true;
        $('btn-guess').disabled = true;
      } else {
        $('btn-guess').disabled = false;
      }
      return;
    }
    if (ack?.correct) {
      $('answer-feedback').classList.remove('hidden');
      $('answer-feedback').textContent = `Bonne réponse ! +${ack.points} pts`;
      $('answer-feedback').style.color = '#86efac';
      guessLocked = true;
      $('guess-input').disabled = true;
    } else if (ack?.locked) {
      guessLocked = true;
      $('guess-input').disabled = true;
      $('answer-feedback').classList.remove('hidden');
      $('answer-feedback').textContent = 'Mauvaise réponse — plus de tentative pour ce morceau.';
      $('answer-feedback').style.color = '#ffb4b4';
    }
  });
}

function wireEvents() {
  $('user-profile-btn')?.addEventListener('click', openProfileModal);
  $('profile-close-btn')?.addEventListener('click', closeProfileModal);
  $('profile-close-backdrop')?.addEventListener('click', closeProfileModal);
  $('profile-save-bio')?.addEventListener('click', async () => {
    const bio = $('profile-bio-input').value;
    const res = await apiFetch('/auth/profile/bio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) renderProfileModal(body.profile);
  });
  $('profile-bio-input')?.addEventListener('input', () => {
    $('profile-bio-count').textContent = `${$('profile-bio-input').value.length} / 500`;
  });

  $('profile-change-avatar-btn')?.addEventListener('click', () => {
    $('profile-avatar-input')?.click();
  });
  $('profile-avatar-input')?.addEventListener('change', async () => {
    const input = $('profile-avatar-input');
    const file = input?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    const btn = $('profile-change-avatar-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch('/auth/profile/avatar', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = [body.error, body.detail].filter(Boolean).join(' — ');
        $('auth-error').textContent = msg || 'Impossible de mettre à jour la photo.';
        $('auth-error').classList.remove('hidden');
        return;
      }
      if (body.user) {
        me = { ...me, authenticated: true, user: body.user };
        setUserPill(body.user);
        const pr = await apiFetch('/auth/profile');
        const pb = await pr.json().catch(() => ({}));
        if (pb.profile) renderProfileModal(pb.profile);
      }
    } catch (_) {
      $('auth-error').textContent = 'Erreur réseau lors de l’envoi de la photo.';
      $('auth-error').classList.remove('hidden');
    } finally {
      if (btn) btn.disabled = false;
      if (input) input.value = '';
    }
  });

  $('site-login-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const res = await apiFetch('/auth/login-site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailOrUsername: $('site-login-id').value.trim(),
        password: $('site-login-password').value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('auth-error').textContent = body.error || 'Connexion impossible';
      $('auth-error').classList.remove('hidden');
      if (body.needsVerification) openVerificationPanel(body.email, 'register');
      return;
    }
    if (body.needs2fa) {
      $('auth-error').classList.add('hidden');
      $('auth-warn').textContent = body.message || 'Code envoyé par e-mail.';
      if (body.devCode) {
        $('auth-warn').textContent += ` (dev: ${body.devCode})`;
      }
      $('auth-warn').classList.remove('hidden');
      openVerificationPanel(body.email, 'login2fa');
      return;
    }
    await afterAuthSuccess(body);
  });

  $('site-register-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const res = await apiFetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('site-reg-username').value.trim(),
        email: $('site-reg-email').value.trim(),
        password: $('site-reg-password').value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('auth-error').textContent = body.error || 'Inscription impossible';
      $('auth-error').classList.remove('hidden');
      if (body.pendingVerification) {
        $('auth-warn').textContent =
          'Entre le code reçu par e-mail ci-dessous, ou clique « Renvoyer le code ».';
        $('auth-warn').classList.remove('hidden');
        openVerificationPanel(body.email || $('site-reg-email').value.trim(), 'register');
      }
      return;
    }
    $('auth-error').classList.add('hidden');
    $('auth-warn').textContent = body.message || 'Vérifie ton e-mail.';
    if (body.devCode) {
      $('auth-warn').textContent += ` (dev: ${body.devCode})`;
    }
    $('auth-warn').classList.remove('hidden');
    openVerificationPanel(body.email || $('site-reg-email').value.trim(), 'register');
  });

  $('site-verify-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const endpoint = verifyMode === 'login2fa' ? '/auth/verify-login-2fa' : '/auth/verify-email';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: $('site-verify-email').value.trim(),
        code: $('site-verify-code').value.trim(),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('auth-error').textContent = body.error || 'Code invalide';
      $('auth-error').classList.remove('hidden');
      return;
    }
    await afterAuthSuccess(body);
  });

  $('btn-resend-code')?.addEventListener('click', async () => {
    const endpoint = verifyMode === 'login2fa' ? '/auth/resend-login-2fa' : '/auth/resend-verification';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('site-verify-email').value.trim() }),
    });
    const body = await res.json().catch(() => ({}));
    $('verify-resend-status').textContent = body.message || body.error || 'Demande envoyée.';
  });

  $('btn-create')?.addEventListener('click', () => {
    connectSocket();
    socket.emit(
      'create_room',
      {
        rounds: Number($('opt-rounds').value),
        timePerRoundSec: Number($('opt-time').value),
      },
      (ack) => {
        if (ack?.error) {
          $('lobby-msg').textContent = ack.error;
          $('lobby-msg').classList.remove('hidden');
        }
      }
    );
  });

  $('btn-join')?.addEventListener('click', () => {
    connectSocket();
    socket.emit('join_room', { code: $('join-code').value.trim() }, (ack) => {
      if (ack?.error) {
        $('lobby-msg').textContent = ack.error;
        $('lobby-msg').classList.remove('hidden');
      }
    });
  });

  $('btn-start')?.addEventListener('click', () => {
    const btn = $('btn-start');
    if (btn) btn.disabled = true;
    if ($('start-hint')) $('start-hint').textContent = 'Lancement…';
    socket.emit('start_game', (ack) => {
      if (ack?.error) {
        if (btn) btn.disabled = false;
        if ($('start-hint')) $('start-hint').textContent = 'Prêt à lancer le blind test.';
        $('room-msg').textContent = ack.error;
        $('room-msg').classList.remove('hidden');
      }
    });
  });

  $('btn-leave-room')?.addEventListener('click', () => {
    socket?.emit('leave_room');
    showScreen('lobby');
  });

  $('btn-back-lobby')?.addEventListener('click', () => showScreen('lobby'));

  $('guess-form')?.addEventListener('submit', submitGuess);
  $('guess-input')?.addEventListener('input', () => {
    if (guessLocked) return;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => fetchSuggestions($('guess-input').value.trim()), 220);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireVolumeControl();
  wireEvents();
  bootstrap();
});

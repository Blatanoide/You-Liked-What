/**
 * Client vanilla — flux : login → likes simulés → salon → room → jeu.
 * Socket.io avec cookies de session (withCredentials).
 */

/* global io */

const ROUNDS_OPTIONS = [5, 10, 15, 20, 30, 50];
const TIME_OPTIONS = [10, 20, 30];

const $ = (id) => document.getElementById(id);
/**
 * Même origine sur Render / localhost → session cookie toujours envoyé (import, socket).
 * Sur Vercel → API Render en dur (cookies cross-site ; l’import fiable = ouvrir le jeu sur l’URL Render).
 */
const API_BASE_URL = (() => {
  if (typeof window === 'undefined') {
    return 'https://you-liked-what-backend.onrender.com';
  }
  const h = window.location.hostname || '';
  const onApiHost =
    /\.onrender\.com$/i.test(h) || h === 'localhost' || h === '127.0.0.1';
  return onApiHost
    ? `${window.location.protocol}//${window.location.host}`
    : 'https://you-liked-what-backend.onrender.com';
})();
/**
 * URL absolue : évite les soucis si <base href> ou chemins relatifs bizarres.
 */
function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path, API_BASE_URL).href;
}

const IG_EMBED_SCRIPT = 'https://www.instagram.com/embed.js';
let igEmbedScriptPromise = null;
let gameVolume = 0.7;
let gameMuted = false;

function waitForInstgrmProcess(resolve, reject) {
  const t0 = Date.now();
  const tick = () => {
    if (typeof window.instgrm?.Embeds?.process === 'function') resolve();
    else if (Date.now() - t0 > 10000) reject(new Error('instgrm timeout'));
    else setTimeout(tick, 40);
  };
  tick();
}

function loadInstagramEmbedJs() {
  if (typeof window.instgrm?.Embeds?.process === 'function') {
    return Promise.resolve();
  }
  if (igEmbedScriptPromise) return igEmbedScriptPromise;
  igEmbedScriptPromise = new Promise((resolve, reject) => {
    const id = 'instagram-embed-js';
    const existing = document.getElementById(id);
    if (existing) {
      waitForInstgrmProcess(resolve, reject);
      return;
    }
    const s = document.createElement('script');
    s.id = id;
    s.async = true;
    s.src = IG_EMBED_SCRIPT;
    s.onload = () => waitForInstgrmProcess(resolve, reject);
    s.onerror = () => reject(new Error('embed.js load'));
    document.body.appendChild(s);
  });
  return igEmbedScriptPromise;
}

function normalizeInstagramPermalink(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u = raw.trim().split('?')[0].split('#')[0];
  if (!/^https?:\/\/(www\.)?instagram\.com\//i.test(u)) return null;
  u = u.replace(/^http:\/\//i, 'https://');
  u = u.replace(/^https:\/\/instagram\.com\//i, 'https://www.instagram.com/');
  return u;
}

/** URL iframe fallback (autoplay navigateur = souvent muted + playsinline). */
function buildInstagramIframeSrc(embedUrl, permalink) {
  let base = embedUrl;
  if (!base && permalink) {
    base = `${permalink.replace(/\/$/, '')}/embed/`;
  }
  if (!base) return null;
  const [pathOnly, query = ''] = base.split('?');
  const merged = new URLSearchParams(query);
  if (!merged.has('autoplay')) merged.set('autoplay', '1');
  if (!merged.has('muted')) merged.set('muted', '1');
  if (!merged.has('playsinline')) merged.set('playsinline', '1');
  return `${pathOnly}?${merged.toString()}`;
}

function mountInstagramIframeFallback(hostEl, post) {
  hostEl.innerHTML = '';
  const permalink = normalizeInstagramPermalink(post.url);
  const src = buildInstagramIframeSrc(post.embedUrl || null, permalink);
  if (!src) return false;
  const iframe = document.createElement('iframe');
  iframe.className = 'ig-embed-iframe';
  iframe.title = 'Post ou reel Instagram';
  iframe.loading = 'eager';
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  iframe.setAttribute('allowfullscreen', '');
  iframe.allow =
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
  iframe.src = src;
  iframe.tabIndex = 0;
  hostEl.appendChild(iframe);
  return true;
}

async function mountInstagramEmbed(hostEl, embedFrameEl, post) {
  hostEl.innerHTML = '';
  embedFrameEl.classList.remove('hidden');
  embedFrameEl.setAttribute('aria-hidden', 'false');
  const permalink = normalizeInstagramPermalink(post.url);

  if (permalink) {
    try {
      await loadInstagramEmbedJs();
      const bq = document.createElement('blockquote');
      bq.className = 'instagram-media';
      bq.setAttribute('data-instgrm-permalink', permalink);
      bq.setAttribute('data-instgrm-version', '14');
      bq.setAttribute(
        'style',
        'margin:0!important;padding:0!important;background:transparent!important;width:100%!important;max-width:100%!important;min-width:0!important;'
      );
      hostEl.appendChild(bq);
      window.instgrm.Embeds.process();
      return;
    } catch (e) {
      console.warn('[IG embed] embed.js indisponible, iframe direct :', e?.message || e);
    }
  }

  if (!mountInstagramIframeFallback(hostEl, post)) {
    embedFrameEl.classList.add('hidden');
    embedFrameEl.setAttribute('aria-hidden', 'true');
    hostEl.innerHTML = '';
  }
}

function hideVideoVolumeUi() {
  const box = $('video-volume-ui');
  if (!box) return;
  box.classList.add('hidden');
  box.setAttribute('aria-hidden', 'true');
}

function setupVideoVolumeUi(videoEl) {
  const box = $('video-volume-ui');
  const btn = $('video-mute-btn');
  const range = $('video-volume-range');
  if (!box || !btn || !range || !videoEl) return;

  const refresh = () => {
    btn.textContent = gameMuted || gameVolume <= 0 ? '🔇' : '🔊';
    range.value = String(Math.round(gameVolume * 100));
    videoEl.muted = gameMuted || gameVolume <= 0;
    videoEl.volume = Math.max(0, Math.min(1, gameVolume));
  };

  if (!box.dataset.bound) {
    btn.addEventListener('click', () => {
      gameMuted = !gameMuted;
      refresh();
    });
    range.addEventListener('input', () => {
      gameVolume = Math.max(0, Math.min(1, Number(range.value) / 100));
      if (gameVolume > 0) gameMuted = false;
      refresh();
    });
    box.dataset.bound = '1';
  }
  refresh();
  box.classList.remove('hidden');
  box.setAttribute('aria-hidden', 'false');
}

async function mountPlayableVideo(post, embedHost, embedFrame) {
  const video = $('post-video');
  if (!video || !post?.videoUrl) return false;
  embedHost.innerHTML = '';
  embedFrame.classList.remove('hidden');
  embedFrame.setAttribute('aria-hidden', 'false');
  video.classList.remove('hidden');
  video.pause();
  video.src = post.videoUrl;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  setupVideoVolumeUi(video);

  video.muted = true;
  try {
    await video.play();
    video.muted = gameMuted || gameVolume <= 0;
    video.volume = Math.max(0, Math.min(1, gameVolume));
    return true;
  } catch {
    video.muted = gameMuted || gameVolume <= 0;
    video.volume = Math.max(0, Math.min(1, gameVolume));
    try {
      await video.play();
      return true;
    } catch {
      video.pause();
      video.removeAttribute('src');
      video.classList.add('hidden');
      hideVideoVolumeUi();
      return false;
    }
  }
}

const HANDOFF_PROOF_KEY = 'ylw_handoff_proof';

function persistHandoffProofFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  const p = payload.handoffProof;
  if (typeof p === 'string' && p.length > 20) {
    try {
      sessionStorage.setItem(HANDOFF_PROOF_KEY, p);
    } catch (_) {
      /* quota / private mode */
    }
  }
}

function readHandoffProofForRequest() {
  try {
    return sessionStorage.getItem(HANDOFF_PROOF_KEY) || '';
  } catch (_) {
    return '';
  }
}

/**
 * API + en-tête ngrok. Paramètre _nc sur les GET pour éviter un vieux 404/401 mis en cache par ngrok.
 */
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
  return fetch(apiUrl(p), {
    credentials: 'include',
    cache: 'no-store',
    ...rest,
    headers: h,
  });
}

/** Réponse /api/health réutilisée pour la config UI et la session (v3+). */
let lastBootstrap = null;

function invalidateBootstrap() {
  lastBootstrap = null;
}

const screens = {
  login: $('screen-login'),
  likes: $('screen-likes'),
  lobby: $('screen-lobby'),
  room: $('screen-room'),
  game: $('screen-game'),
  end: $('screen-end'),
};

function showScreen(name) {
  Object.keys(screens).forEach((k) => {
    screens[k].classList.toggle('hidden', k !== name);
  });
}

let socket = null;
let me = null;
let currentRoom = null;
let timerInterval = null;
let roundDeadline = 0;

function sessionToMe(session) {
  if (!session || !session.authenticated) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    user: session.user,
    simulatedLikes: session.simulatedLikes,
    minLikesRequired: session.minLikesRequired,
    canPlay: session.canPlay,
  };
}

/**
 * État utilisateur via GET /api/health uniquement (évite 404 /api/session et 401 /auth/me via ngrok).
 */
async function fetchMe(opts = {}) {
  const force = opts.force === true;
  if (!force && lastBootstrap && lastBootstrap.v >= 3 && lastBootstrap.session != null) {
    return sessionToMe(lastBootstrap.session);
  }
  const res = await apiFetch('/api/health');
  const ct = (r) => (r.headers.get('content-type') || '').includes('application/json');
  if (!res.ok || !ct(res)) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.ok || typeof data.port !== 'number' || data.v < 3 || data.session == null) {
    return null;
  }
  lastBootstrap = data;
  persistHandoffProofFromPayload(data);
  return sessionToMe(data.session);
}

function setUserPill(user) {
  const pill = $('user-pill');
  const img = $('user-avatar');
  const name = $('user-name');
  if (!user) {
    pill.classList.add('hidden');
    const modal = $('profile-modal');
    if (modal) modal.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');
  name.textContent = user.username || 'Joueur';
  img.alt = user.username || '';
  setAvatar(img, user.profile_picture, user.username);
}

function fallbackAvatarFor(name) {
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="#333" width="64" height="64"/><text x="32" y="40" text-anchor="middle" fill="#ccc" font-size="28" font-family="sans-serif">${(name || '?')[0].toUpperCase()}</text></svg>`
    )
  );
}

function setAvatar(imgEl, url, username) {
  if (!imgEl) return;
  const fallback = fallbackAvatarFor(username);
  imgEl.referrerPolicy = 'no-referrer';
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = fallback;
  };
  imgEl.src = url || fallback;
}

function msToHuman(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function renderPodium(list) {
  const podium = $('profile-podium');
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
  /** Grille 3 colonnes : gauche = #2, centre = #1, droite = #3 (ordre classement API). */
  if (list.length === 1) {
    const div = document.createElement('div');
    div.className = 'podium-place podium-place-single';
    const p = list[0];
    const img = document.createElement('img');
    setAvatar(img, p.profile_picture || null, p.username);
    img.alt = p.username;
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
  const avatar = profile?.profile_picture || me?.user?.profile_picture || null;
  setAvatar($('profile-big-avatar'), avatar, username);
  $('profile-username').textContent = `@${username}`;
  $('profile-bio-input').value = profile?.bio || '';
  $('profile-bio-count').textContent = `${(profile?.bio || '').length} / 500`;
  $('profile-wins').textContent = String(profile?.stats?.wins ?? 0);
  $('profile-games').textContent = String(profile?.stats?.gamesPlayed ?? 0);
  $('profile-reaction').textContent = msToHuman(profile?.stats?.avgReactionMs ?? null);
  const winRate = Math.max(0, Math.min(100, Number(profile?.stats?.winRate || 0)));
  $('profile-winrate-label').textContent = `${winRate}% de victoires`;
  $('profile-winrate-chart').style.background = `conic-gradient(var(--accent) ${Math.round(
    (winRate / 100) * 360
  )}deg, rgba(255, 255, 255, 0.1) 0deg 360deg)`;
  renderPodium(profile?.podium || []);
}

async function openProfileModal() {
  if (!me?.authenticated) return;
  updateSiteAvatarUi();
  $('profile-modal').classList.remove('hidden');
  $('profile-modal').setAttribute('aria-hidden', 'false');
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
  $('profile-modal').classList.add('hidden');
  $('profile-modal').setAttribute('aria-hidden', 'true');
}

function renderLikesList(urls) {
  const ul = $('likes-list');
  ul.innerHTML = '';
  urls.forEach((url) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = url.length > 48 ? `${url.slice(0, 46)}…` : url;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn-tiny';
    rm.textContent = 'Retirer';
    rm.addEventListener('click', async () => {
      await apiFetch('/auth/likes/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      invalidateBootstrap();
      const data = await fetchMe();
      if (data) syncMe(data);
    });
    li.appendChild(a);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

function isSiteAccountUser(user) {
  if (!user) return false;
  if (user.loginMethod === 'site') return true;
  return String(user.id || '').startsWith('site_');
}

function updateSiteAvatarUi() {
  const btn = $('profile-change-avatar-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', !isSiteAccountUser(me?.user));
}

function syncMe(data) {
  me = data;
  if (!data.authenticated) {
    setUserPill(null);
    $('site-verify-panel')?.classList.add('hidden');
    updateSiteAvatarUi();
    showScreen('login');
    return;
  }
  setUserPill(data.user);
  updateSiteAvatarUi();
  $('min-likes-label').textContent = String(data.minLikesRequired ?? 3);
  renderLikesList(data.simulatedLikes || []);
  $('btn-to-lobby').disabled = !data.canPlay;
}

function connectSocket() {
  if (socket?.connected) return;
  socket = io(API_BASE_URL, {
    withCredentials: true,
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    transportOptions: {
      polling: {
        extraHeaders: {
          'ngrok-skip-browser-warning': '69420',
        },
      },
    },
  });

  socket.on('connect', () => console.log('[Socket] connecté'));
  socket.on('disconnect', () => console.log('[Socket] déconnecté'));

  socket.on('error_message', (payload) => {
    const msg = payload?.error || 'Erreur';
    if ($('screen-room') && !$('screen-room').classList.contains('hidden')) {
      $('room-msg').textContent = msg;
      $('room-msg').classList.remove('hidden');
    }
    if (!$('screen-lobby').classList.contains('hidden')) {
      $('lobby-msg').textContent = msg;
      $('lobby-msg').classList.remove('hidden');
    }
  });

  socket.on('room_joined', (room) => {
    currentRoom = room;
    $('room-msg').classList.add('hidden');
    showRoomUI(room);
  });

  socket.on('room_update', (room) => {
    currentRoom = room;
    if (!$('screen-room').classList.contains('hidden')) {
      showRoomUI(room);
    }
  });

  socket.on('new_round', (payload) => {
    showScreen('game');
    $('scores-panel').classList.remove('hidden');
    $('answer-feedback').classList.add('hidden');
    $('round-label').textContent = `Round ${payload.round} / ${payload.totalRounds}`;

    const post = payload.post || {};
    $('post-link').href = post.url || '#';
    const thumbWrap = $('post-thumb-wrap');
    const thumb = $('post-thumb');
    const embedHost = $('post-embed-host');
    const embedFrame = $('post-embed-frame');
    const videoEl = $('post-video');
    if (post.thumbnailUrl) {
      thumb.src = post.thumbnailUrl;
      thumbWrap.classList.remove('hidden');
    } else {
      thumbWrap.classList.add('hidden');
      thumb.removeAttribute('src');
    }
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.classList.add('hidden');
    }
    hideVideoVolumeUi();
    if (post.videoUrl) {
      void mountPlayableVideo(post, embedHost, embedFrame).then((ok) => {
        if (!ok && (post.embedUrl || normalizeInstagramPermalink(post.url))) {
          void mountInstagramEmbed(embedHost, embedFrame, post);
        }
      });
    } else if (post.embedUrl || normalizeInstagramPermalink(post.url)) {
      void mountInstagramEmbed(embedHost, embedFrame, post);
    } else {
      embedHost.innerHTML = '';
      embedFrame?.classList.add('hidden');
      embedFrame?.setAttribute('aria-hidden', 'true');
    }

    const choices = $('choices');
    choices.innerHTML = '';
    (payload.choices || []).forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-btn';
      btn.dataset.id = c.instagramId;
      const img = document.createElement('img');
      setAvatar(img, c.profile_picture || null, c.username);
      img.alt = '';
      const span = document.createElement('span');
      span.textContent = c.username;
      btn.appendChild(img);
      btn.appendChild(span);
      btn.addEventListener('click', () => submitAnswer(c.instagramId, btn));
      choices.appendChild(btn);
    });

    roundDeadline = Date.now() + (payload.timeLimitSec || 20) * 1000;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 100);
    updateTimer();
    renderScoresFromRoom();
  });

  socket.on('round_end', (payload) => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    $('timer-display').textContent = '—';
    const correct = payload.correctAnswerInstagramId;
    const mine = me?.user?.id;
    const gained = payload.pointsThisRound?.[mine];
    const fb = $('answer-feedback');
    fb.classList.remove('hidden');
    if (gained?.correct) {
      fb.textContent = `Bonne réponse ! +${gained.total} pts (bonus vitesse : +${gained.bonus})`;
      fb.style.color = '#7dffb3';
    } else {
      fb.textContent = `Pas de points ce round — la bonne réponse est mise en évidence ci-dessous.`;
      fb.style.color = '#ffb4b4';
    }
    document.querySelectorAll('.choice-btn').forEach((btn) => {
      btn.disabled = true;
      if (btn.dataset.id === correct) {
        btn.style.borderColor = '#7dffb3';
        btn.style.background = 'rgba(125, 255, 179, 0.12)';
      }
    });
    if (payload.scores) {
      renderScoresObject(payload.scores);
    }
  });

  socket.on('score_update', (payload) => {
    if (payload.scores) renderScoresObject(payload.scores);
  });

  socket.on('end_game', (payload) => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    currentRoom = null;
    showScreen('end');
    const err = $('end-error');
    if (payload.error) {
      err.textContent = payload.error;
      err.classList.remove('hidden');
    } else {
      err.classList.add('hidden');
    }
    const ol = $('leaderboard');
    ol.innerHTML = '';
    (payload.leaderboard || []).forEach((row, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${row.username} — ${row.score} pts`;
      ol.appendChild(li);
    });
  });
}

function updateTimer() {
  const left = Math.max(0, Math.ceil((roundDeadline - Date.now()) / 1000));
  $('timer-display').textContent = `${left}s`;
}

function renderScoresObject(scores) {
  const ul = $('scores-list');
  ul.innerHTML = '';
  Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .forEach(([id, score]) => {
      const li = document.createElement('li');
      const label =
        id === String(me?.user?.id) ? 'Toi' : currentRoom?.players?.find((p) => p.instagramId === id)?.username || id;
      li.innerHTML = `<span>${label}</span><strong>${score}</strong>`;
      ul.appendChild(li);
    });
}

function renderScoresFromRoom() {
  if (currentRoom?.scores) renderScoresObject(currentRoom.scores);
}

function showRoomUI(room) {
  showScreen('room');
  $('room-code-display').textContent = room.code;
  const phaseLabels = {
    lobby: 'En attente — l’hôte peut lancer',
    playing: 'Partie en cours',
    between: 'Entre deux rounds',
    ended: 'Terminé',
  };
  $('room-phase').textContent = phaseLabels[room.phase] || room.phase;

  const ul = $('players-list');
  ul.innerHTML = '';
  (room.players || []).forEach((p) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.className = 'mini-avatar';
    setAvatar(img, p.profile_picture || null, p.username);
    img.alt = '';
    const span = document.createElement('span');
    span.textContent = `${p.username} (${p.likesCount} likes simulés)`;
    li.appendChild(img);
    li.appendChild(span);
    ul.appendChild(li);
  });

  const isHost = String(me?.user?.id) === String(room.hostInstagramId);
  const hostBlock = $('host-actions');
  if (room.phase === 'lobby' && isHost) {
    hostBlock.classList.remove('hidden');
    const n = room.players?.length || 0;
    const min = 2;
    const ok = n >= min && (room.players || []).every((p) => p.canPlay);
    $('btn-start').disabled = !ok;
    $('start-hint').textContent = ok
      ? 'Prêt à lancer.'
      : n < min
        ? `Il manque des joueurs (min. ${min}).`
        : 'Chaque joueur doit avoir assez de posts dans ses likes simulés.';
  } else {
    hostBlock.classList.add('hidden');
  }

}

function submitAnswer(guessInstagramId, btnEl) {
  document.querySelectorAll('.choice-btn').forEach((b) => {
    b.disabled = true;
  });
  btnEl.style.borderColor = 'rgba(225, 48, 108, 0.6)';
  socket.emit('player_answer', { guessInstagramId }, (ack) => {
    if (ack?.error) {
      $('answer-feedback').classList.remove('hidden');
      $('answer-feedback').textContent = ack.error;
      $('answer-feedback').style.color = '#ffb4b4';
    }
  });
}

function initLobbySelects() {
  const sr = $('opt-rounds');
  const st = $('opt-time');
  ROUNDS_OPTIONS.forEach((n) => {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = `${n} rounds`;
    if (n === 10) o.selected = true;
    sr.appendChild(o);
  });
  TIME_OPTIONS.forEach((n) => {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = `${n} s`;
    if (n === 20) o.selected = true;
    st.appendChild(o);
  });
}

function readQueryError() {
  const params = new URLSearchParams(window.location.search);
  const e = params.get('auth_error');
  if (e) {
    $('auth-error').textContent = decodeURIComponent(e);
    $('auth-error').classList.remove('hidden');
    window.history.replaceState({}, '', '/');
  }
}

async function checkBackend() {
  const b = $('backend-banner');
  if (!b) return true;
  try {
    const res = await apiFetch('/api/health');
    if (!res.ok) throw new Error(String(res.status));
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      throw new Error('Réponse non-JSON (souvent page ngrok HTML) — vérifie l’URL et ngrok http PORT');
    }
    const j = await res.json().catch(() => null);
    if (!j || !j.ok || typeof j.port !== 'number' || j.v < 3 || j.session === undefined) {
      throw new Error('JSON bootstrap invalide ou cache — redémarre le serveur (npm start) puis Ctrl+F5');
    }
    lastBootstrap = j;
    persistHandoffProofFromPayload(j);
    console.log('[App] Backend OK — port', j.port, j.v ? `(v${j.v})` : '');
    b.classList.add('hidden');
    return true;
  } catch (e) {
    lastBootstrap = null;
    console.warn('[App]', e.message || e);
    b.classList.remove('hidden');
    return false;
  }
}

function applyClientConfig(cfg) {
  const hint = $('ngrok-hint');
  const demoBtn = $('btn-demo-login');
  const seedBtn = $('btn-seed-demo');
  const oauthBtn = $('btn-instagram-oauth');
  const passForm = $('login-password-form');
  const passBtn = $('btn-password-login');
  const oauthDisabled = $('oauth-disabled-msg');
  const orScrape = $('login-or-scrape');

  if (!cfg) {
    if (hint) hint.textContent = '';
    return;
  }

  if (cfg.allowPasswordScrape) {
    passForm?.classList.remove('hidden');
    passBtn?.removeAttribute('disabled');
    $('ig-username-password')?.setAttribute('required', 'required');
    $('ig-password')?.setAttribute('required', 'required');
    if (oauthDisabled) {
      oauthDisabled.textContent = '';
      oauthDisabled.classList.add('hidden');
    }
  } else {
    passForm?.classList.add('hidden');
    passBtn?.setAttribute('disabled', 'disabled');
    $('ig-username-password')?.removeAttribute('required');
    $('ig-password')?.removeAttribute('required');
    if (oauthDisabled) {
      oauthDisabled.textContent = '';
      oauthDisabled.classList.add('hidden');
    }
  }

  if (cfg.instagramOAuthEnabled) {
    oauthBtn?.classList.remove('hidden');
    orScrape?.classList.remove('hidden');
  } else {
    oauthBtn?.classList.add('hidden');
    orScrape?.classList.add('hidden');
  }

  if (hint) hint.textContent = '';

  if (cfg.demoLoginEnabled) {
    demoBtn?.classList.remove('hidden');
    seedBtn?.classList.remove('hidden');
  } else {
    demoBtn?.classList.add('hidden');
    seedBtn?.classList.add('hidden');
  }
}

async function loadUiConfig() {
  if (lastBootstrap && lastBootstrap.ok && typeof lastBootstrap.port === 'number' && lastBootstrap.v >= 3) {
    applyClientConfig(lastBootstrap);
    return;
  }
  try {
    const res = await apiFetch('/api/health');
    if (!res.ok) return;
    if (!(res.headers.get('content-type') || '').includes('application/json')) return;
    const cfg = await res.json();
    if (!cfg || !cfg.ok || typeof cfg.port !== 'number' || cfg.v < 3 || cfg.session === undefined) return;
    lastBootstrap = cfg;
    persistHandoffProofFromPayload(cfg);
    applyClientConfig(lastBootstrap);
  } catch (_) {
    $('ngrok-hint').textContent = '';
  }
}

function openVerificationPanel(email) {
  const panel = $('site-verify-panel');
  const mailInput = $('site-verify-email');
  if (!panel || !mailInput) return;
  if (email) mailInput.value = String(email).trim();
  panel.classList.remove('hidden');
  requestAnimationFrame(() => {
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('site-verify-code')?.focus();
  });
}

function wireApiAnchors() {
  const lo = $('logout-btn');
  if (lo) {
    lo.href = apiUrl('/auth/logout');
    if (lo.dataset.handoffClear !== '1') {
      lo.dataset.handoffClear = '1';
      lo.addEventListener('click', () => {
        try {
          sessionStorage.removeItem(HANDOFF_PROOF_KEY);
        } catch (_) {}
      });
    }
  }
  const oauth = $('btn-instagram-oauth');
  if (oauth) oauth.href = apiUrl('/auth/instagram/start');
  const importLikes = $('link-import-likes');
  if (importLikes) importLikes.href = apiUrl('/import-likes.html');
}

/**
 * Vercel → Render : le cookie de session est partitionné ; on échange un jeton à la volée pour créer une session sur le domaine de l’API.
 */
function wireImportLikesHandoff() {
  const importLikes = $('link-import-likes');
  if (!importLikes || importLikes.dataset.handoffWired === '1') return;
  importLikes.dataset.handoffWired = '1';
  importLikes.addEventListener('click', async (e) => {
    const targetHref = apiUrl('/import-likes.html');
    let crossSite = true;
    try {
      crossSite = new URL(targetHref).origin !== window.location.origin;
    } catch (_) {
      crossSite = true;
    }
    if (!crossSite) return;
    e.preventDefault();
    try {
      const res = await apiFetch('/auth/handoff/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffProof: readHandoffProofForRequest() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok || !j.token) {
        const msg =
          j.error ||
          (res.status === 401
            ? 'Connecte-toi sur cette page, puis réessaie.'
            : 'Impossible d’ouvrir l’import. Réessaie dans un instant.');
        window.alert(msg);
        return;
      }
      const u = new URL('/auth/handoff/apply', API_BASE_URL);
      u.searchParams.set('h', j.token);
      u.searchParams.set('next', '/import-likes.html');
      window.location.href = u.toString();
    } catch (_) {
      window.alert('Erreur réseau. Vérifie ta connexion et réessaie.');
    }
  });
}

async function bootstrap() {
  wireApiAnchors();
  wireImportLikesHandoff();
  readQueryError();
  initLobbySelects();
  await checkBackend();
  await loadUiConfig();
  const data = await fetchMe();
  if (!data?.authenticated) {
    showScreen('login');
    return;
  }
  syncMe(data);
  showScreen('likes');
  connectSocket();
}

$('site-login-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('auth-error').classList.add('hidden');
  $('auth-warn').classList.add('hidden');
  const emailOrUsername = $('site-login-id').value.trim();
  const password = $('site-login-password').value;
  const btn = $('btn-site-login');
  btn.disabled = true;
  try {
    const res = await apiFetch('/auth/login-site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrUsername, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 403 && body.needsVerification) {
        const hintEmail =
          body.email ||
          (emailOrUsername.includes('@') ? emailOrUsername.trim() : '');
        openVerificationPanel(hintEmail);
        $('auth-error').textContent =
          body.error ||
          'Compte non vérifié — entre le code ci-dessous ou renvoie-le par e-mail.';
        $('auth-error').classList.remove('hidden');
        return;
      }
      $('auth-error').textContent = body.error || 'Connexion impossible';
      $('auth-error').classList.remove('hidden');
      return;
    }
    persistHandoffProofFromPayload(body);
    $('site-login-password').value = '';
    invalidateBootstrap();
    const meData = await fetchMe({ force: true });
    if (meData) syncMe(meData);
    showScreen('likes');
    connectSocket();
    $('auth-warn').textContent =
      'Connecté. Ajoute des posts likés (manuellement ou via « Importer mes likes ») pour lancer une partie.';
    $('auth-warn').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

function normalizeRegistrationUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

$('site-reg-username')?.addEventListener('blur', () => {
  const el = $('site-reg-username');
  if (!el || !el.value.trim()) return;
  el.value = normalizeRegistrationUsername(el.value);
});

$('site-register-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('auth-error').classList.add('hidden');
  $('auth-warn').classList.add('hidden');
  const username = normalizeRegistrationUsername($('site-reg-username').value);
  $('site-reg-username').value = username;
  if (!/^[a-z0-9._]{3,30}$/.test(username)) {
    $('auth-error').textContent =
      'Pseudo : 3 à 30 caractères, lettres minuscules, chiffres, « . » ou « _ » uniquement (tu peux taper des majuscules, elles seront converties).';
    $('auth-error').classList.remove('hidden');
    return;
  }
  const email = $('site-reg-email').value.trim();
  const password = $('site-reg-password').value;
  const btn = $('btn-site-register');
  btn.disabled = true;
  try {
    const res = await apiFetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409 && body.pendingVerification && body.email) {
        openVerificationPanel(body.email);
        $('auth-warn').textContent =
          `${body.error || ''} Entre le code reçu par mail ou « Renvoyer le code ».`;
        $('auth-warn').classList.remove('hidden');
        return;
      }
      $('auth-error').textContent = body.error || 'Inscription impossible';
      $('auth-error').classList.remove('hidden');
      return;
    }
    $('auth-warn').textContent = body.message || 'Inscription enregistrée.';
    if (body.devCode) {
      $('auth-warn').textContent += ` (dev : code ${body.devCode})`;
    }
    $('auth-warn').classList.remove('hidden');
    openVerificationPanel(body.email || email);
    $('site-verify-code').value = '';
  } finally {
    btn.disabled = false;
  }
});

function setVerifyResendStatus(text, isError) {
  const el = $('verify-resend-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('msg-error', Boolean(isError));
}

$('btn-resend-code')?.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  $('auth-error').classList.add('hidden');
  $('auth-warn').classList.add('hidden');
  setVerifyResendStatus('');
  const email = $('site-verify-email')?.value.trim() || '';
  if (!email) {
    const msg = 'Indique ton e-mail d’inscription ci-dessus.';
    $('auth-error').textContent = msg;
    $('auth-error').classList.remove('hidden');
    setVerifyResendStatus(msg, true);
    return;
  }
  const btn = $('btn-resend-code');
  if (btn) btn.disabled = true;
  setVerifyResendStatus('Envoi en cours…');
  try {
    const res = await apiFetch('/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg = body.error || 'Impossible de renvoyer le code.';
      if (body.devCode) msg += ` (dev : ${body.devCode})`;
      $('auth-error').textContent = msg;
      $('auth-error').classList.remove('hidden');
      setVerifyResendStatus(msg, true);
      return;
    }
    const okMsg = body.message || 'Nouveau code envoyé. Vérifie ta boîte mail (et les spams).';
    $('auth-warn').textContent = okMsg;
    $('auth-warn').classList.remove('hidden');
    setVerifyResendStatus(okMsg, false);
  } catch (_) {
    const msg = 'Erreur réseau. Réessaie dans un instant.';
    $('auth-error').textContent = msg;
    $('auth-error').classList.remove('hidden');
    setVerifyResendStatus(msg, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('site-verify-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('auth-error').classList.add('hidden');
  $('auth-warn').classList.add('hidden');
  const email = $('site-verify-email').value.trim();
  const code = $('site-verify-code').value.replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) {
    $('auth-error').textContent = 'Le code doit faire 6 chiffres.';
    $('auth-error').classList.remove('hidden');
    return;
  }
  const btn = $('btn-site-verify');
  btn.disabled = true;
  try {
    const res = await apiFetch('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('auth-error').textContent = body.error || 'Vérification impossible';
      $('auth-error').classList.remove('hidden');
      return;
    }
    persistHandoffProofFromPayload(body);
    invalidateBootstrap();
    const meData = await fetchMe({ force: true });
    if (meData) syncMe(meData);
    $('site-verify-panel').classList.add('hidden');
    showScreen('likes');
    connectSocket();
    $('auth-warn').textContent = 'Compte vérifié — bienvenue !';
    $('auth-warn').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

$('login-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('auth-error').classList.add('hidden');
  $('auth-warn').classList.add('hidden');
  const username = $('ig-username').value.trim();
  const btn = $('btn-scrape-login');
  btn.disabled = true;
  try {
    const res = await apiFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('auth-error').textContent = body.error || 'Connexion impossible';
      $('auth-error').classList.remove('hidden');
      return;
    }
    persistHandoffProofFromPayload(body);
    if (body.scrapeWarning) {
      $('auth-warn').textContent = body.scrapeWarning;
      $('auth-warn').classList.remove('hidden');
    }
    invalidateBootstrap();
    const meData = await fetchMe();
    if (meData) syncMe(meData);
    showScreen('likes');
    connectSocket();
  } finally {
    btn.disabled = false;
  }
});

$('login-password-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('auth-error').classList.add('hidden');
  $('auth-warn').classList.add('hidden');
  const username = $('ig-username-password').value.trim();
  const password = $('ig-password').value;
  const btn = $('btn-password-login');
  btn.disabled = true;
  try {
    const res = await apiFetch('/auth/login-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const stage = body.stage ? ` [étape: ${body.stage}]` : '';
      const hint = body.hint ? ` ${body.hint}` : '';
      const details =
        Array.isArray(body.details) && body.details.length
          ? ` Détails: ${body.details.slice(-5).join(' → ')}`
          : '';
      let pageSnap = '';
      if (body.pageInfo && typeof body.pageInfo === 'object') {
        const pi = body.pageInfo;
        if (pi.href) pageSnap += ` URL: ${pi.href}`;
        if (pi.title) pageSnap += ` | ${pi.title}`;
        if (pi.snippet) pageSnap += ` — ${String(pi.snippet).slice(0, 220)}`;
      }
      $('auth-error').textContent = `${body.error || 'Connexion Instagram impossible'}${stage}.${hint}${details}${pageSnap ? ` ${pageSnap}` : ''}`;
      $('auth-error').classList.remove('hidden');
      return;
    }
    persistHandoffProofFromPayload(body);
    $('ig-password').value = '';
    invalidateBootstrap();
    const meData = await fetchMe({ force: true });
    if (meData) syncMe(meData);
    showScreen('likes');
    connectSocket();
    if (body.loginOnly) {
      $('auth-warn').textContent =
        'Connexion réussie. Pour charger tes likes, utilise le bouton « Importer mes likes (fichier Instagram) » sur cette page.';
      $('auth-warn').classList.remove('hidden');
    } else if (typeof body.importedLikes === 'number' && body.importedLikes > 0) {
      $('auth-warn').textContent = `Connexion OK — ${body.importedLikes} post(s) importé(s).`;
      $('auth-warn').classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
  }
});

$('btn-demo-login')?.addEventListener('click', async () => {
  $('auth-error').classList.add('hidden');
  $('auth-warn').classList.add('hidden');
  const res = await apiFetch('/auth/login-demo', {
    method: 'POST',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('auth-error').textContent = body.error || 'Démo indisponible';
    $('auth-error').classList.remove('hidden');
    return;
  }
  persistHandoffProofFromPayload(body);
  invalidateBootstrap();
  const meData = await fetchMe();
  if (meData) syncMe(meData);
  showScreen('likes');
  connectSocket();
});

$('btn-add-like').addEventListener('click', async () => {
  const input = $('like-url-input');
  const url = input.value.trim();
  $('likes-msg').classList.add('hidden');
  const res = await apiFetch('/auth/likes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('likes-msg').textContent = body.error || 'Erreur';
    $('likes-msg').classList.remove('hidden');
    return;
  }
  input.value = '';
  invalidateBootstrap();
  const data = await fetchMe();
  if (data) syncMe(data);
});

$('btn-seed-demo').addEventListener('click', async () => {
  $('likes-msg').classList.add('hidden');
  await apiFetch('/auth/likes/seed-demo', { method: 'POST' });
  invalidateBootstrap();
  const data = await fetchMe();
  if (data) syncMe(data);
});

$('btn-to-lobby').addEventListener('click', () => {
  showScreen('lobby');
  $('lobby-msg').classList.add('hidden');
});

$('btn-join').addEventListener('click', () => {
  $('lobby-msg').classList.add('hidden');
  const code = $('join-code').value.replace(/\D/g, '');
  socket.emit('join_room', { code }, (ack) => {
    if (ack?.error) {
      $('lobby-msg').textContent = ack.error;
      $('lobby-msg').classList.remove('hidden');
    }
  });
});

$('btn-create').addEventListener('click', () => {
  $('lobby-msg').classList.add('hidden');
  const rounds = Number($('opt-rounds').value);
  const timePerRoundSec = Number($('opt-time').value);
  socket.emit('create_room', { rounds, timePerRoundSec }, (ack) => {
    if (ack?.error) {
      $('lobby-msg').textContent = ack.error;
      $('lobby-msg').classList.remove('hidden');
    }
  });
});

$('btn-start').addEventListener('click', () => {
  $('room-msg').classList.add('hidden');
  socket.emit('start_game', (ack) => {
    if (ack?.error) {
      $('room-msg').textContent = ack.error;
      $('room-msg').classList.remove('hidden');
    }
  });
});

$('btn-leave-room').addEventListener('click', () => {
  socket.emit('leave_room');
  currentRoom = null;
  showScreen('lobby');
});

$('btn-back-lobby').addEventListener('click', () => {
  showScreen('lobby');
});

$('user-profile-btn')?.addEventListener('click', () => {
  openProfileModal();
});

$('profile-close-btn')?.addEventListener('click', closeProfileModal);
$('profile-close-backdrop')?.addEventListener('click', closeProfileModal);

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
  $('auth-error').classList.add('hidden');
  try {
    const fd = new FormData();
    fd.append('photo', file);
    const res = await fetch(apiUrl('/auth/profile/avatar'), {
      method: 'POST',
      body: fd,
      credentials: 'include',
      cache: 'no-store',
      headers: { 'ngrok-skip-browser-warning': '69420' },
    });
    const body = await res.json().catch(() => ({}));
    input.value = '';
    if (!res.ok || !body.ok) {
      $('auth-error').textContent = body.error || 'Envoi de la photo impossible.';
      $('auth-error').classList.remove('hidden');
      return;
    }
    invalidateBootstrap();
    const meData = await fetchMe({ force: true });
    if (meData) syncMe(meData);
    if (body.user) {
      setUserPill(body.user);
      setAvatar($('profile-big-avatar'), body.user.profile_picture, body.user.username);
    } else {
      openProfileModal();
    }
    $('auth-warn').textContent = 'Photo de profil mise à jour.';
    $('auth-warn').classList.remove('hidden');
  } catch (_) {
    $('auth-error').textContent = 'Erreur réseau lors de l’envoi de la photo.';
    $('auth-error').classList.remove('hidden');
  }
});

$('profile-save-bio')?.addEventListener('click', async () => {
  const bio = $('profile-bio-input').value.slice(0, 500);
  try {
    const res = await apiFetch('/auth/profile/bio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      $('auth-error').textContent = body.error || 'Impossible d’enregistrer la bio.';
      $('auth-error').classList.remove('hidden');
      return;
    }
    renderProfileModal(body.profile);
    $('auth-warn').textContent = 'Bio enregistrée.';
    $('auth-warn').classList.remove('hidden');
  } catch (_) {
    $('auth-error').textContent = 'Erreur réseau pendant la sauvegarde.';
    $('auth-error').classList.remove('hidden');
  }
});

bootstrap();

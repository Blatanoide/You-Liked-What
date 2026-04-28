/**
 * Socket.io — logique multijoueur « You Liked What? »
 * Événements : create_room, join_room, start_game, new_round, player_answer, score_update, end_game
 */

const instagramService = require('../services/instagramService');
const likesStore = require('../services/likesStore');
const { MIN_LIKES } = require('../config/constants');
const { hydrateLikesMiddleware } = require('../middleware/hydrateLikes');
const playerStatsStore = require('../services/playerStatsStore');
const { queueTursoDb } = require('../services/openDatabase');
const { expandProfilePictureUrl } = require('../utils/publicUrl');

const MAX_PLAYERS = 15;
const MIN_PLAYERS_TO_START = 2;
const ALLOWED_ROUNDS = new Set([5, 10, 15, 20, 30, 50]);
const ALLOWED_TIMES_SEC = new Set([10, 20, 30]);

const BASE_POINTS = 100;
const MAX_SPEED_BONUS = 100;
const BETWEEN_ROUNDS_MS = 2500;

/** @type {Map<string, object>} */
const rooms = new Map();
/** socket.id -> roomCode */
const socketToRoom = new Map();

function log(...args) {
  console.log('[Game]', ...args);
}

function randomDigitsCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function ensureUniqueRoomCode() {
  for (let i = 0; i < 50; i += 1) {
    const c = randomDigitsCode();
    if (!rooms.has(c)) return c;
  }
  return `${Date.now()}`.slice(-6);
}

function getPlayerFromSession(session) {
  if (!session?.user?.id) return null;
  const likes = Array.isArray(session.simulatedLikes) ? session.simulatedLikes : [];
  return {
    instagramId: String(session.user.id),
    username: session.user.username || 'Joueur',
    profile_picture: expandProfilePictureUrl(null, session.user.profile_picture || null),
    likes: [...likes],
  };
}

function broadcastToRoom(io, roomCode, event, payload) {
  io.to(`room:${roomCode}`).emit(event, payload);
}

/**
 * État room pour le client — l’hôte est déduit côté UI via hostInstagramId et ton id.
 */
function roomPayloadForClient(room) {
  const players = [...room.players.values()].map((p) => ({
    instagramId: p.instagramId,
    username: p.username,
    profile_picture: p.profile_picture,
    likesCount: p.likes.length,
    canPlay: p.likes.length >= MIN_LIKES,
  }));
  return {
    code: room.code,
    hostInstagramId: room.hostInstagramId,
    settings: { ...room.settings },
    players,
    phase: room.phase,
    currentRound: room.currentRound,
    totalRounds: room.settings.rounds,
    scores: Object.fromEntries(room.scores),
  };
}

function pickRandomAnswerer(room) {
  const eligible = [...room.players.values()].filter((p) => p.likes.length >= MIN_LIKES);
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

/**
 * Posts likés par au moins 2 joueurs différents → exclus du tirage (ambiguïté « qui a liké »).
 */
function collectAmbiguousNormalizedUrls(room) {
  const counts = new Map();
  for (const pl of room.players.values()) {
    const seenLocal = new Set();
    for (const raw of pl.likes || []) {
      const key = likesStore.normalizePostUrl(raw) || String(raw).trim().split('?')[0];
      if (!key || seenLocal.has(key)) continue;
      seenLocal.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const ambiguous = new Set();
  for (const [url, n] of counts) {
    if (n >= 2) ambiguous.add(url);
  }
  return ambiguous;
}

function pickRandomPostForRound(room, answerer) {
  const likes = answerer.likes || [];
  if (!likes.length) return null;
  const ambiguous = collectAmbiguousNormalizedUrls(room);
  const filtered = likes.filter((raw) => {
    const key = likesStore.normalizePostUrl(raw) || String(raw).trim().split('?')[0];
    return !ambiguous.has(key);
  });
  const pool = filtered.length > 0 ? filtered : likes;
  return pool[Math.floor(Math.random() * pool.length)];
}

function clearRoundTimer(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
}

/**
 * Finalise le round en cours : calcule les points, émet score_update et round_end.
 */
function finalizeRound(io, room, reason) {
  if (room.phase !== 'round' || !room.roundState) return;

  clearRoundTimer(room);
  const { answererInstagramId, postUrl, embedUrl, timeLimitMs, startedAt, answers } = room.roundState;
  const deadline = startedAt + timeLimitMs;

  const gained = {};
  for (const p of room.players.values()) {
    const ans = answers.get(p.instagramId);
    if (!ans) continue;
    if (String(ans.guessInstagramId) !== String(answererInstagramId)) continue;

    const remaining = Math.max(0, deadline - ans.answeredAt);
    const speedRatio = timeLimitMs > 0 ? remaining / timeLimitMs : 0;
    const bonus = Math.round(speedRatio * MAX_SPEED_BONUS);
    const total = BASE_POINTS + bonus;

    const prev = room.scores.get(p.instagramId) || 0;
    room.scores.set(p.instagramId, prev + total);
    gained[p.instagramId] = { total, base: BASE_POINTS, bonus, correct: true };
  }

  for (const [playerId, ans] of answers.entries()) {
    const reactionMs = Math.max(0, Math.round(ans.answeredAt - startedAt));
    const prev = room.reactionStats.get(playerId) || { sumMs: 0, count: 0 };
    room.reactionStats.set(playerId, {
      sumMs: prev.sumMs + reactionMs,
      count: prev.count + 1,
    });
  }

  broadcastToRoom(io, room.code, 'round_end', {
    reason,
    correctAnswerInstagramId: answererInstagramId,
    postUrl,
    embedUrl,
    scores: Object.fromEntries(room.scores),
    pointsThisRound: gained,
  });

  broadcastToRoom(io, room.code, 'score_update', {
    scores: Object.fromEntries(room.scores),
  });

  room.phase = 'between';
  room.roundState = null;

  if (room.currentRound >= room.settings.rounds) {
    room.phase = 'ended';
    log('Partie terminée room', room.code);
    const playersSnap = [...room.players.values()].map((p) => ({
      instagramId: p.instagramId,
      username: p.username,
      profile_picture: p.profile_picture || null,
    }));
    const scoresSnap = new Map(room.scores);
    const reactionSnap = new Map(room.reactionStats);
    void queueTursoDb(() => {
      try {
        playerStatsStore.recordCompletedGame(playersSnap, scoresSnap, reactionSnap);
      } catch (e) {
        log('stats save error', e.message || e);
      }
    }).catch((e) => log('stats save error', e.message || e));
    broadcastToRoom(io, room.code, 'end_game', {
      finalScores: Object.fromEntries(room.scores),
      leaderboard: [...room.scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([instagramId, score]) => {
          const pl = [...room.players.values()].find((x) => x.instagramId === instagramId);
          return { instagramId, username: pl?.username || '?', score };
        }),
    });
    return;
  }

  room.betweenTimer = setTimeout(() => {
    room.betweenTimer = null;
    startNextRound(io, room);
  }, BETWEEN_ROUNDS_MS);
}

/**
 * Démarre le prochain round (choix du « liker » et du post).
 */
async function startNextRound(io, room) {
  if (room.phase === 'ended') return;

  room.currentRound += 1;
  const answerer = pickRandomAnswerer(room);
  if (!answerer) {
    log('Aucun joueur éligible (likes) room', room.code);
    room.phase = 'ended';
    broadcastToRoom(io, room.code, 'end_game', {
      error: 'Plus assez de posts likés simulés pour continuer.',
      finalScores: Object.fromEntries(room.scores),
    });
    return;
  }

  const postUrl = pickRandomPostForRound(room, answerer);
  const embedUrl = instagramService.getEmbedUrlFromPostUrl(postUrl);
  let thumbnailUrl = null;
  let videoUrl = null;
  try {
    [thumbnailUrl, videoUrl] = await Promise.all([
      instagramService.tryFetchOembedThumbnail(postUrl),
      instagramService.tryFetchDirectVideoUrl(postUrl),
    ]);
  } catch (_) {
    /* ignore */
  }

  const timeLimitMs = room.settings.timePerRoundSec * 1000;
  const startedAt = Date.now();

  room.phase = 'round';
  room.roundState = {
    answererInstagramId: answerer.instagramId,
    postUrl,
    embedUrl,
    thumbnailUrl,
    videoUrl,
    timeLimitMs,
    startedAt,
    answers: new Map(),
  };

  const choices = [...room.players.values()].map((p) => ({
    instagramId: p.instagramId,
    username: p.username,
    profile_picture: p.profile_picture,
  }));

  const baseRound = {
    round: room.currentRound,
    totalRounds: room.settings.rounds,
    timeLimitSec: room.settings.timePerRoundSec,
    post: { url: postUrl, embedUrl, thumbnailUrl, videoUrl },
    choices,
  };

  for (const [socketId, pl] of room.players) {
    io.to(socketId).emit('new_round', {
      ...baseRound,
      /** true uniquement pour le joueur dont le post a été tiré — pas de fuite pour les autres */
      isYourSimulatedLike: String(pl.instagramId) === String(answerer.instagramId),
    });
  }

  room.roundTimer = setTimeout(() => {
    finalizeRound(io, room, 'timeout');
  }, timeLimitMs);
}

function removePlayerFromRoom(io, socket, roomCode, quiet = false) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const p = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(`room:${roomCode}`);
  socketToRoom.delete(socket.id);

  if (!quiet) log('Joueur quitte', roomCode, p?.username);

  /** Partie en cours : un départ interrompt la partie (état simplifié). */
  if (p && room.phase !== 'lobby' && room.phase !== 'ended') {
    clearRoundTimer(room);
    if (room.betweenTimer) {
      clearTimeout(room.betweenTimer);
      room.betweenTimer = null;
    }
    room.phase = 'ended';
    room.roundState = null;
    broadcastToRoom(io, roomCode, 'end_game', {
      error: `${p.username} a quitté — partie interrompue.`,
      finalScores: Object.fromEntries(room.scores),
      leaderboard: [...room.scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([instagramId, score]) => {
          const pl = [...room.players.values()].find((x) => x.instagramId === instagramId);
          return { instagramId, username: pl?.username || '?', score };
        }),
    });
  }

  if (room.players.size === 0) {
    clearRoundTimer(room);
    if (room.betweenTimer) clearTimeout(room.betweenTimer);
    rooms.delete(roomCode);
    log('Room supprimée (vide)', roomCode);
    return;
  }

  if (p && room.hostInstagramId === p.instagramId) {
    const next = room.players.values().next().value;
    room.hostInstagramId = next.instagramId;
    log('Nouvel hôte room', roomCode, next.username);
  }

  broadcastToRoom(io, roomCode, 'room_update', roomPayloadForClient(room));
}

/**
 * Attache la logique jeu à l’instance Socket.io (avec session Express).
 */
function attachGameSocket(io, sessionMiddleware) {
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, (err) => {
      if (err) return next(err);
      hydrateLikesMiddleware(socket.request, {}, next);
    });
  });

  io.on('connection', (socket) => {
    log('Connexion socket', socket.id);

    socket.on('create_room', (data, ack) => {
      const session = socket.request.session;
      const base = getPlayerFromSession(session);
      if (!base) {
        const err = { error: 'Tu dois être connecté.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const rounds = Number(data?.rounds);
      const timePerRoundSec = Number(data?.timePerRoundSec ?? data?.time);
      if (!ALLOWED_ROUNDS.has(rounds) || !ALLOWED_TIMES_SEC.has(timePerRoundSec)) {
        const err = { error: 'Paramètres de partie invalides.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      if (base.likes.length < MIN_LIKES) {
        const err = { error: `Ajoute au moins ${MIN_LIKES} posts à tes likes simulés avant de créer une room.` };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const prevCode = socketToRoom.get(socket.id);
      if (prevCode) removePlayerFromRoom(io, socket, prevCode, true);

      const code = ensureUniqueRoomCode();
      const room = {
        code,
        hostInstagramId: base.instagramId,
        settings: { rounds, timePerRoundSec },
        players: new Map(),
        scores: new Map(),
        phase: 'lobby',
        currentRound: 0,
        roundState: null,
        roundTimer: null,
        betweenTimer: null,
        reactionStats: new Map(),
      };

      room.players.set(socket.id, { socketId: socket.id, ...base });
      playerStatsStore.upsertIdentity({
        id: base.instagramId,
        username: base.username,
        profile_picture: base.profile_picture || null,
      });
      room.scores.set(base.instagramId, 0);
      rooms.set(code, room);
      socket.join(`room:${code}`);
      socketToRoom.set(socket.id, code);

      log('Room créée', code, 'par', base.username, `(${rounds} rounds, ${timePerRoundSec}s)`);

      const payload = roomPayloadForClient(room);
      if (typeof ack === 'function') ack({ ok: true, room: payload });
      socket.emit('room_joined', payload);
      broadcastToRoom(io, code, 'room_update', payload);
    });

    socket.on('join_room', (data, ack) => {
      const session = socket.request.session;
      const base = getPlayerFromSession(session);
      if (!base) {
        const err = { error: 'Tu dois être connecté.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const code = String(data?.code || '').replace(/\D/g, '').slice(0, 6);
      if (code.length !== 6) {
        const err = { error: 'Code room invalide (6 chiffres).' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const room = rooms.get(code);
      if (!room) {
        const err = { error: 'Room introuvable.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      if (room.phase !== 'lobby') {
        const err = { error: 'La partie a déjà commencé.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      if (room.players.size >= MAX_PLAYERS) {
        const err = { error: `Room pleine (max ${MAX_PLAYERS}).` };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      if (base.likes.length < MIN_LIKES) {
        const err = { error: `Ajoute au moins ${MIN_LIKES} posts simulés avant de rejoindre.` };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const prevCode = socketToRoom.get(socket.id);
      if (prevCode && prevCode !== code) removePlayerFromRoom(io, socket, prevCode, true);

      const existing = [...room.players.values()].find((p) => p.instagramId === base.instagramId);
      if (existing) {
        room.players.delete(existing.socketId);
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket) {
          oldSocket.leave(`room:${code}`);
          socketToRoom.delete(existing.socketId);
        }
      }

      room.players.set(socket.id, { socketId: socket.id, ...base });
      playerStatsStore.upsertIdentity({
        id: base.instagramId,
        username: base.username,
        profile_picture: base.profile_picture || null,
      });
      if (!room.scores.has(base.instagramId)) room.scores.set(base.instagramId, 0);

      socket.join(`room:${code}`);
      socketToRoom.set(socket.id, code);

      log(base.username, 'a rejoint', code);

      const payload = roomPayloadForClient(room);
      if (typeof ack === 'function') ack({ ok: true, room: payload });
      socket.emit('room_joined', payload);
      broadcastToRoom(io, code, 'room_update', payload);
    });

    socket.on('start_game', (ack) => {
      const code = socketToRoom.get(socket.id);
      if (!code) {
        const err = { error: 'Tu n’es dans aucune room.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const room = rooms.get(code);
      const me = room?.players.get(socket.id);
      if (!room || !me || me.instagramId !== room.hostInstagramId) {
        const err = { error: 'Seul l’hôte peut lancer la partie.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      if (room.phase !== 'lobby') {
        const err = { error: 'La partie est déjà en cours ou terminée.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      if (room.players.size < MIN_PLAYERS_TO_START) {
        const err = { error: `Il faut au moins ${MIN_PLAYERS_TO_START} joueurs.` };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      for (const p of room.players.values()) {
        if (p.likes.length < MIN_LIKES) {
          const err = { error: `Le joueur ${p.username} n’a pas assez de likes simulés.` };
          if (typeof ack === 'function') ack(err);
          return socket.emit('error_message', err);
        }
      }

      room.phase = 'playing';
      room.currentRound = 0;
      log('Démarrage partie', code);

      if (typeof ack === 'function') ack({ ok: true });
      broadcastToRoom(io, code, 'room_update', roomPayloadForClient(room));
      startNextRound(io, room);
    });

    socket.on('player_answer', (data, ack) => {
      const code = socketToRoom.get(socket.id);
      const room = code ? rooms.get(code) : null;
      const me = room?.players.get(socket.id);

      if (!room || !me || room.phase !== 'round' || !room.roundState) {
        const err = { error: 'Pas de round en cours.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const guess = String(data?.guessInstagramId ?? '');
      if (!guess) {
        const err = { error: 'Choisis un joueur.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      if (room.roundState.answers.has(me.instagramId)) {
        const err = { error: 'Tu as déjà répondu pour ce round.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      const now = Date.now();
      if (now > room.roundState.startedAt + room.roundState.timeLimitMs) {
        const err = { error: 'Temps écoulé.' };
        if (typeof ack === 'function') ack(err);
        return socket.emit('error_message', err);
      }

      room.roundState.answers.set(me.instagramId, {
        guessInstagramId: guess,
        answeredAt: now,
      });

      if (typeof ack === 'function') ack({ ok: true });

      const mustGuess = [...room.players.values()];
      const allGuessed = mustGuess.every((p) => room.roundState.answers.has(p.instagramId));
      if (allGuessed) {
        finalizeRound(io, room, 'all_answered');
      }
    });

    socket.on('leave_room', () => {
      const code = socketToRoom.get(socket.id);
      if (code) removePlayerFromRoom(io, socket, code);
    });

    socket.on('disconnect', () => {
      const code = socketToRoom.get(socket.id);
      if (code) removePlayerFromRoom(io, socket, code);
      log('Déconnexion socket', socket.id);
    });
  });
}

module.exports = { attachGameSocket, rooms };

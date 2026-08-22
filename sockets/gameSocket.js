/**
 * Socket.io — SoundGuess (blind test musical multijoueur)
 */

const tracksStore = require('../services/tracksStore');
const musicService = require('../services/musicService');
const playerStatsStore = require('../services/playerStatsStore');
const { queueTursoDb } = require('../services/openDatabase');
const { expandProfilePictureUrl } = require('../utils/publicUrl');

const MAX_PLAYERS = 15;
const MIN_PLAYERS_TO_START = 2;
const ALLOWED_ROUNDS = new Set([5, 10, 15, 20, 30, 50]);
const ALLOWED_TIMES_SEC = new Set([10, 20, 30, 45, 60]);

const BASE_POINTS = 100;
const MAX_SPEED_BONUS = 100;
const BETWEEN_ROUNDS_MS = 2800;
const MAX_TRACK_PICK_ATTEMPTS = 12;

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
  return {
    playerId: String(session.user.id),
    username: session.user.username || 'Joueur',
    profile_picture: expandProfilePictureUrl(null, session.user.profile_picture || null),
  };
}

function broadcastToRoom(io, roomCode, event, payload) {
  io.to(`room:${roomCode}`).emit(event, payload);
}

function roomPayloadForClient(room) {
  const players = [...room.players.values()].map((p) => ({
    playerId: p.playerId,
    username: p.username,
    profile_picture: p.profile_picture,
  }));
  return {
    code: room.code,
    hostPlayerId: room.hostPlayerId,
    settings: { ...room.settings },
    players,
    phase: room.phase,
    currentRound: room.currentRound,
    totalRounds: room.settings.rounds,
    scores: Object.fromEntries(room.scores),
  };
}

function clearRoundTimer(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
}

function finalizeRound(io, room, reason) {
  if (room.phase !== 'round' || !room.roundState) return;

  clearRoundTimer(room);
  const { track, timeLimitMs, startedAt, answers } = room.roundState;
  const deadline = startedAt + timeLimitMs;
  const gained = {};

  for (const p of room.players.values()) {
    const ans = answers.get(p.playerId);
    if (!ans || !ans.correct) continue;
    const remaining = Math.max(0, deadline - ans.answeredAt);
    const speedRatio = timeLimitMs > 0 ? remaining / timeLimitMs : 0;
    const bonus = Math.round(speedRatio * MAX_SPEED_BONUS);
    const total = BASE_POINTS + bonus;
    gained[p.playerId] = { total, base: BASE_POINTS, bonus, correct: true };
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
    track: { title: track.title, artist: track.artist },
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
      instagramId: p.playerId,
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
        .map(([playerId, score]) => {
          const pl = [...room.players.values()].find((x) => x.playerId === playerId);
          return { playerId, username: pl?.username || '?', score };
        }),
    });
    return;
  }

  room.betweenTimer = setTimeout(() => {
    room.betweenTimer = null;
    startNextRound(io, room);
  }, BETWEEN_ROUNDS_MS);
}

async function resolveTrackWithPreview(excludeIds) {
  for (let i = 0; i < MAX_TRACK_PICK_ATTEMPTS; i += 1) {
    const track = tracksStore.pickRandomTrack(excludeIds);
    if (!track) return null;
    excludeIds.add(track.id);
    let preview = track.preview_url;
    if (!preview) {
      preview = await musicService.resolvePreviewUrl(track.artist, track.title);
      if (preview) tracksStore.setPreviewUrl(track.id, preview);
    }
    if (preview) return { ...track, preview_url: preview };
  }
  return null;
}

async function startNextRound(io, room) {
  if (room.phase === 'ended') return;

  room.currentRound += 1;
  const track = await resolveTrackWithPreview(room.usedTrackIds);
  if (!track) {
    log('Plus de morceaux avec preview room', room.code);
    room.phase = 'ended';
    broadcastToRoom(io, room.code, 'end_game', {
      error: 'Impossible de charger un extrait audio. Réessaie plus tard.',
      finalScores: Object.fromEntries(room.scores),
    });
    return;
  }

  room.usedTrackIds.add(track.id);

  const timeLimitMs = room.settings.timePerRoundSec * 1000;
  const startedAt = Date.now();

  room.phase = 'round';
  room.roundState = {
    track,
    timeLimitMs,
    startedAt,
    answers: new Map(),
    locked: new Set(),
  };

  broadcastToRoom(io, room.code, 'new_round', {
    round: room.currentRound,
    totalRounds: room.settings.rounds,
    timeLimitSec: room.settings.timePerRoundSec,
    audioUrl: track.preview_url,
  });

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
        .map(([playerId, score]) => {
          const pl = [...room.players.values()].find((x) => x.playerId === playerId);
          return { playerId, username: pl?.username || '?', score };
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

  if (p && room.hostPlayerId === p.playerId) {
    const next = room.players.values().next().value;
    room.hostPlayerId = next.playerId;
    log('Nouvel hôte room', roomCode, next.username);
  }

  broadcastToRoom(io, roomCode, 'room_update', roomPayloadForClient(room));
}

function attachGameSocket(io, sessionMiddleware) {
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, (err) => {
      if (err) return next(err);
      next();
    });
  });

  io.on('connection', (socket) => {
    log('Connexion socket', socket.id);

    socket.on('create_room', (data, ack) => {
      const base = getPlayerFromSession(socket.request.session);
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

      const prevCode = socketToRoom.get(socket.id);
      if (prevCode) removePlayerFromRoom(io, socket, prevCode, true);

      const code = ensureUniqueRoomCode();
      const room = {
        code,
        hostPlayerId: base.playerId,
        settings: { rounds, timePerRoundSec },
        players: new Map(),
        scores: new Map(),
        phase: 'lobby',
        currentRound: 0,
        roundState: null,
        roundTimer: null,
        betweenTimer: null,
        reactionStats: new Map(),
        usedTrackIds: new Set(),
      };

      room.players.set(socket.id, { socketId: socket.id, ...base });
      playerStatsStore.upsertIdentity({
        id: base.playerId,
        username: base.username,
        profile_picture: base.profile_picture || null,
      });
      room.scores.set(base.playerId, 0);
      rooms.set(code, room);
      socket.join(`room:${code}`);
      socketToRoom.set(socket.id, code);

      log('Room créée', code, 'par', base.username);

      const payload = roomPayloadForClient(room);
      if (typeof ack === 'function') ack({ ok: true, room: payload });
      socket.emit('room_joined', payload);
      broadcastToRoom(io, code, 'room_update', payload);
    });

    socket.on('join_room', (data, ack) => {
      const base = getPlayerFromSession(socket.request.session);
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

      const prevCode = socketToRoom.get(socket.id);
      if (prevCode && prevCode !== code) removePlayerFromRoom(io, socket, prevCode, true);

      const existing = [...room.players.values()].find((p) => p.playerId === base.playerId);
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
        id: base.playerId,
        username: base.username,
        profile_picture: base.profile_picture || null,
      });
      if (!room.scores.has(base.playerId)) room.scores.set(base.playerId, 0);

      socket.join(`room:${code}`);
      socketToRoom.set(socket.id, code);

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
      if (!room || !me || me.playerId !== room.hostPlayerId) {
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

      room.phase = 'playing';
      room.currentRound = 0;
      room.usedTrackIds = new Set();
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

      const rs = room.roundState;
      if (rs.locked.has(me.playerId)) {
        const err = { error: 'Mauvaise réponse — tu ne peux plus deviner ce morceau.' };
        if (typeof ack === 'function') ack(err);
        return;
      }

      if (rs.answers.has(me.playerId)) {
        const err = { error: 'Tu as déjà répondu pour ce round.' };
        if (typeof ack === 'function') ack(err);
        return;
      }

      const guess = String(data?.guess ?? data?.title ?? '').trim();
      if (!guess) {
        const err = { error: 'Entre un titre.' };
        if (typeof ack === 'function') ack(err);
        return;
      }

      const now = Date.now();
      if (now > rs.startedAt + rs.timeLimitMs) {
        const err = { error: 'Temps écoulé.' };
        if (typeof ack === 'function') ack(err);
        return;
      }

      const correct = musicService.isGuessCorrect(guess, rs.track);
      rs.answers.set(me.playerId, { guess, answeredAt: now, correct });

      if (correct) {
        const remaining = Math.max(0, rs.startedAt + rs.timeLimitMs - now);
        const speedRatio = rs.timeLimitMs > 0 ? remaining / rs.timeLimitMs : 0;
        const bonus = Math.round(speedRatio * MAX_SPEED_BONUS);
        const total = BASE_POINTS + bonus;
        const prev = room.scores.get(me.playerId) || 0;
        room.scores.set(me.playerId, prev + total);

        if (typeof ack === 'function') {
          ack({ ok: true, correct: true, points: total, bonus, scores: Object.fromEntries(room.scores) });
        }
        broadcastToRoom(io, room.code, 'score_update', { scores: Object.fromEntries(room.scores) });
      } else {
        rs.locked.add(me.playerId);
        if (typeof ack === 'function') {
          ack({ ok: true, correct: false, locked: true });
        }
      }

      const allDone = [...room.players.values()].every((p) => rs.answers.has(p.playerId));
      if (allDone) {
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

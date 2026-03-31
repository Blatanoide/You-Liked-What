/**
 * Stockage profil joueur + stats de parties.
 */

const likesStore = require('./likesStore');

function getDb() {
  const db = likesStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      bio TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS user_game_stats (
      user_id TEXT PRIMARY KEY,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      reaction_sum_ms INTEGER NOT NULL DEFAULT 0,
      reaction_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS user_identity (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      profile_picture TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS user_played_with (
      user_id TEXT NOT NULL,
      other_user_id TEXT NOT NULL,
      games_together INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, other_user_id)
    );
  `);
  return db;
}

function upsertIdentity(user) {
  if (!user?.id) return;
  getDb()
    .prepare(
      `INSERT INTO user_identity (user_id, username, profile_picture, updated_at)
       VALUES (?, ?, ?, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         profile_picture = excluded.profile_picture,
         updated_at = excluded.updated_at`
    )
    .run(String(user.id), String(user.username || 'Joueur'), user.profile_picture || null);
}

function setBio(userId, bio) {
  const clean = String(bio || '').trim().slice(0, 500);
  getDb()
    .prepare(
      `INSERT INTO user_profiles (user_id, bio, updated_at)
       VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         bio = excluded.bio,
         updated_at = excluded.updated_at`
    )
    .run(String(userId), clean);
  return clean;
}

function getProfileSummary(userId) {
  const uid = String(userId);
  const db = getDb();
  const identity = db
    .prepare('SELECT user_id, username, profile_picture FROM user_identity WHERE user_id = ?')
    .get(uid);
  const profile = db.prepare('SELECT bio FROM user_profiles WHERE user_id = ?').get(uid);
  const stats = db
    .prepare(
      'SELECT games_played, wins, reaction_sum_ms, reaction_count FROM user_game_stats WHERE user_id = ?'
    )
    .get(uid) || { games_played: 0, wins: 0, reaction_sum_ms: 0, reaction_count: 0 };

  const avgReactionMs =
    stats.reaction_count > 0 ? Math.round(stats.reaction_sum_ms / stats.reaction_count) : null;
  const winRate = stats.games_played > 0 ? Math.round((stats.wins / stats.games_played) * 100) : 0;

  const playedWith = db
    .prepare(
      `SELECT p.other_user_id AS userId, p.games_together AS gamesTogether, i.username, i.profile_picture
       FROM user_played_with p
       LEFT JOIN user_identity i ON i.user_id = p.other_user_id
       WHERE p.user_id = ?
       ORDER BY p.games_together DESC, LOWER(COALESCE(i.username, p.other_user_id)) ASC
       LIMIT 3`
    )
    .all(uid)
    .map((r) => ({
      userId: r.userId,
      username: r.username || r.userId,
      profile_picture: r.profile_picture || null,
      gamesTogether: r.gamesTogether,
    }));

  return {
    userId: uid,
    username: identity?.username || null,
    profile_picture: identity?.profile_picture || null,
    bio: profile?.bio || '',
    stats: {
      gamesPlayed: stats.games_played || 0,
      wins: stats.wins || 0,
      winRate,
      avgReactionMs,
    },
    podium: playedWith,
  };
}

/**
 * @param {{instagramId:string,username:string,profile_picture?:string|null}[]} players
 * @param {Map<string, number>} scoresMap
 * @param {Map<string, {sumMs:number,count:number}>} reactionStatsMap
 */
function recordCompletedGame(players, scoresMap, reactionStatsMap) {
  if (!Array.isArray(players) || players.length < 2) return;
  const db = getDb();
  const playerIds = players.map((p) => String(p.instagramId));
  const maxScore = Math.max(...playerIds.map((id) => Number(scoresMap.get(id) || 0)));
  const winners = new Set(playerIds.filter((id) => Number(scoresMap.get(id) || 0) === maxScore));

  const upsertStatsStmt = db.prepare(
    `INSERT INTO user_game_stats (user_id, games_played, wins, reaction_sum_ms, reaction_count, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(user_id) DO UPDATE SET
       games_played = user_game_stats.games_played + excluded.games_played,
       wins = user_game_stats.wins + excluded.wins,
       reaction_sum_ms = user_game_stats.reaction_sum_ms + excluded.reaction_sum_ms,
       reaction_count = user_game_stats.reaction_count + excluded.reaction_count,
       updated_at = excluded.updated_at`
  );
  const upsertPairStmt = db.prepare(
    `INSERT INTO user_played_with (user_id, other_user_id, games_together)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, other_user_id) DO UPDATE SET
       games_together = user_played_with.games_together + 1`
  );

  const tx = db.transaction(() => {
    for (const p of players) {
      upsertIdentity({
        id: p.instagramId,
        username: p.username,
        profile_picture: p.profile_picture || null,
      });
    }

    for (const uid of playerIds) {
      const react = reactionStatsMap.get(uid) || { sumMs: 0, count: 0 };
      upsertStatsStmt.run(uid, 1, winners.has(uid) ? 1 : 0, react.sumMs || 0, react.count || 0);
    }

    for (let i = 0; i < playerIds.length; i += 1) {
      for (let j = 0; j < playerIds.length; j += 1) {
        if (i === j) continue;
        upsertPairStmt.run(playerIds[i], playerIds[j]);
      }
    }
  });
  tx();
}

module.exports = {
  getDb,
  upsertIdentity,
  setBio,
  getProfileSummary,
  recordCompletedGame,
};


/**
 * Remplit req.session.simulatedLikes depuis SQLite (après express-session).
 */

const likesStore = require('../services/likesStore');

function hydrateLikesMiddleware(req, res, next) {
  likesStore.hydrateSession(req);
  next();
}

module.exports = { hydrateLikesMiddleware };

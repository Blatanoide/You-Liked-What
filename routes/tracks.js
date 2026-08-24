/**
 * API catalogue SoundGuess — autocomplétion des titres.
 */

const express = require('express');
const tracksStore = require('../services/tracksStore');
const musicService = require('../services/musicService');

const router = express.Router();

router.get('/stats', (req, res) => {
  return res.json({ ok: true, ...tracksStore.catalogStats() });
});

router.get('/suggest', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ ok: true, suggestions: [] });
  }
  const tracks = tracksStore.listAll();
  const suggestions = musicService.suggestFromCatalog(tracks, q, 10);
  return res.json({ ok: true, suggestions });
});

module.exports = router;

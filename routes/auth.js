/**
 * Auth (scrape profil) + likes simulés.
 */

const express = require('express');
const multer = require('multer');
const authController = require('../controllers/authController');
const importLikesController = require('../controllers/importLikesController');
const instagramExportIngest = require('../services/instagramExportIngest');

const router = express.Router();

const uploadExport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: instagramExportIngest.MAX_ZIP_BYTES, files: 40 },
});
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

/** Évite 404 si un client fait GET (ancien lien, formulaire sans JS, etc.) */
router.get('/login', (req, res) => res.redirect(302, '/'));

router.get('/instagram/start', authController.instagramOAuthStart);
router.get('/instagram/callback', authController.instagramOAuthCallback);

router.post('/login', authController.loginWithScrape);
router.post('/login-password', authController.loginWithPuppeteerCredentials);
router.post('/login-demo', authController.loginDemo);
router.get('/logout', authController.logout);
router.get('/me', authController.me);
router.get('/profile', authController.myProfile);
router.post('/profile/bio', authController.updateMyBio);
router.post('/likes', authController.addSimulatedLike);
router.post('/likes/remove', authController.removeSimulatedLike);
router.post('/likes/seed-demo', authController.seedFakeLikes);
/** Export Instagram : multipart « files » — .zip et/ou .json / .html */
router.post('/likes/import-export', (req, res, next) => {
  uploadExport.array('files', 40)(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Fichier trop volumineux (max 200 Mo par fichier).'
          : err.message || 'Erreur lors de l’envoi des fichiers.';
      return res.status(400).json({ error: msg });
    }
    importLikesController.importFromInstagramExport(req, res);
  });
});
/** V1 : POST { username, password } — fusionne les posts dans les likes simulés */
router.post('/scrape-likes', authController.scrapeLikesPuppeteer);

module.exports = router;

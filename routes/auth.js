/**
 * Auth (scrape profil) + likes simulés.
 */

const fs = require('fs');
const path = require('path');
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

const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(__dirname, '..', 'uploads', 'profiles');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const uid = String(req.session?.user?.id || 'x').replace(/[^a-z0-9_-]/gi, '');
      const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
      };
      const ext = map[file.mimetype] || '.jpg';
      cb(null, `${uid}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('BAD_IMAGE_TYPE'), ok);
  },
});
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

/** Évite 404 si un client fait GET (ancien lien, formulaire sans JS, etc.) */
router.get('/login', (req, res) => res.redirect(302, '/'));

router.get('/instagram/start', authController.instagramOAuthStart);
router.get('/instagram/callback', authController.instagramOAuthCallback);

router.post('/register', authController.registerSite);
router.post('/verify-email', authController.verifySiteEmail);
router.post('/resend-verification', authController.resendVerification);
router.post('/login-site', authController.loginSite);
router.post('/handoff/create', authController.createHandoff);
router.get('/handoff/apply', authController.applyHandoffGet);
router.post('/handoff/consume', authController.consumeHandoff);
router.post('/profile/avatar', (req, res, next) => {
  uploadAvatar.single('photo')(req, res, (err) => {
    if (err) {
      const msg =
        err.message === 'BAD_IMAGE_TYPE'
          ? 'Format d’image non accepté (JPEG, PNG, WebP, GIF).'
          : err.code === 'LIMIT_FILE_SIZE'
            ? 'Image trop volumineuse (max 3 Mo).'
            : err.message || 'Erreur lors de l’envoi du fichier.';
      return res.status(400).json({ error: msg });
    }
    authController.uploadProfileAvatar(req, res);
  });
});

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

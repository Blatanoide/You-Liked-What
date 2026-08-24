/**
 * Auth SoundGuess — compte site, profil, handoff.
 */

const express = require('express');
const multer = require('multer');
const authController = require('../controllers/authController');

const router = express.Router();

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('BAD_IMAGE_TYPE'), ok);
  },
});

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

router.get('/login', (req, res) => res.redirect(302, '/'));

router.post('/register', authController.registerSite);
router.post('/verify-email', authController.verifySiteEmail);
router.post('/resend-verification', authController.resendVerification);
router.post('/login-site', authController.loginSite);
router.post('/verify-login-2fa', authController.verifyLogin2fa);
router.post('/resend-login-2fa', authController.resendLogin2fa);
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
    authController.uploadProfileAvatar(req, res).catch((e) => {
      console.error('[Auth] avatar async:', e.message || e);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erreur serveur lors de l’envoi de la photo.' });
      }
    });
  });
});

router.get('/logout', authController.logout);
router.post('/logout', authController.logout);
router.get('/me', authController.me);
router.get('/profile', authController.myProfile);
router.post('/profile/bio', authController.updateMyBio);

module.exports = router;

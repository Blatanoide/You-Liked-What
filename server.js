/**
 * Serveur principal — Express + session + Socket.io
 * « You Liked What? » — jeu multijoueur avec likes Instagram simulés.
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const authController = require('./controllers/authController');
const instagramOAuth = require('./services/instagramOAuthService');
const { attachGameSocket } = require('./sockets/gameSocket');
const { hydrateLikesMiddleware } = require('./middleware/hydrateLikes');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

/** URL publique (ex. https://abc.ngrok-free.app) — à aligner avec l’URL utilisée dans le navigateur */
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  process.env.APP_PUBLIC_URL ||
  ''
).replace(/\/$/, '');

/**
 * Cookie Secure : ne pas l’activer automatiquement dès que PUBLIC_BASE_URL est en https,
 * sinon une session ouverte en http://localhost ne reçoit pas le cookie (même bug « API 401 / pas connecté »).
 * Mets SESSION_COOKIE_SECURE=true quand tu n’utilises que l’URL HTTPS (ex. ngrok).
 */
const useSecureCookies =
  process.env.SESSION_COOKIE_SECURE === 'true' ||
  process.env.FORCE_SECURE_COOKIE === 'true' ||
  process.env.NODE_ENV === 'production';

const app = express();

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: false,
    credentials: true,
  },
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'ylw.sid',
  cookie: {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: useSecureCookies,
  },
});

app.use(cookieParser());
app.use(express.json());
app.use(sessionMiddleware);

app.use((req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/api')) {
    return hydrateLikesMiddleware(req, res, next);
  }
  next();
});

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

function noStoreApi(req, res, next) {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
  }
  next();
}
app.use(noStoreApi);

/**
 * Une seule route « bootstrap » : évite un 404 /api/config mis en cache par ngrok / proxy
 * alors que /api/health répond 200 (cas que tu voyais dans la console ngrok).
 */
function sendApiBootstrap(req, res) {
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  const listenPort = Number(PORT) || 3000;
  res.json({
    ok: true,
    v: 3,
    name: 'You Liked What?',
    cwd: __dirname,
    port: listenPort,
    listenPort,
    /** État session : plus besoin de /api/session ni /auth/me au chargement (souvent 404/401 via ngrok). */
    session: authController.sessionPayload(req),
    publicBaseUrl: PUBLIC_BASE_URL || null,
    demoLoginEnabled: process.env.DEV_FAKE_AUTH === 'true',
    instagramOAuthEnabled: instagramOAuth.isConfigured(),
    trustProxy: process.env.TRUST_PROXY === 'true',
    usePuppeteerProfile: process.env.USE_PUPPETEER_PROFILE === 'true',
    allowPasswordScrape: process.env.ALLOW_INSTAGRAM_PASSWORD_SCRAPE === 'true',
    importLikesPath: '/import-likes.html',
    sessionCookieSecure: useSecureCookies,
    forwardedProto: proto,
    host: req.get('host'),
  });
}

app.get('/api/health', sendApiBootstrap);
app.get('/api/config', sendApiBootstrap);
app.get('/api/meta', sendApiBootstrap);

app.use('/auth', authRoutes);

app.use(
  express.static(path.join(__dirname, '..', 'frontend', 'public'), {
    setHeaders(res, filePath) {
      if (/\.(js|html|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
      }
    },
  })
);

attachGameSocket(io, sessionMiddleware);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  You Liked What? — serveur démarré');
  console.log(`  Dossier ${__dirname}`);
  console.log(`  Écoute  http://127.0.0.1:${PORT}  (toutes interfaces : ngrok → ce port)`);
  if (PUBLIC_BASE_URL) {
    console.log(`  Public  ${PUBLIC_BASE_URL}  (même URL dans le navigateur)`);
  }
  if (instagramOAuth.isConfigured()) {
    const base = PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
    console.log(`  Instagram OAuth  actif — redirect Meta : ${base}/auth/instagram/callback`);
  } else {
    console.log('  Instagram OAuth  inactif (INSTAGRAM_APP_ID + INSTAGRAM_APP_SECRET dans .env pour un vrai compte)');
  }
  if (useSecureCookies) {
    console.log('  Cookies session : Secure=true (SESSION_COOKIE_SECURE ou production)');
  } else {
    console.log('  Cookies session : Secure=false (ok localhost + ngrok dev)');
  }
  console.log('═══════════════════════════════════════════');
  console.log('');
});

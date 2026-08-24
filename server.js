/**
 * Serveur principal — Express + session + Socket.io
 * SoundGuess — blind test musical multijoueur.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { Server } = require('socket.io');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const tracksRoutes = require('./routes/tracks');
const authController = require('./controllers/authController');
const emailService = require('./services/emailService');
const { attachGameSocket } = require('./sockets/gameSocket');
const { APP_NAME } = require('./config/constants');
const SessionSqliteStore = require('./services/sessionSqliteStore');
const handoffStore = require('./services/handoffStore');
const handoffProofSvc = require('./services/handoffProof');
const avatarStorage = require('./services/avatarStorage');
const { getSqliteDatabasePath } = require('./config/sqlitePath');
const { tursoCreds, getTursoReplicaFilePath, syncTursoReplica } = require('./services/openDatabase');

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

/**
 * Front (ex. Vercel) et API (ex. Render) = sites différents : sans SameSite=None,
 * le navigateur n’envoie pas le cookie de session sur fetch() → « pas connecté » sur /import-likes.
 * SESSION_COOKIE_SAMESITE=lax pour tout servir sur le même domaine (localhost, un seul hôte).
 */
const sessionSameSiteRaw = (process.env.SESSION_COOKIE_SAMESITE || '').toLowerCase();
let sessionSameSite = 'lax';
if (sessionSameSiteRaw === 'none' || sessionSameSiteRaw === 'lax' || sessionSameSiteRaw === 'strict') {
  sessionSameSite = sessionSameSiteRaw;
} else if (
  process.env.NODE_ENV === 'production' ||
  process.env.RENDER === 'true' ||
  process.env.RAILWAY_ENVIRONMENT === 'production'
) {
  sessionSameSite = 'none';
}
const sessionCookieSecure = sessionSameSite === 'none' ? true : useSecureCookies;

/** Même connexion SQLite que likesStore (fichier local ou réplique Turso). */
const sessionStore = new SessionSqliteStore();
sessionStore.prune(() => {});
handoffStore.prune();

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://you-liked-what-frontend.vercel.app';

/** Plusieurs origines séparées par des virgules (ex. Vercel prod + preview). */
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || FRONTEND_URL)
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

for (const raw of [
  PUBLIC_BASE_URL,
  process.env.RENDER_EXTERNAL_URL,
  process.env.RENDER_SERVICE_URL,
]) {
  const o = String(raw || '')
    .trim()
    .replace(/\/$/, '');
  if (o.startsWith('http') && !CORS_ALLOWED_ORIGINS.includes(o)) {
    CORS_ALLOWED_ORIGINS.push(o);
  }
}

/**
 * Suffixes de hostname (ex. blatanoide.vercel.app), séparés par des virgules.
 * Utile pour les URLs de preview Vercel qui changent à chaque déploiement sans tout lister dans CORS_ORIGINS.
 */
const CORS_ORIGIN_SUFFIXES = (process.env.CORS_ORIGIN_SUFFIXES || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, '').toLowerCase())
  .filter(Boolean);

function isCorsOriginAllowed(origin) {
  const normalized = String(origin || '')
    .trim()
    .replace(/\/$/, '');
  if (!normalized) return false;
  if (CORS_ALLOWED_ORIGINS.includes(normalized)) return true;
  if (!CORS_ORIGIN_SUFFIXES.length) return false;
  let host;
  try {
    host = new URL(normalized).hostname.toLowerCase();
  } catch {
    return false;
  }
  return CORS_ORIGIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function corsDynamicOrigin(origin, callback) {
  if (!origin) {
    callback(null, true);
    return;
  }
  if (isCorsOriginAllowed(origin)) {
    callback(null, true);
    return;
  }
  console.warn(
    '[CORS] Origine refusée :',
    origin,
    '— CORS_ORIGINS, FRONTEND_URL ou CORS_ORIGIN_SUFFIXES (ex. blatanoide.vercel.app).'
  );
  callback(null, false);
}

app.use(
  cors({
    origin: corsDynamicOrigin,
    credentials: true,
  })
);

if (process.env.TRUST_PROXY === 'true' || process.env.RENDER === 'true') {
  app.set('trust proxy', 1);
}
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: corsDynamicOrigin,
    credentials: true,
  },
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  name: 'ylw.sid',
  cookie: {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: sessionSameSite,
    secure: sessionCookieSecure,
  },
});

app.use(cookieParser());
app.use(express.json());
app.use(sessionMiddleware);

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
    v: 4,
    name: APP_NAME,
    cwd: __dirname,
    port: listenPort,
    listenPort,
    session: authController.sessionPayload(req),
    handoffProof:
      req.session?.user?.id
        ? handoffProofSvc.issueProofForHandoff(req.session.user, req.session.loginMethod)
        : null,
    publicBaseUrl: PUBLIC_BASE_URL || null,
    emailVerificationConfigured: emailService.isConfigured(),
    emailSmtp: emailService.getEmailStatus(),
    avatarStorageConfigured: avatarStorage.isCloudinaryEnabled(),
    avatarCloudinary: avatarStorage.getCloudinaryStatus(),
    sessionCookieSecure: useSecureCookies,
    forwardedProto: proto,
    host: req.get('host'),
  });
}

app.get('/api/health', sendApiBootstrap);
app.get('/api/config', sendApiBootstrap);
app.get('/api/meta', sendApiBootstrap);

app.use('/auth', authRoutes);
app.use('/api/tracks', tracksRoutes);

const uploadsRoot = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });
app.use(
  '/uploads',
  express.static(uploadsRoot, {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  })
);

function staticNoCacheHeaders(res, filePath) {
  if (/\.(js|html|css)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
}

const repoFrontendDir = path.join(__dirname, '..', 'frontend');
const bundledPublicDir = path.join(__dirname, 'public');
/** Monorepo local : tout le front. Render (repo backend seul) : seulement `backend/public/`. */
if (fs.existsSync(repoFrontendDir)) {
  app.use(express.static(repoFrontendDir, { setHeaders: staticNoCacheHeaders }));
}
if (fs.existsSync(bundledPublicDir)) {
  app.use(express.static(bundledPublicDir, { setHeaders: staticNoCacheHeaders }));
}

/** Accueil du jeu sur Vercel si ce serveur ne contient pas index.html. */
app.get('/', (req, res, next) => {
  const fe = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  if (!fe) return next();
  res.redirect(302, `${fe}/`);
});

attachGameSocket(io, sessionMiddleware);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  SoundGuess — serveur démarré');
  console.log(`  Dossier ${__dirname}`);
  console.log(`  Écoute  http://127.0.0.1:${PORT}  (toutes interfaces : ngrok → ce port)`);
  if (PUBLIC_BASE_URL) {
    console.log(`  Public  ${PUBLIC_BASE_URL}  (même URL dans le navigateur)`);
  }
  console.log(
    `  Cookie session : SameSite=${sessionSameSite}, Secure=${sessionCookieSecure}` +
      (sessionSameSite === 'none' ? ' (cross-origin front + API, ex. Vercel + Render)' : '')
  );
  if (tursoCreds().enabled) {
    console.log(`  SQLite (Turso)  réplique locale ${getTursoReplicaFilePath()} — sync cloud gratuit`);
    console.log('  Persistance comptes/sessions : oui (Turso, sans disque Render).');
  } else {
    const sqlitePath = getSqliteDatabasePath();
    console.log(`  SQLite     ${sqlitePath}`);
    const persistEnv = (process.env.SQLITE_PATH || '').trim() || (process.env.DATA_DIR || '').trim();
    if (persistEnv) {
      console.log('  Persistance comptes : oui (SQLITE_PATH ou DATA_DIR défini — disque monté en prod).');
    } else if (process.env.RENDER === 'true') {
      console.log(
        '  Persistance : fragile sur Render sans disque — gratuit : Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) ou disque + SQLITE_PATH'
      );
    }
  }
  if (tursoCreds().enabled) {
    const likesStore = require('./services/likesStore');
    setInterval(() => {
      try {
        syncTursoReplica(likesStore.getDb());
      } catch (e) {
        console.warn('[DB] Turso sync périodique :', e.message || e);
      }
    }, 20_000);
  }
  if (avatarStorage.isCloudinaryEnabled()) {
    console.log('  Avatars     Cloudinary (stockage durable)');
    avatarStorage.verifyCloudinaryPing().then((v) => {
      if (v.ok) {
        console.log('  Cloudinary  ping OK');
      } else {
        console.error('  Cloudinary  ping ÉCHEC —', v.error);
        console.error(
          '              → Sur Render, utilise CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET'
        );
      }
    });
  } else {
    console.log('  Avatars     disque local uploads/ — définir CLOUDINARY_URL sur Render pour persister');
  }
  if (emailService.isConfigured()) {
    console.log('  E-mail      SMTP configuré');
    emailService.verifySmtp().then((v) => {
      if (v.ok) console.log('  SMTP        connexion OK');
      else console.error('  SMTP        ÉCHEC —', v.error);
    });
  } else {
    console.log('  E-mail      SMTP_USER + SMTP_PASS requis pour envoyer les codes');
  }
  console.log('═══════════════════════════════════════════');
  console.log('');
});

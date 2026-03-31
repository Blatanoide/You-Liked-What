/**
 * Puppeteer — logique héritée de la V1 (you-liked-what) adaptée au backend actuel.
 * - Options de lancement adaptées serveur / Docker / ngrok (pas de lien direct avec ngrok : le scrape sort vers Instagram).
 * - Scrape profil public (HTML) quand axios reçoit un mur de login.
 * - Scrape « likes » avec identifiants : désactivé par défaut (ALLOW_INSTAGRAM_PASSWORD_SCRAPE).
 */

const puppeteer = require('puppeteer');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LOGIN_URLS = [
  'https://www.instagram.com/accounts/login/?source=auth_switcher',
  'https://www.instagram.com/accounts/login/?hl=fr',
  'https://www.instagram.com/accounts/login/',
];

const NAV_TIMEOUT = Number(process.env.PUPPETEER_NAV_TIMEOUT_MS) || 60000;
const LOGIN_FORM_WAIT_MS = Number(process.env.PUPPETEER_LOGIN_FORM_WAIT_MS) || 45000;
const LOGIN_POST_GOTO_MS = Number(process.env.PUPPETEER_LOGIN_POST_GOTO_MS) || 2000;
const POST_COOKIE_DELAY_MS = Number(process.env.PUPPETEER_POST_COOKIE_MS) || 2500;
const LOGIN_NAV_WAIT_MS = Number(process.env.PUPPETEER_LOGIN_NAV_WAIT_MS) || 28000;
/** Budget max pour scroll + extraction sur la page des likes (plafond 40 s). */
const LIKES_COLLECT_BUDGET_MS = Math.min(
  40000,
  Math.max(5000, Number(process.env.PUPPETEER_LIKES_COLLECT_MS) || 40000)
);
/** Ne garder que les likes dont la date affichée est après ce délai (2 ans). Si pas de <time>, le lien est gardé. */
const LIKES_MAX_AGE_MS = Number(process.env.PUPPETEER_LIKES_MAX_AGE_MS) || 2 * 365.25 * 24 * 60 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInstagramPostUrl(href) {
  if (!href || typeof href !== 'string') return null;
  try {
    const u = new URL(href, 'https://www.instagram.com');
    const m = u.pathname.match(/\/(p|reel|reels|tv)\/([^/]+)/i);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
    return `https://www.instagram.com/${kind}/${m[2]}/`;
  } catch (_) {
    return null;
  }
}

/**
 * Instagram charge souvent les likes via GraphQL / JSON : pas de <a> dans le DOM.
 */
function extractInstaPermalinksFromText(text, sink) {
  if (!text || typeof text !== 'string') return;
  const patterns = [
    /https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/gi,
    /https?:\\\/\\\/(?:www\.)?instagram\.com\\\/(p|reel|reels|tv)\\\/([A-Za-z0-9_-]+)/gi,
    /instagram\.com\\\/(p|reel|reels|tv)\\\/([A-Za-z0-9_-]+)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
      sink.add(`https://www.instagram.com/${kind}/${m[2]}/`);
    }
  }
}

/**
 * Écoute les réponses instagram.com (graphql, json) et extrait permaliens.
 * @returns {() => void} pour retirer l’écouteur
 */
function attachInstagramNetworkSniffer(page, sink) {
  const handler = async (response) => {
    try {
      const u = response.url();
      if (!/instagram\.com/i.test(u)) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const looksApi =
        ct.includes('json') ||
        ct.includes('javascript') ||
        /graphql|query|ajax|bloks|\/api\/|i\.instagram\.com/i.test(u);
      if (!looksApi) return;
      const text = await response.text();
      if (!text || text.length > 12_000_000) return;
      extractInstaPermalinksFromText(text, sink);
    } catch (_) {
      /* body déjà lu ou binaire */
    }
  };
  page.on('response', handler);
  return () => page.off('response', handler);
}

/**
 * Scroll + extraction sous budget temps ; shadow roots ; filtre ~2 ans via time[datetime] si présent.
 * @param {Set<string>} [urlSink] — ensemble partagé (ex. alimenté aussi par le sniffer réseau)
 * Plafond 100 URLs (aligné session jeu).
 */
async function collectLikedPostsWithBudget(page, trace, pushTrace, urlSink) {
  const deadline = Date.now() + LIKES_COLLECT_BUDGET_MS;
  const cutoffMs = Date.now() - LIKES_MAX_AGE_MS;
  const urls = urlSink || new Set();
  let stagnant = 0;
  let lastSize = 0;
  let passes = 0;

  await delay(600);

  try {
    await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"], [role="link"][href*="/p/"], [role="link"][href*="/reel/"]', {
      timeout: 10000,
    });
    pushTrace('grille likes : premier lien visible');
  } catch (_) {
    pushTrace('pas de sélecteur immédiat — collecte quand même');
  }

  while (Date.now() < deadline) {
    passes += 1;

    for (const frame of page.frames()) {
      try {
        const batch = await frame.evaluate((cMs) => {
          const seen = new Set();
          const out = [];

          function considerHref(rawHref, anchorEl) {
            let href = (rawHref || '').trim();
            if (!href) return;
            if (href.startsWith('/')) href = `${location.origin}${href}`;
            href = href.split('#')[0].split('?')[0];
            if (!/\/(p|reel|reels|tv)\//i.test(href)) return;

            let okTime = true;
            let el = anchorEl;
            for (let d = 0; d < 14 && el; d += 1) {
              const tim = el.querySelector && el.querySelector('time[datetime]');
              if (tim && tim.getAttribute('datetime')) {
                const t = new Date(tim.getAttribute('datetime')).getTime();
                if (!Number.isNaN(t) && t < cMs) okTime = false;
                break;
              }
              el = el.parentElement;
            }

            if (okTime && !seen.has(href)) {
              seen.add(href);
              out.push(href);
            }
          }

          function pullFromRoot(root) {
            if (!root) return;
            try {
              root.querySelectorAll('a[href]').forEach((a) => considerHref(a.getAttribute('href'), a));
              root.querySelectorAll('[role="link"][href]').forEach((el) =>
                considerHref(el.getAttribute('href'), el)
              );
            } catch (_) {
              /* ignore */
            }
            try {
              root.querySelectorAll('*').forEach((el) => {
                if (el.shadowRoot) pullFromRoot(el.shadowRoot);
              });
            } catch (_) {
              /* ignore */
            }
          }

          if (document.body) pullFromRoot(document.body);
          return out;
        }, cutoffMs);

        for (const h of batch) {
          const n = normalizeInstagramPostUrl(h);
          if (n) urls.add(n);
          if (urls.size >= 100) break;
        }
      } catch (_) {
        /* frame fermée / cross-origin */
      }
    }

    if (passes % 2 === 1) {
      try {
        const html = await page.content();
        extractInstaPermalinksFromText(html, urls);
      } catch (_) {
        /* ignore */
      }
    }

    if (urls.size === lastSize) stagnant += 1;
    else stagnant = 0;
    lastSize = urls.size;

    const secsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    pushTrace(`likes collect: ${urls.size} uniques (passe ${passes}, ~${secsLeft}s restantes)`);

    if (urls.size >= 100) break;
    if (urls.size > 0 && stagnant >= 5) {
      pushTrace('stagnation (plus de nouveaux liens)');
      break;
    }

    const scrollMeta = await page.evaluate(() => {
      const docHBefore = Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0
      );
      const candidates = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...document.querySelectorAll('main, [role="main"], section, div'),
      ];
      let best = null;
      let bestExtra = 0;
      candidates.forEach((el) => {
        if (!el || !el.scrollHeight) return;
        const extra = el.scrollHeight - el.clientHeight;
        if (extra > bestExtra) {
          bestExtra = extra;
          best = el;
        }
      });
      const target = best && bestExtra > 80 ? best : document.scrollingElement || document.documentElement;
      const prevTop = target.scrollTop;
      target.scrollTop = target.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      return {
        docHBefore,
        targetPrevTop: prevTop,
        targetNewTop: target.scrollTop,
      };
    });
    await delay(420);
    const docHAfter = await page.evaluate(() =>
      Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)
    );

    if (urls.size === 0 && passes >= 10 && scrollMeta.docHBefore > 0 && docHAfter <= scrollMeta.docHBefore + 100) {
      await page.keyboard.press('PageDown').catch(() => {});
      await delay(300);
    }

    if (urls.size === 0 && passes >= 14 && docHAfter <= scrollMeta.docHBefore + 100) {
      pushTrace('arrêt: aucun lien (DOM + réseau) et scroll stable');
      break;
    }
    if (urls.size > 0 && stagnant >= 3 && scrollMeta.targetNewTop <= scrollMeta.targetPrevTop + 5) break;
  }

  const normalized = [...urls]
    .map((h) => normalizeInstagramPostUrl(h))
    .filter(Boolean);
  const deduped = [...new Set(normalized)].slice(0, 100);
  trace.push(`likes: ${deduped.length} URLs (budget ${LIKES_COLLECT_BUDGET_MS}ms, max 2 ans si dates visibles)`);
  return deduped;
}

/**
 * Instagram (SPA) : souvent pas de networkidle fiable — on attend le DOM + hydration.
 */
async function dismissCookieBanners(page) {
  await delay(400);
  return page.evaluate(() => {
    const patterns = [
      /accept\s+all/i,
      /allow\s+all/i,
      /tout\s+accepter/i,
      /autoriser\s+tous/i,
      /only\s+allow\s+essential/i,
    ];
    const nodes = [...document.querySelectorAll('button, [role="button"], a')];
    for (const el of nodes) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 80) continue;
      if (!patterns.some((re) => re.test(t))) continue;
      const section = el.closest('section, [role="dialog"], div[role="presentation"]');
      const ctx = (section?.innerText || document.body?.innerText || '').toLowerCase();
      if (!/cookie|consent|données|donnee|privacy|confidentialité/i.test(ctx)) continue;
      el.click();
      return t.slice(0, 40);
    }
    return null;
  });
}

/**
 * Détecte / marque les champs login : shadow DOM + libellés FR + repli « input avant password ».
 * @param {boolean} mark - si true, pose data-ylw-* sur les inputs trouvés
 */
async function resolveInstagramLoginInFrame(frame, mark) {
  return frame.evaluate((doMark) => {
    function walkInputs(node, acc) {
      if (!node) return;
      if (node.nodeName === 'INPUT') {
        const t = (node.type || 'text').toLowerCase();
        if (t !== 'hidden' && t !== 'submit' && t !== 'button' && t !== 'reset') acc.push(node);
      }
      if (node.shadowRoot) walkInputs(node.shadowRoot, acc);
      const ch = node.children;
      if (ch) {
        for (let i = 0; i < ch.length; i += 1) walkInputs(ch[i], acc);
      }
    }
    const inputs = [];
    if (document.body) walkInputs(document.body, inputs);

    const pass = inputs.find(
      (i) =>
        i.type === 'password' ||
        (i.name || '').toLowerCase() === 'password' ||
        /current-password/i.test(i.getAttribute('autocomplete') || '')
    );
    if (!pass) return false;

    const fr =
      /phone|username|email|téléphone|mobile|identifiant|profil|numéro|adresse|e-mail|courriel|nom\s+de\s+profil|numéro\s+de\s+mobile|adresse\s+e-mail/i;

    let user =
      inputs.find((i) => i !== pass && ((i.name || '').toLowerCase() === 'username' || (i.getAttribute('autocomplete') || '') === 'username')) ||
      inputs.find(
        (i) =>
          i !== pass &&
          i.type !== 'password' &&
          (fr.test(i.getAttribute('aria-label') || '') || fr.test(i.getAttribute('placeholder') || ''))
      );

    if (!user) {
      const pi = inputs.indexOf(pass);
      for (let j = pi - 1; j >= 0; j -= 1) {
        const el = inputs[j];
        const typ = (el.type || 'text').toLowerCase();
        if (typ !== 'password' && (typ === 'text' || typ === 'email' || typ === 'tel' || typ === '')) {
          user = el;
          break;
        }
      }
    }

    if (!user || !pass) return false;
    if (doMark) {
      user.setAttribute('data-ylw-user', '1');
      pass.setAttribute('data-ylw-pass', '1');
    }
    return true;
  }, mark);
}

/**
 * Détecte le formulaire login dans le document principal ou dans une iframe same-origin.
 */
async function hasLoginFormAnywhere(page) {
  for (const frame of page.frames()) {
    try {
      const ok = await resolveInstagramLoginInFrame(frame, false);
      if (ok) return true;
    } catch (_) {
      /* cross-origin iframe ou page fermée */
    }
  }
  return false;
}

/**
 * Repère les champs login — parcourt toutes les frames accessibles.
 * @returns {Promise<{ ok: true, frame: import('puppeteer').Frame } | { ok: false, title: string, href: string, snippet: string }>}
 */
async function markLoginInputsForTyping(page) {
  for (const frame of page.frames()) {
    try {
      const ok = await resolveInstagramLoginInFrame(frame, true);
      if (ok) return { ok: true, frame };
    } catch (_) {
      /* ignore */
    }
  }
  return page.evaluate(() => ({
    ok: false,
    title: document.title || '',
    href: location.href || '',
    snippet: (document.body?.innerText || '').slice(0, 400),
  }));
}

/**
 * Instagram redirige souvent vers le fil (/) sans champs login — on repart sur /accounts/login/
 * et on alterne les query params (source=auth_switcher, hl=…).
 */
async function waitForLoginFormReady(page, trace, pushTrace) {
  const deadline = Date.now() + LOGIN_FORM_WAIT_MS;
  let gotoRound = 0;

  const looksLikeFeedWithoutLogin = async () => {
    return page.evaluate(() => {
      const path = location.pathname || '';
      const pwd = document.querySelectorAll('input[type="password"]').length;
      const body = (document.body?.innerText || '').slice(0, 900);
      if (pwd > 0) return false;
      if (path === '/explore/' || path.startsWith('/reels')) return true;
      if (path === '/') {
        return /pour vous|following|accueil|home|your story|votre story|stories/i.test(body);
      }
      return false;
    });
  };

  while (Date.now() < deadline) {
    if (await hasLoginFormAnywhere(page)) {
      trace.push(`login form detected (poll, ${LOGIN_FORM_WAIT_MS}ms budget)`);
      return;
    }

    if (await looksLikeFeedWithoutLogin()) {
      const u = page.url();
      pushTrace(`feed/home sans formulaire détecté → nouvelle navigation login (était ${u})`);
      const url = LOGIN_URLS[gotoRound % LOGIN_URLS.length];
      gotoRound += 1;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      pushTrace(`goto ${url}`);
      await delay(LOGIN_POST_GOTO_MS);
      if (process.env.PUPPETEER_SKIP_COOKIE_DISMISS !== 'true') {
        const ch = await dismissCookieBanners(page);
        if (ch) {
          pushTrace(`cookie banner: ${ch}`);
          await delay(POST_COOKIE_DELAY_MS);
        }
      }
    }

    await delay(450);
  }

  throw new Error(`login form wait exceeded (${LOGIN_FORM_WAIT_MS}ms)`);
}

/**
 * Même esprit que la V1 : --no-sandbox pour environnements restreints, CHROMIUM_PATH optionnel.
 */
function getLaunchOptions() {
  const opts = {
    // Connexion "invisible" forcée : ne pas ouvrir de fenêtre navigateur locale.
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  };
  const chromium = (process.env.CHROMIUM_PATH || '').trim();
  if (chromium) {
    opts.executablePath = chromium;
  }
  return opts;
}

/**
 * Charge la page profil public comme un navigateur réel (contourne souvent le mur axios).
 * @param {string} username - pseudo normalisé
 * @returns {Promise<string>} HTML brut
 */
async function fetchPublicProfileHtml(username) {
  const browser = await puppeteer.launch(getLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });
    await delay(Number(process.env.PUPPETEER_PROFILE_WAIT_MS) || 3000);
    return await page.content();
  } finally {
    await browser.close();
  }
}

/**
 * Instagram Web : la liste des likes est sur /your_activity/interactions/likes/
 * (pas /accounts/activity/ qui mène souvent aux notifications).
 */
async function navigateToLikesActivity(page, trace, pushTrace) {
  const override = (process.env.PUPPETEER_LIKES_ACTIVITY_URL || '').trim();
  if (override) {
    try {
      await page.goto(override, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await delay(2500);
      pushTrace(`PUPPETEER_LIKES_ACTIVITY_URL → ${override}`);
      trace.push('likes: URL .env');
      return;
    } catch (e) {
      pushTrace(`PUPPETEER_LIKES_ACTIVITY_URL échoué: ${(e && e.message) || e}`);
    }
  }

  /** URL officielle « posts que vous aimez » (web) — voir https://www.instagram.com/your_activity/interactions/likes/ */
  const priorityUrls = [
    'https://www.instagram.com/your_activity/interactions/likes/',
    'https://www.instagram.com/accounts/activity/like_interactions/',
    'https://www.instagram.com/accounts/activity/likes/',
    'https://www.instagram.com/accounts/activity/interactions/likes/',
  ];

  for (const url of priorityUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await delay(2500);
      pushTrace(`ouvert ${url}`);
      trace.push('likes: URL prioritaire');
      return;
    } catch (e) {
      pushTrace(`goto ${url} échoué: ${(e && e.message) || e}`);
    }
  }

  await page.goto('https://www.instagram.com/accounts/activity/', {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
  });
  await delay(2800);
  pushTrace('activity de base — éviter onglet notifications, chercher Interactions / Likes');

  const step1 = await page.evaluate(() => {
    const direct = document.querySelector(
      'a[href*="your_activity/interactions/likes"], a[href*="like_interaction"], a[href*="likes_interaction"], a[href*="interactions/likes"]'
    );
    if (direct) {
      direct.click();
      return 'href-like-interaction';
    }
    const nodes = [...document.querySelectorAll('a[href], button, div[role="button"], span[role="link"]')];
    for (const el of nodes) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const href = (el.getAttribute('href') || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const blob = `${t} ${href} ${aria}`;
      if (/notification|notif/i.test(blob)) continue;
      if (
        /^interactions?$/i.test(t) ||
        /^interactions$/i.test(aria) ||
        (/\/interaction/i.test(href) && !/notif/i.test(href))
      ) {
        el.click();
        return `interactions:${t.slice(0, 28)}`;
      }
    }
    return null;
  });
  if (step1) pushTrace(`clic: ${step1}`);
  await delay(2200);

  const step2 = await page.evaluate(() => {
    const direct = document.querySelector(
      'a[href*="your_activity/interactions/likes"], a[href*="like_interaction"], a[href*="likes_interaction"], a[href*="likes"]'
    );
    if (direct && !/notif/i.test(direct.getAttribute('href') || '')) {
      direct.click();
      return 'href-likes';
    }
    const nodes = [...document.querySelectorAll('a[href], button, div[role="button"], [role="tab"]')];
    for (const el of nodes) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (/notification|notif/i.test(`${t} ${aria}`)) continue;
      if (
        /^likes?$/i.test(t) ||
        /^j'aime$/i.test(t) ||
        /^posts?\s+que\s+vous\s+aimez/i.test(t) ||
        (/\blike\b/i.test(aria) && !/notification/i.test(aria))
      ) {
        el.click();
        return `likes:${t.slice(0, 36)}`;
      }
    }
    return null;
  });
  if (step2) pushTrace(`clic: ${step2}`);
  await delay(2200);

  await page.evaluate(() => {
    const prefer = [...document.querySelectorAll('a[href*="/accounts/activity"], a[href*="your_activity"]')].find(
      (a) => /like|interaction/i.test(a.getAttribute('href') || '')
    );
    if (prefer) {
      prefer.click();
      return;
    }
    const more = [...document.querySelectorAll('a, button, div[role="button"]')].find((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return /^(plus|more)$/i.test(t);
    });
    more?.click();
  });
  await delay(1500);
  trace.push('navigation likes (UI) fin');
}

async function dismissOptionalDialogs(page) {
  try {
    await delay(800);
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, div[role="button"]')];
      const hit = buttons.find((el) => {
        const t = (el.textContent || '').trim();
        return /^(not now|plus tard|plus tard|ok)$/i.test(t);
      });
      if (hit) hit.click();
    });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Connexion Instagram + optionnellement collecte des likes sur la page activité.
 * @param {{ username: string, password: string, collectLikes?: boolean }} opts — collectLikes false = vérifier la connexion seulement (plus rapide, pas d’erreur si la grille likes est vide).
 * @returns {Promise<{ success: boolean, posts?: string[], error?: string, loginOnly?: boolean }>}
 */
async function scrapeLikesWithCredentials({ username, password, collectLikes = true }) {
  if (!username || !password) {
    return {
      success: false,
      error: 'username et password requis',
      stage: 'input',
      hint: 'Renseigne pseudo + mot de passe.',
    };
  }

  let browser;
  let context;
  browser = await puppeteer.launch(getLaunchOptions());
  /** Contexte isolé = aucun cookie résiduel (sinon Instagram renvoie souvent vers le fil /). */
  context =
    typeof browser.createIncognitoBrowserContext === 'function'
      ? await browser.createIncognitoBrowserContext()
      : await browser.createBrowserContext();
  let stage = 'launch';
  const trace = [];
  const pushTrace = (msg) => {
    trace.push(msg);
    if (trace.length > 24) trace.shift();
  };
  try {
    const page = await context.newPage();
    stage = 'page:new';
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (_) {
        /* ignore */
      }
    });
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    await page.setViewport({ width: 1200, height: 800 });
    pushTrace('page initialized (contexte isolé)');

    stage = 'login:open';
    const startUrl = LOGIN_URLS[0];
    await page.goto(startUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });
    pushTrace(`login domcontentloaded url=${await page.url()}`);

    await delay(LOGIN_POST_GOTO_MS);
    pushTrace(`post-goto wait ${LOGIN_POST_GOTO_MS}ms`);

    stage = 'login:cookies';
    let cookieHit = null;
    if (process.env.PUPPETEER_SKIP_COOKIE_DISMISS === 'true') {
      pushTrace('cookie dismiss skipped (PUPPETEER_SKIP_COOKIE_DISMISS)');
    } else {
      cookieHit = await dismissCookieBanners(page);
      if (cookieHit) {
        pushTrace(`cookie banner: ${cookieHit}`);
        await delay(POST_COOKIE_DELAY_MS);
        pushTrace(`post-cookie delay ${POST_COOKIE_DELAY_MS}ms`);
      }
    }

    stage = 'login:wait-form';
    try {
      await waitForLoginFormReady(page, trace, pushTrace);
    } catch (e) {
      pushTrace(`wait-form error: ${(e && e.message) || String(e)}`);
      const snap = await markLoginInputsForTyping(page);
      return {
        success: false,
        error:
          'Formulaire de connexion Instagram introuvable (redirection fil /, iframe, hydration).',
        stage: 'login:wait-form',
        hint:
          'Le serveur repart sur /accounts/login/ si Instagram affiche le fil sans champs. Augmente PUPPETEER_LOGIN_FORM_WAIT_MS. Si ça persiste : IP/datacenter bloqué, ou ouvre HEADLESS=false pour voir captcha.',
        trace,
        pageInfo: snap && snap.ok === false ? snap : undefined,
      };
    }

    stage = 'login:fill';
    const marked = await markLoginInputsForTyping(page);
    if (!marked.ok) {
      return {
        success: false,
        error: 'Champs pseudo / mot de passe non repérés après attente.',
        stage,
        hint: 'Ouvre la fenêtre Puppeteer (HEADLESS=false) et regarde si Instagram affiche un captcha ou une page différente.',
        trace,
        pageInfo: marked,
      };
    }

    const loginFrame = marked.frame;

    const filledOk = await loginFrame.evaluate(
      (u, p) => {
        function setNative(el, val) {
          if (!el) return false;
          const proto =
            el instanceof HTMLTextAreaElement
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
          } catch (_) {
            /* anciens navigateurs */
          }
          return true;
        }
        const userEl = document.querySelector('[data-ylw-user="1"]');
        const passEl = document.querySelector('[data-ylw-pass="1"]');
        return Boolean(setNative(userEl, u) && setNative(passEl, p));
      },
      username,
      password
    );
    if (!filledOk) pushTrace('WARN remplissage natif incomplet');
    pushTrace('credentials set (React input/change)');

    await delay(500);

    stage = 'login:submit';
    const clicked = await loginFrame.evaluate(() => {
      const passEl = document.querySelector('[data-ylw-pass="1"]');
      const form = passEl && passEl.closest('form');
      const formBtn = form && form.querySelector('button[type="submit"]');
      if (formBtn) {
        formBtn.click();
        return 'form-submit';
      }
      const buttons = [...document.querySelectorAll('button, div[role="button"]')];
      const alt = buttons.find((b) => {
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
        return /^(se\s+connecter|log\s*in)$/i.test(t);
      });
      if (alt) {
        alt.click();
        return 'text-button';
      }
      if (passEl) {
        passEl.focus();
        passEl.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
        );
        return 'enter';
      }
      return null;
    });
    if (!clicked) {
      await loginFrame.click('button[type="submit"]').catch(() => null);
    }
    pushTrace(`submit via ${clicked || 'fallback-click'}`);

    /** SPA Instagram : pas toujours de navigation document — on attend que l’URL quitte /accounts/login/. */
    const navDeadline = Date.now() + LOGIN_NAV_WAIT_MS;
    let lastUrl = page.url();
    while (Date.now() < navDeadline) {
      await delay(450);
      lastUrl = page.url();
      if (!/\/accounts\/login/i.test(lastUrl)) break;
    }
    await delay(800);
    pushTrace(`post-submit url=${lastUrl}`);

    stage = 'login:verify';
    const loginState = await loginFrame.evaluate(() => {
      const u = location.href || '';
      const body = (document.body?.innerText || '').slice(0, 1400) || '';
      const bodyLower = body.toLowerCase();
      const pass =
        document.querySelector('[data-ylw-pass="1"]') ||
        document.querySelector('input[type="password"]') ||
        document.querySelector('input[autocomplete="current-password"]');
      const hasPasswordInput = Boolean(pass && pass.offsetParent !== null);
      const instagramError =
        /incorrect|incorrecte|sorry|nous n'avons pas pu|didn't change|wrong password|n’avez pas entré|avez pas entré|erreur|try again|réessayer|invalid|problem logging|vérifie|suspicious|unusual/i.test(
          bodyLower
        );
      return {
        hasPasswordInput,
        stillOnLoginPath: /\/accounts\/login/i.test(u),
        hasChallengePath: /challenge|two_factor|checkpoint|login\/help/i.test(u),
        url: u,
        bodyTextSnippet: bodyLower.slice(0, 600),
        instagramError,
      };
    });
    pushTrace(`post-login verify url=${loginState.url} stillLogin=${loginState.stillOnLoginPath}`);

    const pageUrl = page.url();
    const stillOnLoginPage = /\/accounts\/login/i.test(pageUrl);
    const urlLooksLikeChallenge = /challenge|two_factor|checkpoint|login\/help/i.test(pageUrl);

    if (urlLooksLikeChallenge || loginState.hasChallengePath) {
      return {
        success: false,
        error: 'Challenge Instagram détecté (2FA / checkpoint).',
        stage,
        hint:
          'Mets PUPPETEER_HEADLESS=false, valide le challenge dans la fenêtre Chrome puis relance la connexion.',
        checkpoint: true,
        trace,
      };
    }

    if (stillOnLoginPage) {
      const errDetail = loginState.instagramError
        ? 'Message Instagram détecté (souvent mot de passe ou compte).'
        : 'Toujours sur la page de connexion : vérifie identifiants, ou ouvre HEADLESS=false (captcha / blocage).';
      return {
        success: false,
        error: loginState.instagramError
          ? 'Instagram signale une erreur de connexion.'
          : 'Instagram refuse la connexion ou le formulaire n’a pas été accepté.',
        stage,
        hint: errDetail,
        checkpoint: false,
        trace,
        pageInfo: {
          title: 'login-verify',
          href: pageUrl,
          snippet: loginState.bodyTextSnippet,
        },
      };
    }

    pushTrace('URL a quitté /accounts/login/ — connexion probablement OK');

    stage = 'dialogs:dismiss';
    await dismissOptionalDialogs(page);
    pushTrace('optional dialogs dismissed');

    if (!collectLikes) {
      pushTrace('fin : connexion uniquement (collecte likes désactivée)');
      return { success: true, posts: [], stage: 'login:done', trace, loginOnly: true };
    }

    if (process.env.PUPPETEER_OPEN_PROFILE_BEFORE_LIKES === 'true') {
      stage = 'profile:open';
      await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
      await delay(800);
      pushTrace('profile opened (optionnel)');
    }

    stage = 'activity:open';
    const collectedUrls = new Set();
    const detachNetworkSniffer = attachInstagramNetworkSniffer(page, collectedUrls);
    let unique = [];
    try {
      await navigateToLikesActivity(page, trace, pushTrace);
      pushTrace('page likes ouverte');

      stage = 'activity:collect';
      unique = await collectLikedPostsWithBudget(page, trace, pushTrace, collectedUrls);
    } finally {
      detachNetworkSniffer();
    }
    if (unique.length === 0) {
      return {
        success: false,
        error: "Connexion OK mais aucun post n'a été extrait sur la page des likes.",
        stage,
        hint:
          'PUPPETEER_HEADLESS=false pour voir le rendu. Vérifie que la grille est chargée. Budget collecte : 40 s max (PUPPETEER_LIKES_COLLECT_MS).',
        trace,
      };
    }
    return { success: true, posts: unique, stage, trace };
  } catch (err) {
    return {
      success: false,
      error: (err && err.message) || String(err),
      stage,
      hint:
        'Si tu es sur Windows, vérifie CHROMIUM_PATH si nécessaire. Sinon mets PUPPETEER_HEADLESS=false pour voir ce qui bloque.',
      trace,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  getLaunchOptions,
  fetchPublicProfileHtml,
  scrapeLikesWithCredentials,
  NAV_TIMEOUT,
};

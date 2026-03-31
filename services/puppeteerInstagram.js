const fs = require('fs');
const path = require('path');
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
const DEBUG_DUMP_DIR = process.env.PUPPETEER_DEBUG_DIR || '/tmp';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLaunchOptions() {
  const headlessEnv = String(process.env.PUPPETEER_HEADLESS || 'true').toLowerCase();
  const chromium = (process.env.CHROMIUM_PATH || '').trim();

  const opts = {
    headless: headlessEnv === 'false' ? false : true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  };

  if (chromium) {
    opts.executablePath = chromium;
  }

  return opts;
}

function makeTrace() {
  const trace = [];
  const pushTrace = (msg) => {
    trace.push(msg);
    if (trace.length > 60) trace.shift();
  };
  return { trace, pushTrace };
}

async function saveDebugArtifacts(page, label, pushTrace) {
  try {
    const safe = label.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const htmlPath = path.join(DEBUG_DUMP_DIR, `${safe}.html`);
    const pngPath = path.join(DEBUG_DUMP_DIR, `${safe}.png`);

    const html = await page.content().catch(() => '');
    if (html) {
      fs.writeFileSync(htmlPath, html, 'utf8');
      pushTrace(`debug html saved: ${htmlPath}`);
    }

    await page.screenshot({
      path: pngPath,
      fullPage: true,
    }).catch(() => {});
    pushTrace(`debug screenshot saved: ${pngPath}`);
  } catch (err) {
    pushTrace(`debug save failed: ${(err && err.message) || String(err)}`);
  }
}

async function getPageSummary(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const bodyText = await page
    .evaluate(() => (document.body?.innerText || '').slice(0, 2000))
    .catch(() => '');
  return {
    title,
    url,
    bodyText,
  };
}

async function dismissCookieBanners(page) {
  await delay(500);
  return page.evaluate(() => {
    const patterns = [
      /accept\s+all/i,
      /allow\s+all/i,
      /tout\s+accepter/i,
      /autoriser\s+tous/i,
      /only\s+allow\s+essential/i,
      /allow essential and optional cookies/i,
    ];

    const nodes = [...document.querySelectorAll('button, [role="button"], a')];
    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 120) continue;
      if (!patterns.some((re) => re.test(text))) continue;

      const section = el.closest('section, [role="dialog"], div, form');
      const ctx = (section?.innerText || document.body?.innerText || '').toLowerCase();

      if (!/cookie|consent|privacy|confidentialité|données|donnees/i.test(ctx)) {
        continue;
      }

      el.click();
      return text;
    }

    return null;
  });
}

async function resolveInstagramLoginInFrame(frame, mark) {
  return frame.evaluate((doMark) => {
    function walk(node, inputs) {
      if (!node) return;

      if (node.nodeName === 'INPUT') {
        const type = (node.type || 'text').toLowerCase();
        if (!['hidden', 'submit', 'button', 'reset'].includes(type)) {
          inputs.push(node);
        }
      }

      if (node.shadowRoot) walk(node.shadowRoot, inputs);

      const children = node.children || [];
      for (let i = 0; i < children.length; i += 1) {
        walk(children[i], inputs);
      }
    }

    const inputs = [];
    if (document.body) walk(document.body, inputs);

    const pass = inputs.find(
      (i) =>
        i.type === 'password' ||
        (i.name || '').toLowerCase() === 'password' ||
        /current-password/i.test(i.getAttribute('autocomplete') || '')
    );

    if (!pass) return false;

    const labelHint =
      /phone|username|email|téléphone|mobile|identifiant|profil|numéro|adresse|e-mail|courriel|nom\s+de\s+profil/i;

    let user =
      inputs.find(
        (i) =>
          i !== pass &&
          ((i.name || '').toLowerCase() === 'username' ||
            (i.getAttribute('autocomplete') || '').toLowerCase() === 'username')
      ) ||
      inputs.find(
        (i) =>
          i !== pass &&
          i.type !== 'password' &&
          (labelHint.test(i.getAttribute('aria-label') || '') ||
            labelHint.test(i.getAttribute('placeholder') || ''))
      );

    if (!user) {
      const passIndex = inputs.indexOf(pass);
      for (let j = passIndex - 1; j >= 0; j -= 1) {
        const el = inputs[j];
        const type = (el.type || 'text').toLowerCase();
        if (type !== 'password' && ['text', 'email', 'tel', ''].includes(type)) {
          user = el;
          break;
        }
      }
    }

    if (!user) return false;

    if (doMark) {
      user.setAttribute('data-ylw-user', '1');
      pass.setAttribute('data-ylw-pass', '1');
    }

    return true;
  }, mark);
}

async function hasLoginFormAnywhere(page) {
  for (const frame of page.frames()) {
    try {
      const ok = await resolveInstagramLoginInFrame(frame, false);
      if (ok) return true;
    } catch (_) {
      // ignore
    }
  }
  return false;
}

async function markLoginInputsForTyping(page) {
  for (const frame of page.frames()) {
    try {
      const ok = await resolveInstagramLoginInFrame(frame, true);
      if (ok) return { ok: true, frame };
    } catch (_) {
      // ignore
    }
  }

  const pageInfo = await page
    .evaluate(() => ({
      title: document.title || '',
      href: location.href || '',
      snippet: (document.body?.innerText || '').slice(0, 500),
    }))
    .catch(() => ({
      title: '',
      href: '',
      snippet: '',
    }));

  return {
    ok: false,
    ...pageInfo,
  };
}

async function looksLikeBlockedOrErrorPage(page) {
  const info = await getPageSummary(page);
  const body = (info.bodyText || '').toLowerCase();
  const title = (info.title || '').toLowerCase();
  const url = (info.url || '').toLowerCase();

  return {
    is429:
      /429/.test(body) ||
      /http error 429/.test(body) ||
      /try again later/.test(body) ||
      /too many requests/.test(body),
    isBlocked:
      /suspicious|unusual traffic|temporarily blocked|automated/i.test(body) ||
      /captcha/i.test(body),
    isChallenge: /challenge|checkpoint|two_factor|login\/help/i.test(url),
    title: info.title,
    url: info.url,
    snippet: info.bodyText.slice(0, 700),
  };
}

async function waitForLoginFormReady(page, pushTrace) {
  const deadline = Date.now() + LOGIN_FORM_WAIT_MS;
  let gotoRound = 0;

  while (Date.now() < deadline) {
    if (await hasLoginFormAnywhere(page)) {
      pushTrace(`login form detected within ${LOGIN_FORM_WAIT_MS}ms`);
      return;
    }

    const blocked = await looksLikeBlockedOrErrorPage(page);
    if (blocked.is429 || blocked.isBlocked) {
      throw new Error(
        `instagram-blocked|url=${blocked.url}|title=${blocked.title}|snippet=${blocked.snippet}`
      );
    }

    const currentUrl = page.url();
    const path = (() => {
      try {
        return new URL(currentUrl).pathname || '';
      } catch (_) {
        return '';
      }
    })();

    const body = await page
      .evaluate(() => (document.body?.innerText || '').slice(0, 1200))
      .catch(() => '');

    const looksLikeFeedWithoutLogin =
      path === '/' &&
      !/login|mot de passe|password|username|nom d'utilisateur|nom d’utilisateur/i.test(body) &&
      /pour vous|following|home|accueil|stories|story/i.test(body);

    if (looksLikeFeedWithoutLogin) {
      const retryUrl = LOGIN_URLS[gotoRound % LOGIN_URLS.length];
      gotoRound += 1;
      pushTrace(`feed detected without login form -> retry ${retryUrl}`);
      await page.goto(retryUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
      await delay(LOGIN_POST_GOTO_MS);

      if (process.env.PUPPETEER_SKIP_COOKIE_DISMISS !== 'true') {
        const cookieHit = await dismissCookieBanners(page);
        if (cookieHit) {
          pushTrace(`cookie banner clicked: ${cookieHit}`);
          await delay(POST_COOKIE_DELAY_MS);
        }
      }
    }

    await delay(500);
  }

  throw new Error(`login form wait exceeded (${LOGIN_FORM_WAIT_MS}ms)`);
}

async function openInstagramLogin(page, pushTrace) {
  const startUrl = LOGIN_URLS[0];

  const response = await page.goto(startUrl, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
  });

  const status = response?.status?.() ?? null;
  const summary = await getPageSummary(page);

  pushTrace(`goto status=${status == null ? 'no-status' : status}`);
  pushTrace(`goto finalUrl=${summary.url}`);
  pushTrace(`goto title=${summary.title}`);
  pushTrace(`goto body=${summary.bodyText.slice(0, 700)}`);

  await saveDebugArtifacts(page, 'instagram-login-open', pushTrace);

  await delay(LOGIN_POST_GOTO_MS);
  pushTrace(`post-goto wait ${LOGIN_POST_GOTO_MS}ms`);

  if (process.env.PUPPETEER_SKIP_COOKIE_DISMISS !== 'true') {
    const cookieHit = await dismissCookieBanners(page);
    if (cookieHit) {
      pushTrace(`cookie banner clicked: ${cookieHit}`);
      await delay(POST_COOKIE_DELAY_MS);
      pushTrace(`post-cookie delay ${POST_COOKIE_DELAY_MS}ms`);
    }
  }

  return { status, summary };
}

async function setCredentialsInFrame(frame, username, password) {
  return frame.evaluate(
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
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              data: val,
              inputType: 'insertText',
            })
          );
        } catch (_) {
          // old browser
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
}

async function submitLogin(frame) {
  return frame.evaluate(() => {
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
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
      return 'enter';
    }

    return null;
  });
}

async function verifyPostLogin(page, pushTrace) {
  const navDeadline = Date.now() + LOGIN_NAV_WAIT_MS;
  let lastUrl = page.url();

  while (Date.now() < navDeadline) {
    await delay(450);
    lastUrl = page.url();
    if (!/\/accounts\/login/i.test(lastUrl)) break;
  }

  await delay(800);

  const summary = await getPageSummary(page);
  pushTrace(`post-submit url=${summary.url}`);
  pushTrace(`post-submit title=${summary.title}`);
  pushTrace(`post-submit body=${summary.bodyText.slice(0, 700)}`);

  await saveDebugArtifacts(page, 'instagram-login-post-submit', pushTrace);

  const lowerBody = summary.bodyText.toLowerCase();
  const stillOnLoginPage = /\/accounts\/login/i.test(summary.url);
  const challenge = /challenge|checkpoint|two_factor|login\/help/i.test(summary.url);
  const blocked = /429|too many requests|try again later|this page isn't working/i.test(lowerBody);
  const loginError =
    /incorrect|incorrecte|wrong password|invalid|problem logging|réessayer|try again/i.test(lowerBody);

  return {
    url: summary.url,
    title: summary.title,
    snippet: summary.bodyText.slice(0, 800),
    stillOnLoginPage,
    challenge,
    blocked,
    loginError,
  };
}

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
    await browser.close().catch(() => {});
  }
}

async function scrapeLikesWithCredentials({ username, password, collectLikes = true }) {
  if (!username || !password) {
    return {
      success: false,
      error: 'username et password requis',
      stage: 'input',
      hint: 'Renseigne pseudo + mot de passe.',
    };
  }

  let browser = null;
  let context = null;
  let stage = 'launch';
  const { trace, pushTrace } = makeTrace();

  try {
    browser = await puppeteer.launch(getLaunchOptions());
    context =
      typeof browser.createIncognitoBrowserContext === 'function'
        ? await browser.createIncognitoBrowserContext()
        : await browser.createBrowserContext();

    const page = await context.newPage();

    stage = 'page:new';
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (_) {
        // ignore
      }
    });

    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    await page.setViewport({ width: 1200, height: 800 });
    pushTrace('page initialized');

    stage = 'login:open';
    const opened = await openInstagramLogin(page, pushTrace);

    if (opened.status === 429) {
      return {
        success: false,
        error: 'Instagram a renvoyé HTTP 429.',
        stage,
        hint: 'Le serveur hébergé semble bloqué ou limité par Instagram.',
        trace,
        pageInfo: {
          title: opened.summary.title,
          href: opened.summary.url,
          snippet: opened.summary.bodyText.slice(0, 800),
        },
      };
    }

    stage = 'login:wait-form';
    try {
      await waitForLoginFormReady(page, pushTrace);
    } catch (err) {
      const summary = await getPageSummary(page);
      await saveDebugArtifacts(page, 'instagram-login-no-form', pushTrace);

      return {
        success: false,
        error: 'Formulaire de connexion Instagram introuvable.',
        stage,
        hint: 'Instagram ne sert pas le vrai formulaire ou renvoie une page d’erreur.',
        trace,
        pageInfo: {
          title: summary.title,
          href: summary.url,
          snippet: summary.bodyText.slice(0, 900),
        },
        details: (err && err.message) || String(err),
      };
    }

    stage = 'login:mark';
    const marked = await markLoginInputsForTyping(page);
    if (!marked.ok) {
      return {
        success: false,
        error: 'Champs pseudo / mot de passe introuvables.',
        stage,
        hint: 'Le formulaire n’a pas été reconnu dans le DOM.',
        trace,
        pageInfo: {
          title: marked.title,
          href: marked.href,
          snippet: marked.snippet,
        },
      };
    }

    stage = 'login:fill';
    const filledOk = await setCredentialsInFrame(marked.frame, username, password);
    pushTrace(`fill result=${filledOk ? 'ok' : 'failed'}`);

    if (!filledOk) {
      return {
        success: false,
        error: 'Impossible de remplir les champs de connexion.',
        stage,
        hint: 'Les inputs ont été trouvés mais n’ont pas pu être remplis correctement.',
        trace,
      };
    }

    await delay(500);

    stage = 'login:submit';
    const submitMethod = await submitLogin(marked.frame);
    pushTrace(`submit via ${submitMethod || 'unknown'}`);

    const post = await verifyPostLogin(page, pushTrace);

    if (post.challenge) {
      return {
        success: false,
        error: 'Challenge Instagram détecté (2FA / checkpoint).',
        stage: 'login:verify',
        hint: 'Une validation supplémentaire est demandée par Instagram.',
        trace,
        checkpoint: true,
        pageInfo: {
          title: post.title,
          href: post.url,
          snippet: post.snippet,
        },
      };
    }

    if (post.blocked) {
      return {
        success: false,
        error: 'Instagram semble bloquer ou limiter cette connexion.',
        stage: 'login:verify',
        hint: 'La page reçue ressemble à une erreur, un 429 ou un blocage.',
        trace,
        pageInfo: {
          title: post.title,
          href: post.url,
          snippet: post.snippet,
        },
      };
    }

    if (post.stillOnLoginPage) {
      return {
        success: false,
        error: post.loginError
          ? 'Instagram signale une erreur de connexion.'
          : 'Toujours sur la page de connexion après envoi du formulaire.',
        stage: 'login:verify',
        hint: post.loginError
          ? 'Vérifie le pseudo ou le mot de passe.'
          : 'Le formulaire a été soumis mais Instagram n’a pas validé la connexion.',
        trace,
        pageInfo: {
          title: post.title,
          href: post.url,
          snippet: post.snippet,
        },
      };
    }

    pushTrace('login probably successful');

    if (!collectLikes) {
      return {
        success: true,
        posts: [],
        loginOnly: true,
        stage: 'login:done',
        trace,
      };
    }

    return {
      success: false,
      error: 'Connexion OK mais collecte des likes non réimplémentée dans cette version simplifiée.',
      stage: 'likes:not-implemented',
      hint: 'Commence par valider la connexion et le diagnostic côté serveur.',
      trace,
    };
  } catch (err) {
    return {
      success: false,
      error: (err && err.message) || String(err),
      stage,
      hint: 'Erreur Puppeteer ou navigateur.',
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
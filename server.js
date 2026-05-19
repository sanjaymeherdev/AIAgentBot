const puppeteer = require('puppeteer-core');
const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || process.env.PG_CONNECTION_STRING;
const USE_POSTGRES = Boolean(DATABASE_URL);
const API_KEY = process.env.API_KEY || process.env.BOT_API_KEY || '';
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || process.env.CHROME_PATH;
const SELF_PING_URL = process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${PORT}`;
const SELF_PING_PATH = process.env.SELF_PING_PATH || '/status';
const puppeteerExtra = require('puppeteer-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(stealth());
let dbClient = null;

// ── DATABASE ──────────────────────────────────────────────

async function initDatabase() {
  if (!USE_POSTGRES) return;
  dbClient = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await dbClient.connect();

  // Prevent unhandled error crash on connection drop (Neon drops idle connections)
  dbClient.on('error', (err) => {
    log(`DB connection error: ${err.message}`, 'warn');
    dbClient = null;
    setTimeout(async () => {
      try {
        await initDatabase();
        log('DB reconnected', 'info');
      } catch (e) {
        log(`DB reconnect failed: ${e.message}`, 'error');
      }
    }, 5000);
  });

  await dbClient.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      slug text PRIMARY KEY,
      name text NOT NULL,
      url text,
      steps jsonb NOT NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      profile_name text PRIMARY KEY,
      cookies jsonb NOT NULL,
      storage jsonb NOT NULL,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS runs (
      id serial PRIMARY KEY,
      profile_slug text,
      profile_name text,
      prompt text,
      result text,
      status text,
      error text,
      duration_ms int,
      created_at timestamptz DEFAULT now()
    );
  `);
}

async function ensureProfileStore() {
  if (!dbClient && USE_POSTGRES) {
    log('DB not ready for ensureProfileStore, skipping', 'warn');
    return;
  }
  if (USE_POSTGRES) {
    try {
      const { rows } = await dbClient.query('SELECT count(*)::int AS count FROM profiles');
      if (rows[0].count === 0) await saveProfiles(getDefaultProfiles());
    } catch (e) {
      log(`ensureProfileStore failed: ${e.message}`, 'warn');
    }
  } else if (!fs.existsSync(PROFILES_FILE)) {
    await saveProfiles(getDefaultProfiles());
  }
}

async function loadProfilesFromDb() {
  if (!dbClient) throw new Error('DB not connected');
  const result = await dbClient.query('SELECT slug, name, url, steps FROM profiles ORDER BY name');
  return assignProfileSlugs(result.rows.map(row => ({
    slug: row.slug,
    name: row.name,
    url: row.url,
    steps: row.steps || []
  })));
}

async function saveProfilesToDb(profiles) {
  if (!dbClient) throw new Error('DB not connected');
  const sanitized = profiles.map(profile => ({ ...profile, slug: slugify(profile.name) }));
  await dbClient.query('BEGIN');
  try {
    for (const profile of sanitized) {
      await dbClient.query(
        `INSERT INTO profiles (slug, name, url, steps, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name, url = EXCLUDED.url, steps = EXCLUDED.steps, updated_at = now()`,
        [profile.slug, profile.name, profile.url, JSON.stringify(profile.steps)]
      );
    }
    const slugs = sanitized.map(p => p.slug);
    if (slugs.length) {
      const placeholders = slugs.map((_, i) => `$${i + 1}`).join(',');
      await dbClient.query(`DELETE FROM profiles WHERE slug NOT IN (${placeholders})`, slugs);
    } else {
      await dbClient.query('DELETE FROM profiles');
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  }
}

async function loadSessionFromDb(profileName) {
  if (!dbClient) throw new Error('DB not connected');
  const result = await dbClient.query('SELECT cookies, storage FROM sessions WHERE profile_name = $1', [profileName]);
  return result.rows[0] || null;
}

async function saveSessionToDb(profileName, cookies, storage) {
  if (!dbClient) throw new Error('DB not connected');
  await dbClient.query(
    `INSERT INTO sessions (profile_name, cookies, storage, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (profile_name) DO UPDATE SET cookies = EXCLUDED.cookies, storage = EXCLUDED.storage, updated_at = now()`,
    [profileName, JSON.stringify(cookies), JSON.stringify(storage)]
  );
}

async function recordRunHistory({ profileSlug, profileName, prompt, result, status, error, durationMs }) {
  if (!USE_POSTGRES || !dbClient) return;
  try {
    await dbClient.query(
      `INSERT INTO runs (profile_slug, profile_name, prompt, result, status, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [profileSlug, profileName, prompt, result, status, error, durationMs]
    );
  } catch (e) {
    log(`Run history save failed: ${e.message}`, 'warn');
  }
}

// ── HELPERS ───────────────────────────────────────────────

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function assignProfileSlugs(profiles) {
  const seen = new Map();
  return profiles.map(profile => {
    const base = slugify(profile.name || 'profile');
    let slug = base || 'profile';
    let suffix = 1;
    while (seen.has(slug)) {
      slug = `${base}-${suffix++}`;
    }
    seen.set(slug, true);
    return { ...profile, slug };
  });
}

async function getProfileBySlug(slug) {
  const profiles = await loadProfiles();
  return profiles.find(p => p.slug === slug || p.name === slug);
}

function getDefaultProfiles() {
  return assignProfileSlugs([
    {
      name: 'DeepSeek Send',
      url: 'https://chat.deepseek.com',
      steps: [
        { id: 1, action: 'click', x: 443, y: 558, label: 'Click textarea' },
        { id: 2, action: 'type', text: '{{prompt}}', delay: 30, label: 'Type prompt' },
        { id: 3, action: 'wait', ms: 1000, label: 'Wait' },
        { id: 4, action: 'send', text: '', delay: 30, label: 'Send message (Enter)' }
      ]
    },
    {
      name: 'Qwen Send',
      url: 'https://tongyi.aliyun.com/qianwen/',
      steps: [
        { id: 1, action: 'click', x: 640, y: 650, label: 'Click input' },
        { id: 2, action: 'type', text: '{{prompt}}', delay: 30, label: 'Type prompt' },
        { id: 3, action: 'wait', ms: 400, label: 'Pause' },
        { id: 4, action: 'send', text: '', delay: 30, label: 'Send via Enter', monitorQwen: true },
        { id: 5, action: 'wait', ms: 5000, label: 'Wait for response' },
        { id: 6, action: 'copy', selector: '[class*="message"]:last-child', label: 'Copy response', polling: true }
      ]
    }
  ]);
}

// ── SESSION ───────────────────────────────────────────────

const SESSION_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);

async function saveSession(profileName) {
  const cookies = await page.cookies();
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage))
  }));

  if (USE_POSTGRES && dbClient) {
    try {
      await saveSessionToDb(profileName, cookies, storage);
      log(`💾 Session saved to DB for ${profileName}`);
      return;
    } catch (e) {
      log(`DB session save failed: ${e.message}, falling back to file`, 'warn');
    }
  }

  fs.writeFileSync(
    path.join(SESSION_DIR, `${profileName.replace(/\s+/g, '_')}.json`),
    JSON.stringify({ cookies, storage }, null, 2)
  );
  log(`💾 Session saved for ${profileName}`);
}

async function loadSession(profileName) {
  let data = null;

  if (USE_POSTGRES && dbClient) {
    try {
      data = await loadSessionFromDb(profileName);
    } catch (e) {
      log(`DB session load failed: ${e.message}, trying file`, 'warn');
    }
  }

  if (!data) {
    const sessionFile = path.join(SESSION_DIR, `${profileName.replace(/\s+/g, '_')}.json`);
    if (!fs.existsSync(sessionFile)) return false;
    data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  }

  if (!data || !Array.isArray(data.cookies) || !data.storage) return false;
  await page.setCookie(...data.cookies);
  await page.evaluateOnNewDocument(storage => {
    Object.entries(storage.local || {}).forEach(([key, value]) => localStorage.setItem(key, value));
    Object.entries(storage.session || {}).forEach(([key, value]) => sessionStorage.setItem(key, value));
  }, data.storage);
  log(`🔓 Session loaded for ${profileName}`);
  return true;
}

// ── PROFILES ──────────────────────────────────────────────

async function loadProfiles() {
  if (USE_POSTGRES && dbClient) {
    try {
      const profiles = await loadProfilesFromDb();
      if (profiles.length) return profiles;
    } catch (e) {
      log(`DB profile load failed: ${e.message}, falling back to file`, 'warn');
    }
  }

  try {
    if (fs.existsSync(PROFILES_FILE)) {
      let raw = fs.readFileSync(PROFILES_FILE, 'utf8');
      raw = raw.replace(/"(\w+)\s*"\s*:/g, '"$1":');
      const profiles = JSON.parse(raw);
      return assignProfileSlugs(Array.isArray(profiles) ? profiles : []);
    }
  } catch (e) {
    log(`Error loading profiles from file: ${e.message}`, 'error');
  }
  return getDefaultProfiles();
}

async function saveProfiles(profiles) {
  const sanitized = profiles.map(profile => ({ ...profile, slug: slugify(profile.name) }));
  if (USE_POSTGRES && dbClient) {
    try {
      await saveProfilesToDb(sanitized);
      return;
    } catch (e) {
      log(`DB profile save failed: ${e.message}, falling back to file`, 'warn');
    }
  }
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(sanitized, null, 2));
}

// ── MIDDLEWARE ────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data:;");
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const host = req.headers.host;
    return originUrl.host === host;
  } catch (_) {
    return false;
  }
}

function getApiKeyFromRequest(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || req.query.api_key || '';
}

function requireApiKey(req, res, next) {
  if (!API_KEY || sameOrigin(req)) return next();
  const key = getApiKeyFromRequest(req);
  if (key === API_KEY) return next();
  return res.status(401).json({ error: 'API key required' });
}

app.use(express.json());
const STATIC_ROOT = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname);
app.use(express.static(STATIC_ROOT));
app.get('/', (req, res) => {
  res.sendFile(path.join(STATIC_ROOT, 'index.html'));
});

// ── STATE ─────────────────────────────────────────────────

let browser = null;
let page = null;
let isRunning = false;
let shouldStop = false;
let pingInterval = null;
let lastResponse = { text: '', timestamp: null, profileName: '', prompt: '' };
let lastCopyBotResponseEvent = null;
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
const VIEWPORT = { width: 1280, height: 720 };
const logClients = new Set();
const PING_INTERVAL = process.env.PING_INTERVAL || 5 * 60 * 1000;

// ── BROADCAST / LOG ───────────────────────────────────────

function broadcast(type, data) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of logClients) {
    try { res.write(msg); } catch (_) {}
  }
}

function log(message, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${message}`);
  broadcast('log', { message, level, time: new Date().toISOString() });
}

// ── SELF PINGER ───────────────────────────────────────────

function startSelfPinger() {
  if (pingInterval) clearInterval(pingInterval);
  let baseUrl = SELF_PING_URL.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
  const urlObj = new URL(baseUrl);
  const pingUrl = urlObj.pathname === '/' ? `${baseUrl}${SELF_PING_PATH}` : baseUrl;
  const getClient = urlObj.protocol === 'https:' ? require('https') : require('http');

  pingInterval = setInterval(async () => {
    try {
      getClient.get(pingUrl, (res) => {
        if (res.statusCode === 200) {
          log(`🔄 Self-ping successful (${new Date().toLocaleTimeString()})`);
        } else {
          log(`⚠️  Self-ping returned ${res.statusCode}`, 'warn');
        }
      }).on('error', (err) => {
        log(`⚠️  Self-ping failed: ${err.message}`, 'warn');
      });
    } catch (err) {
      log(`Self-ping error: ${err.message}`, 'error');
    }
  }, PING_INTERVAL);
  log(`✅ Self-pinger started (interval: ${PING_INTERVAL / 1000}s, url: ${pingUrl})`);
}

// ── RESPONSE HELPERS ──────────────────────────────────────

function saveLastResponse(text, profileName, prompt) {
  lastResponse = {
    text,
    timestamp: new Date().toISOString(),
    profileName,
    prompt
  };
  log(`💾 Response saved: ${profileName}`);
}

function normalizeExtractedText(text, context) {
  if (!text) return '';
  let cleaned = String(text).trim();
  if (!context || !context.prompt) return cleaned;
  const prompt = String(context.prompt).trim();
  if (!prompt) return cleaned;

  const promptIndex = cleaned.indexOf(prompt);
  if (promptIndex === 0) {
    cleaned = cleaned.slice(prompt.length).trim();
  } else if (promptIndex > 0) {
    const prefix = cleaned.slice(0, promptIndex).trim();
    if (!prefix || prefix.length < 80) {
      cleaned = cleaned.slice(promptIndex + prompt.length).trim();
    }
  }
  return cleaned;
}

// ── BROWSER ───────────────────────────────────────────────

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function getChromiumPath() {
  if (EXECUTABLE_PATH) return EXECUTABLE_PATH;
  if (process.env.RENDER) return '/usr/bin/chromium';
  try {
    const nixPath = execSync('ls -d /nix/store/*chromium-* 2>/dev/null | head -n 1').toString().trim();
    if (nixPath) return `${nixPath}/bin/chromium`;
  } catch (_) {}
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const cmd of candidates) {
    try {
      return execSync(`which ${cmd}`).toString().trim();
    } catch (_) {}
  }
  return '/usr/bin/chromium';
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  const exePath = getChromiumPath();
  log(`Launching Chromium: ${exePath}`);
  browser = await puppeteerExtra.launch({
    executablePath: exePath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-background-networking',
      '--disable-sync', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=site-per-process,TranslateUI',
      '--disable-software-rasterizer'
    ],
    defaultViewport: VIEWPORT,
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    pipe: true,
    timeout: 60000
  });
  browser.on('disconnected', () => { browser = null; page = null; log('Browser disconnected', 'warn'); });
}

async function ensurePage() {
  await ensureBrowser();
  if (page && !page.isClosed()) return page;
  const pages = await browser.pages();
  page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.setUserAgent(UA);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  installAnalyticsInterceptor(page);
  return page;
}

function installAnalyticsInterceptor(page) {
  if (!page || page.__analyticsInterceptorInstalled) return;
  page.__analyticsInterceptorInstalled = true;
  page.on('request', async request => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    if (!url.includes('gator.volces.com/list')) return;
    const postData = request.postData();
    if (!postData) return;
    try {
      const payload = JSON.parse(postData);
      const event = Array.isArray(payload) && payload[0]?.events?.[0];
      if (event?.event === 'copyBotResponse') {
        const outputText = await captureLastChatText(page);
        lastCopyBotResponseEvent = {
          event,
          payload,
          url,
          outputText,
          timestamp: new Date().toISOString()
        };
        if (outputText) {
          saveLastResponse(outputText, 'AutoCopyListener', 'copyBotResponse');
          broadcast('response', { text: outputText });
        }
        log('Detected copyBotResponse event');
      }
    } catch (err) {
      log(`Analytics interceptor parse failed: ${err.message}`, 'warn');
    }
  });
}

async function captureLastChatText(page) {
  try {
    return await page.evaluate(() => {
      const selectors = [
        '[class*="bot"]',
        '[class*="assistant"]',
        '[class*="message"]',
        '[class*="bubble"]',
        '[class*="chat"]',
        '[data-testid*="message"]',
        '[role="log"]'
      ];
      const elements = selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
      const unique = Array.from(new Set(elements));
      const candidates = unique
        .map(el => ({ text: (el.innerText || el.textContent || '').trim() }))
        .filter(item => item.text && item.text.length > 10)
        .filter(item => !/copy|clipboard|button|click|复制/i.test(item.text));
      if (!candidates.length) return '';
      return candidates[candidates.length - 1].text;
    });
  } catch (err) {
    log(`captureLastChatText failed: ${err.message}`, 'warn');
    return '';
  }
}

// ── MONITOR SCRIPTS ───────────────────────────────────────
// Works on both Render (js/ at root) and Replit (public/js/)

const DEEPSEEK_MONITOR_SCRIPT_PATH = fs.existsSync(path.join(__dirname, 'js', 'deepseek.js'))
  ? path.join(__dirname, 'js', 'deepseek.js')
  : path.join(__dirname, 'public', 'js', 'deepseek.js');

const QWEN_MONITOR_SCRIPT_PATH = fs.existsSync(path.join(__dirname, 'js', 'qwenoutput.js'))
  ? path.join(__dirname, 'js', 'qwenoutput.js')
  : path.join(__dirname, 'public', 'js', 'qwenoutput.js');

let deepseekMonitorScript = null;
let qwenMonitorScript = null;

async function loadDeepseekMonitorScript() {
  if (deepseekMonitorScript) return deepseekMonitorScript;
  deepseekMonitorScript = fs.readFileSync(DEEPSEEK_MONITOR_SCRIPT_PATH, 'utf8');
  return deepseekMonitorScript;
}

async function loadQwenMonitorScript() {
  if (qwenMonitorScript) return qwenMonitorScript;
  qwenMonitorScript = fs.readFileSync(QWEN_MONITOR_SCRIPT_PATH, 'utf8');
  return qwenMonitorScript;
}

async function runDeepSeekMonitor(options = {}) {
  const script = await loadDeepseekMonitorScript();
  return await page.evaluate(new Function('options', `${script}\nreturn waitForDeepSeekResponse(options);`), options);
}

async function runQwenMonitor(options = {}) {
  const script = await loadQwenMonitorScript();
  return await page.evaluate(new Function('options', `${script}\nreturn waitForQwenResponse(options);`), options);
}

// ── STEP EXECUTOR ─────────────────────────────────────────

async function executeStep(step, context) {
  const p = page;
  const label = step.label ? `[${step.label}]` : '';
  try {
    switch (step.action) {
      case 'click':
        if (step.selector) {
          await p.click(step.selector);
          log(`Click selector: ${step.selector}${label}`);
        } else {
          await p.mouse.click(Number(step.x), Number(step.y));
          log(`Click at (${step.x}, ${step.y})${label}`);
        }
        break;

      case 'type': {
        const text = (step.text || '').replace(/\{\{prompt\}\}/g, context.prompt || '');
        log(`Type: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"${label}`);
        await p.keyboard.type(text, { delay: step.delay || 30 });
        break;
      }

      case 'keypress':
        await p.keyboard.press((step.key || 'Enter').trim());
        log(`Key: ${step.key || 'Enter'}${label}`);
        break;

      case 'send': {
        const text = (step.text || '').replace(/\{\{prompt\}\}/g, context.prompt || '');
        const delay = step.delay || 30;
        if (text) {
          log(`Send: typing "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"${label}`);
          await p.keyboard.type(text, { delay });
        } else {
          log(`Send: pressing Enter only${label}`);
        }
        await p.keyboard.press('Enter');
        log(`Send complete${label}`);
        const autoDeepSeek = !step.monitorDeepSeek && !step.monitorQwen && /deepseek\.com/i.test(context.profileUrl);
        const autoQwen = !step.monitorDeepSeek && !step.monitorQwen && /(qianwen|tongyi\.aliyun\.com|qwen)/i.test(context.profileUrl);
        const shouldMonitorDeepSeek = Boolean(step.monitorDeepSeek) || autoDeepSeek;
        const shouldMonitorQwen = Boolean(step.monitorQwen) || autoQwen;
        if (shouldMonitorDeepSeek || shouldMonitorQwen) {
          const useQwen = Boolean(step.monitorQwen) || autoQwen;
          const executor = useQwen ? runQwenMonitor : runDeepSeekMonitor;
          log(`Waiting for ${useQwen ? 'Qwen' : 'DeepSeek'} response${label}`);
          const result = await executor({
            timeout: step.timeout || 0,
            interval: step.interval || 500,
            stableThreshold: step.stableThreshold || 3
          });
          if (result && result.text) {
            context.result = normalizeExtractedText(result.text, context);
            broadcast('response', { text: context.result });
            log(`✅ ${useQwen ? 'Qwen' : 'DeepSeek'} response captured ${context.result.length} chars`);
          } else {
            log(`${useQwen ? 'Qwen' : 'DeepSeek'} monitor ended without captured text`, 'warn');
          }
        }
        break;
      }

      case 'scroll':
        log(`Scroll Δ(${step.deltaX || 0}, ${step.deltaY || 300})${label}`);
        await p.mouse.move(Number(step.x || 640), Number(step.y || 360));
        await p.mouse.wheel({ deltaX: Number(step.deltaX || 0), deltaY: Number(step.deltaY || 300) });
        break;

      case 'goto':
        step.action = 'navigate';
        /* falls through */

      case 'navigate':
        if (!step.url) throw new Error('Missing URL for navigate/goto step');
        log(`Navigate → ${step.url}${label}`);
        await p.goto(step.url, { waitUntil: 'networkidle2', timeout: 30000 });
        break;

      case 'wait':
        log(`Wait ${step.ms || 1000}ms ${label}`);
        await new Promise(r => setTimeout(r, Number(step.ms || 1000)));
        break;

      case 'waitSelector':
        log(`Wait for selector: ${step.selector}${label}`);
        try { await p.waitForSelector(step.selector, { timeout: step.timeout || 30000 }); }
        catch (e) { if (!step.optional) throw e; log(`Optional selector missing`, 'warn'); }
        break;

      case 'waitSelectorGone':
        log(`Wait gone: ${step.selector}${label}`);
        await p.waitForFunction(sel => !document.querySelector(sel), { timeout: step.timeout || 120000, polling: 1000 }, step.selector);
        break;

      case 'copy': {
        log(`Copy action${label}`);
        if (step.selector || step.x !== undefined || step.y !== undefined) {
          if (step.selector) {
            log(`Clicking copy selector: ${step.selector}${label}`);
            await p.click(step.selector);
          } else {
            log(`Clicking copy position: (${step.x}, ${step.y})${label}`);
            await p.mouse.click(Number(step.x || 0), Number(step.y || 0));
          }
          await new Promise(r => setTimeout(r, Number(step.waitMs || 600)));
        }

        const rawSelectors = (step.targetSelector || step.extractSelector || step.selector || '').split(',').map(s => s.trim()).filter(Boolean);
        let text = '';
        let attempts = 0;
        const maxAttempts = step.polling ? 10 : 1;

        while (attempts < maxAttempts) {
          if (rawSelectors.length) {
            for (const sel of rawSelectors) {
              try {
                text = await p.evaluate(s => {
                  const els = document.querySelectorAll(s);
                  if (!els.length) return '';
                  const el = els[els.length - 1];
                  return el.innerText || el.textContent || el.getAttribute('data-response') || '';
                }, sel);
                if (text.trim().length > 10) break;
              } catch (_) {}
            }
          } else {
            text = await p.evaluate(() => document.body.innerText || '');
          }
          if (text.trim() && !step.polling) break;
          attempts++;
          await new Promise(r => setTimeout(r, 1500));
        }

        text = text
          .replace(/【.*?】/g, '')
          .replace(/\[citation:\d+\]/g, '')
          .replace(/^(Waiting for|Generating|Typing...).*$/gm, '')
          .trim();

        text = normalizeExtractedText(text, context);
        context.result = text;
        log(`✅ Copied ${text.length} chars`);
        broadcast('response', { text });
        break;
      }

      case 'read': {
        log(`Read${step.selector ? ' selector: ' + step.selector : ' at (' + step.x + ',' + step.y + ')'}${label}`);
        let text = '';
        if (step.selector) {
          text = await p.evaluate(sel => {
            const el = document.querySelector(sel);
            return el ? (el.innerText || el.textContent || '') : '';
          }, step.selector);
        } else {
          text = await p.evaluate((x, y) => {
            const el = document.elementFromPoint(x, y);
            return el ? (el.innerText || el.textContent || '') : '';
          }, Number(step.x || 640), Number(step.y || 360));
        }
        text = normalizeExtractedText(text, context);
        context.result = text;
        log(`Read ${text.length} chars`);
        broadcast('response', { text });
        break;
      }

      case 'evaluate': {
        log(`Evaluate${label}`);
        const result = await p.evaluate(new Function(`return (${step.script})()`));
        if (result !== undefined) {
          context.result = String(result);
          broadcast('response', { text: context.result });
        }
        break;
      }

      default:
        log(`Unknown action: ${step.action}`, 'warn');
    }
  } catch (err) {
    log(`Step failed: ${err.message}`, 'error');
    throw err;
  }
}

// ── RUN PROFILE ───────────────────────────────────────────

async function runProfile(profileName, prompt) {
  const profiles = await loadProfiles();
  const profile = profiles.find(p => p.name === profileName);
  if (!profile) throw new Error(`Profile not found: ${profileName}`);

  const runStart = Date.now();
  let runStatus = 'success';
  let runError = null;
  const context = { prompt, result: '', profileUrl: profile.url || '' };
  try {
    log(`▶ Starting: ${profileName}`);
    broadcast('status', { running: true });
    await ensurePage();
    const sessionLoaded = await loadSession(profileName);
    for (let i = 0; i < profile.steps.length; i++) {
      if (shouldStop) { log('⏹ Stopped by user', 'warn'); break; }
      const step = profile.steps[i];
      broadcast('step', { index: i, total: profile.steps.length, label: step.label || step.action });
      await executeStep(step, context);
      await new Promise(r => setTimeout(r, 80));
    }
    log(`✓ Automation complete`);
    return context.result;
  } catch (err) {
    runStatus = 'failed';
    runError = err.message;
    throw err;
  } finally {
    isRunning = false;
    broadcast('status', { running: false });
    await recordRunHistory({
      profileSlug: profile.slug,
      profileName: profile.name,
      prompt,
      result: context.result,
      status: runStatus,
      error: runError,
      durationMs: Date.now() - runStart
    });
  }
}

// ── ROUTES ────────────────────────────────────────────────

app.get('/screenshot', async (req, res) => {
  try {
    await ensurePage();
    const buf = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/browser/url', async (req, res) => {
  try { res.json({ url: page ? page.url() : 'about:blank' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    await ensurePage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    res.json({ ok: true, url: page.url() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/click', async (req, res) => {
  try {
    const { x, y, button = 'left' } = req.body;
    await ensurePage();
    await page.mouse.click(Number(x), Number(y), { button });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/type', async (req, res) => {
  try {
    const { text, delay = 30 } = req.body;
    await ensurePage();
    await page.keyboard.type(text, { delay });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/keypress', async (req, res) => {
  try {
    const { key } = req.body;
    await ensurePage();
    await page.keyboard.press(key);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/scroll', async (req, res) => {
  try {
    const { x = 640, y = 360, deltaX = 0, deltaY = 300 } = req.body;
    await ensurePage();
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.wheel({ deltaX: Number(deltaX), deltaY: Number(deltaY) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/copy', async (req, res) => {
  try {
    const { selector } = req.body;
    await ensurePage();
    const text = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      return el ? (el.innerText || el.textContent || '') : '';
    }, selector);
    res.json({ ok: true, text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/read', async (req, res) => {
  try {
    const { selector, x, y } = req.body;
    await ensurePage();
    let text = '';
    if (selector) {
      text = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || el.textContent || '') : '';
      }, selector);
    } else {
      text = await page.evaluate((px, py) => {
        const el = document.elementFromPoint(px, py);
        return el ? (el.innerText || el.textContent || '') : '';
      }, Number(x || 640), Number(y || 360));
    }
    res.json({ ok: true, text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/wait', async (req, res) => {
  try {
    const { ms, selector, timeout } = req.body;
    await ensurePage();
    if (selector) await page.waitForSelector(selector, { timeout: timeout || 30000 });
    else await new Promise(r => setTimeout(r, Number(ms || 1000)));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/send', async (req, res) => {
  try {
    const { text, selector, pressEnter = true } = req.body;
    await ensurePage();
    if (selector) {
      await page.click(selector);
      if (text) await page.type(selector, text, { delay: 30 });
    } else if (text) {
      await page.keyboard.type(text, { delay: 30 });
    }
    if (pressEnter) await page.keyboard.press('Enter');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/evaluate', async (req, res) => {
  try {
    const { script } = req.body;
    await ensurePage();
    const result = await page.evaluate(script);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/deepseek-monitor', async (req, res) => {
  try {
    const options = req.body || {};
    await ensurePage();
    const result = await runDeepSeekMonitor(options);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/qwen-monitor', async (req, res) => {
  try {
    const options = req.body || {};
    await ensurePage();
    const result = await runQwenMonitor(options);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Profiles
app.get('/profiles', async (req, res) => {
  try {
    const profiles = await loadProfiles();
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/profiles', requireApiKey, async (req, res) => {
  try {
    const profiles = await loadProfiles();
    const { name, url, steps } = req.body;
    if (!name) return res.status(400).json({ error: 'Profile name is required' });
    const sanitized = { name, url, steps, slug: slugify(name) };
    const idx = profiles.findIndex(p => p.name === name || p.slug === sanitized.slug);
    if (idx >= 0) profiles[idx] = sanitized;
    else profiles.push(sanitized);
    await saveProfiles(profiles);
    res.json({ ok: true, slug: sanitized.slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/profiles/:name', requireApiKey, async (req, res) => {
  try {
    let profiles = await loadProfiles();
    const target = decodeURIComponent(req.params.name);
    profiles = profiles.filter(p => p.name !== target && p.slug !== target);
    await saveProfiles(profiles);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function runProfileBySlug(slug, prompt) {
  const profile = await getProfileBySlug(slug);
  if (!profile) throw new Error(`Profile not found: ${slug}`);
  return runProfile(profile.name, prompt);
}

// Automation
app.post('/run', requireApiKey, async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Already running' });
  const { profile, prompt } = req.body;
  if (!profile) return res.status(400).json({ error: 'profile required' });
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  runProfile(profile, prompt)
    .then(result => broadcast('done', { result }))
    .catch(e => { log(`Error: ${e.message}`, 'error'); broadcast('error', { message: e.message }); });
  res.json({ ok: true });
});

app.post('/run/:slug', requireApiKey, async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Already running' });
  const slug = decodeURIComponent(req.params.slug);
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const reply = await runProfileBySlug(slug, prompt);
    const profiles = await loadProfiles();
    const profile = profiles.find(p => p.slug === slug);
    saveLastResponse(reply, profile?.name || slug, prompt);
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/:slug', requireApiKey, async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Already running' });
  const slug = decodeURIComponent(req.params.slug);
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const reply = await runProfileBySlug(slug, prompt);
    const profiles = await loadProfiles();
    const profile = profiles.find(p => p.slug === slug);
    saveLastResponse(reply, profile?.name || slug, prompt);
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/run/:slug', requireApiKey, async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Already running' });
  const slug = decodeURIComponent(req.params.slug);
  const prompt = req.query.prompt || '';
  if (!prompt) return res.status(400).json({ error: 'prompt query required' });
  try {
    const reply = await runProfileBySlug(slug, prompt);
    const profiles = await loadProfiles();
    const profile = profiles.find(p => p.slug === slug);
    saveLastResponse(reply, profile?.name || slug, prompt);
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/:slug', requireApiKey, async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Already running' });
  const slug = decodeURIComponent(req.params.slug);
  const prompt = req.query.prompt || '';
  if (!prompt) return res.status(400).json({ error: 'prompt query required' });
  try {
    const reply = await runProfileBySlug(slug, prompt);
    const profiles = await loadProfiles();
    const profile = profiles.find(p => p.slug === slug);
    saveLastResponse(reply, profile?.name || slug, prompt);
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/stop', requireApiKey, (req, res) => {
  shouldStop = true;
  log('Stop requested', 'warn');
  res.json({ ok: true });
});

app.post('/ask', requireApiKey, async (req, res) => {
  const { message, profile = 'DeepSeek Send' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (isRunning) return res.status(409).json({ error: 'Bot is busy' });
  try {
    const reply = await runProfile(profile, message);
    saveLastResponse(reply, profile, message);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', (req, res) => {
  res.json({
    running: isRunning,
    url: page ? page.url() : null,
    browserConnected: !!(browser && browser.isConnected()),
    dbConnected: !!(USE_POSTGRES && dbClient)
  });
});

app.get('/last-response', (req, res) => {
  res.json(lastResponse);
});

app.get('/copy-event', (req, res) => {
  res.json({ lastCopyBotResponseEvent });
});

app.get('/copy-output', (req, res) => {
  res.json({
    outputText: lastCopyBotResponseEvent?.outputText || lastResponse.text || '',
    source: lastCopyBotResponseEvent ? 'copy-event' : 'last-response',
    event: lastCopyBotResponseEvent || null,
    lastResponse
  });
});

app.get('/download-response', (req, res) => {
  const { format = 'txt' } = req.query;
  const timestamp = lastResponse.timestamp ? new Date(lastResponse.timestamp).toLocaleString() : 'N/A';
  let content, mimeType, filename;

  if (format === 'json') {
    content = JSON.stringify(lastResponse, null, 2);
    mimeType = 'application/json';
    filename = `response_${Date.now()}.json`;
  } else if (format === 'csv') {
    content = `Profile,Prompt,Response,Timestamp\n"${lastResponse.profileName}","${lastResponse.prompt}","${lastResponse.text}","${timestamp}"`;
    mimeType = 'text/csv';
    filename = `response_${Date.now()}.csv`;
  } else {
    content = `Profile: ${lastResponse.profileName}\nPrompt: ${lastResponse.prompt}\nResponse: ${lastResponse.text}\nTimestamp: ${timestamp}`;
    mimeType = 'text/plain';
    filename = `response_${Date.now()}.txt`;
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

app.get('/endpoints', requireApiKey, async (req, res) => {
  try {
    const endpoints = (await loadProfiles()).map(profile => ({
      name: profile.name,
      slug: profile.slug,
      endpoint: `/run/${profile.slug}`,
      description: profile.label || profile.name,
      url: profile.url || null
    }));
    res.json({ endpoints, docs: {
      run: 'POST /run/{slug} with {"prompt":"..."}',
      runGet: 'GET /run/{slug}?prompt=...'
    } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/history', requireApiKey, async (req, res) => {
  if (!USE_POSTGRES) return res.status(404).json({ error: 'History is not enabled without DATABASE_URL' });
  if (!dbClient) return res.status(503).json({ error: 'DB reconnecting, try again shortly' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  try {
    const result = await dbClient.query(
      'SELECT id, profile_slug, profile_name, prompt, result, status, error, duration_ms, created_at FROM runs ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({ history: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/docs', async (req, res) => {
  try {
    const endpoints = (await loadProfiles()).map(profile => ({
      name: profile.name,
      slug: profile.slug,
      endpoint: `/run/${profile.slug}`,
      url: profile.url || 'n/a'
    }));
    const docsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BotForge API Docs</title>
  <style>body{font-family:system-ui,sans-serif;background:#0f0f12;color:#e0e0e0;padding:24px;}pre,code{background:#111;color:#9ece6a;padding:4px 8px;border-radius:4px;}table{width:100%;border-collapse:collapse;margin-top:16px;}th,td{padding:10px;border:1px solid #222;text-align:left;}th{background:#15151a;}</style>
</head>
<body>
  <h1>BotForge API Docs</h1>
  <p>Use <code>x-api-key</code> or <code>?api_key=...</code> when <strong>API_KEY</strong> is configured.</p>
  <h2>Endpoints</h2>
  <ul>
    <li><code>POST /run/{slug}</code> with JSON <code>{"prompt":"..."}</code></li>
    <li><code>GET /run/{slug}?prompt=...</code></li>
    <li><code>POST /api/{slug}</code> with JSON <code>{"prompt":"..."}</code></li>
    <li><code>GET /api/{slug}?prompt=...</code></li>
    <li><code>GET /endpoints</code></li>
    <li><code>GET /history?limit=20</code> (requires DB)</li>
  </ul>
  <h2>Saved flows</h2>
  <table><thead><tr><th>Name</th><th>Slug</th><th>Endpoint</th><th>URL</th></tr></thead><tbody>
    ${endpoints.map(e => `<tr><td>${e.name}</td><td>${e.slug}</td><td><code>${e.endpoint}</code></td><td>${e.url}</td></tr>`).join('')}
  </tbody></table>
</body>
</html>`;
    res.send(docsHtml);
  } catch (e) {
    res.status(500).send(`<pre>Docs load failed: ${e.message}</pre>`);
  }
});

// SSE Logs
app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

// ── START ─────────────────────────────────────────────────

(async () => {
  try {
    await initDatabase();
    await ensureProfileStore();

    app.listen(PORT, '0.0.0.0', () => log(`Server running on port ${PORT}`));

    startSelfPinger();

    ensurePage()
      .then(() => log('Browser ready'))
      .catch(err => log(`Browser init failed: ${err.message}`, 'error'));
  } catch (err) {
    log(`Fatal startup error: ${err.message}`, 'error');
    process.exit(1);
  }
})();
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Clé secrète admin (à définir dans les variables d'env Render) ───────────
// Sur Render : Settings > Environment > Add ADMIN_SECRET=une_longue_chaine_aleatoire
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

const DATA_FILE = path.join(__dirname, 'data.json');

// ─── Rate limiting manuel (sans dépendance externe) ──────────────────────────
const rateLimitMap = new Map();
function rateLimit(ip, maxReq, windowMs) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  return entry.count > maxReq;
}
// Nettoyage toutes les 10 min pour éviter fuite mémoire
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (entry.start < cutoff) rateLimitMap.delete(ip);
  }
}, 600000);

// ─── Middleware rate limit global ─────────────────────────────────────────────
function globalRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (rateLimit(ip, 120, 60000)) { // max 120 requêtes/min par IP
    return res.status(429).json({ error: 'Trop de requêtes, ralentis.' });
  }
  next();
}

// ─── Middleware auth admin ────────────────────────────────────────────────────
// Toutes les routes d'écriture (/api/set, /api/delete) nécessitent le header
// X-Admin-Token correspondant à ADMIN_SECRET
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    // Pas de secret configuré = mode dev, on laisse passer mais on avertit
    console.warn('[WARN] ADMIN_SECRET non configuré — routes non protégées !');
    return next();
  }
  const token = req.headers['x-admin-token'] || '';
  // Comparaison à temps constant pour éviter timing attacks
  const valid =
    token.length === ADMIN_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_SECRET));
  if (!valid) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    console.warn(`[SECURITY] Tentative admin non autorisée depuis ${ip}`);
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  next();
}

// ─── Validation des clés ──────────────────────────────────────────────────────
const ALLOWED_KEYS = /^[a-zA-Z0-9_\-:]{1,120}$/;
function isValidKey(k) {
  return typeof k === 'string' && ALLOWED_KEYS.test(k);
}

// ─── Lecture / écriture DB ────────────────────────────────────────────────────
function readDB() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { shared: {} };
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { shared: {} };
  }
}
function writeDB(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Erreur écriture DB:', e);
  }
}

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https://cdn.akamai.steamstatic.com https://cdn.cloudflare.steamstatic.com https://shared.fastly.steamstatic.com https://shared.akamai.steamstatic.com https://static.twitchsvc.net https://static-cdn.jtvnw.net; " +
    "connect-src 'self' https://api.twitch.tv; " +
    "frame-src https://player.twitch.tv;"
  );
  next();
});

app.use(globalRateLimit);
app.use(express.json({ limit: '64kb' })); // limite la taille des corps de requête

// ─── Fichiers statiques ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API lecture (publique) ───────────────────────────────────────────────────
app.post('/api/get', (req, res) => {
  const { key } = req.body;
  if (!isValidKey(key)) return res.status(400).json({ error: 'Clé invalide.' });
  const db = readDB();
  const target = db.shared || {};
  if (!(key in target)) return res.status(404).json({ error: 'not found' });
  res.json({ key, value: target[key], shared: true });
});

app.post('/api/list', (req, res) => {
  const p = typeof req.body.prefix === 'string' ? req.body.prefix : '';
  const db = readDB();
  const target = db.shared || {};
  const keys = Object.keys(target).filter(x => !p || x.startsWith(p));
  res.json({ keys, shared: true });
});

// ─── API écriture (admin uniquement) ─────────────────────────────────────────
// Rate limit spécial pour les écritures : 30 req/min par IP
app.post('/api/set', requireAdmin, (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (rateLimit('write:' + ip, 30, 60000)) return res.status(429).json({ error: 'Trop d\'écritures.' });

  const { key, value } = req.body;
  if (!isValidKey(key)) return res.status(400).json({ error: 'Clé invalide.' });
  if (typeof value !== 'string' || value.length > 512000)
    return res.status(400).json({ error: 'Valeur trop grande ou invalide.' });

  const db = readDB();
  if (!db.shared) db.shared = {};
  db.shared[key] = value;
  writeDB(db);
  res.json({ key, value, shared: true });
});

app.post('/api/delete', requireAdmin, (req, res) => {
  const { key } = req.body;
  if (!isValidKey(key)) return res.status(400).json({ error: 'Clé invalide.' });
  const db = readDB();
  if (db.shared && key in db.shared) {
    delete db.shared[key];
    writeDB(db);
  }
  res.json({ key, deleted: true, shared: true });
});

// ─── Route de vérification du token (pour le login côté client) ──────────────
// Rate limit strict : 10 tentatives/min par IP (anti-brute force)
app.post('/api/verify-admin', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (rateLimit('verify:' + ip, 10, 60000)) {
    console.warn(`[SECURITY] Brute-force détecté depuis ${ip}`);
    return res.status(429).json({ error: 'Trop de tentatives. Attends 1 minute.' });
  }
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'ADMIN_SECRET non configuré sur le serveur.' });
  const token = req.headers['x-admin-token'] || '';
  if (
    token.length === ADMIN_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_SECRET))
  ) {
    // Délai artificiel pour décourager le timing
    setTimeout(() => res.json({ ok: true }), 200);
  } else {
    setTimeout(() => res.status(403).json({ error: 'Token invalide.' }), 200);
  }
});

// ─── Proxy Steam search ───────────────────────────────────────────────────────
app.get('/api/steam-search', (req, res) => {
  const term = (req.query.term || '').slice(0, 100); // limite la longueur
  if (!term) return res.json({ items: [] });
  const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=french&cc=FR`;
  const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };
  https.get(steamUrl, options, (steamRes) => {
    steamRes.setEncoding('utf8');
    let data = '';
    steamRes.on('data', chunk => data += chunk);
    steamRes.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch (e) { res.status(500).json({ error: 'Erreur réponse Steam' }); }
    });
  }).on('error', () => res.status(500).json({ error: 'Connexion Steam échouée' }));
});

// ─── Proxy image Steam ────────────────────────────────────────────────────────
function pipeSteamImage(url, options, res, onFail, redirectCount = 0) {
  if (redirectCount > 5) return onFail();
  https.get(url, options, (steamRes) => {
    const code = steamRes.statusCode;
    if (code >= 300 && code < 400 && steamRes.headers.location)
      return pipeSteamImage(steamRes.headers.location, options, res, onFail, redirectCount + 1);
    if (code === 200) {
      res.setHeader('Content-Type', steamRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      steamRes.pipe(res);
    } else { onFail(); }
  }).on('error', () => onFail());
}

app.get('/api/steam-image/:appid', (req, res) => {
  const appid = parseInt(req.params.appid, 10);
  if (!appid || appid < 1 || appid > 9999999) return res.status(400).end();
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };
  const u1 = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
  const u2 = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
  const u3 = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
  const u4 = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_616x353.jpg`;
  pipeSteamImage(u1, opts, res, () =>
    pipeSteamImage(u2, opts, res, () =>
      pipeSteamImage(u3, opts, res, () =>
        pipeSteamImage(u4, opts, res, () => res.status(404).end()))));
});

// ─── Fallback SPA ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));

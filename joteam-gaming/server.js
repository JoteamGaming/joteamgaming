const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Variables d'environnement ────────────────────────────────────────────────
const ADMIN_SECRET     = process.env.ADMIN_SECRET     || null;
const TWITCH_CHANNEL   = process.env.TWITCH_CHANNEL   || 'JoteamGaming_Tv';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'gp762nuuoqcoxypju8c569th9wz7q5';
const TWITCH_TOKEN     = process.env.TWITCH_TOKEN     || '2pitykeca6l97bwpqsb53scratr9fp';

// ─── Render API (pour persister les variables d'env entre redémarrages) ───────
// Sur Render : Settings > Environment > Ajouter RENDER_API_KEY et RENDER_SERVICE_ID
const RENDER_API_KEY    = process.env.RENDER_API_KEY    || null;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || null;

const DATA_FILE = path.join(__dirname, 'data.json');

// ─── Sauvegarde des données critiques dans les variables d'env Render ─────────
// Appelée automatiquement après chaque écriture de jeux ou de config Twitch.
// Nécessite RENDER_API_KEY + RENDER_SERVICE_ID dans les variables d'env Render.
async function persistToRenderEnv(key, value) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return false;
  return new Promise((resolve) => {
    const body = JSON.stringify({ envVars: [{ key, value }] });
    const options = {
      hostname: 'api.render.com',
      path: `/v1/services/${RENDER_SERVICE_ID}/env-vars`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

// ─── Restauration automatique de la config au démarrage ──────────────────────
// Ordre de priorité : RENDER_ENV_GAMES / RENDER_ENV_CFG > data.json > valeurs par défaut
async function restoreOnBoot() {
  const db = readDB();
  if (!db.shared) db.shared = {};

  // 1. Restaurer les jeux depuis la variable d'env RENDER_BACKUP_GAMES
  const backupGames = process.env.RENDER_BACKUP_GAMES;
  if (backupGames) {
    try {
      JSON.parse(backupGames); // validation
      const existing = db.shared['joteam_games'];
      if (!existing) {
        db.shared['joteam_games'] = backupGames;
        console.log('[Boot] Jeux restaurés depuis RENDER_BACKUP_GAMES');
      } else {
        // Garde la version la plus récente (plus de jeux = plus récente)
        const existingGames = JSON.parse(existing);
        const backupArr = JSON.parse(backupGames);
        if (backupArr.length > existingGames.length) {
          db.shared['joteam_games'] = backupGames;
          console.log('[Boot] Jeux mis à jour depuis RENDER_BACKUP_GAMES (plus complet)');
        }
      }
    } catch(e) {
      console.warn('[Boot] RENDER_BACKUP_GAMES invalide:', e.message);
    }
  }

  // 2. Restaurer la config Twitch (chaîne + photo de profil) depuis RENDER_BACKUP_CFG
  const backupCfg = process.env.RENDER_BACKUP_CFG;
  if (backupCfg) {
    try {
      JSON.parse(backupCfg); // validation
      if (!db.shared['joteam_config']) {
        db.shared['joteam_config'] = backupCfg;
        console.log('[Boot] Config Twitch restaurée depuis RENDER_BACKUP_CFG');
      }
    } catch(e) {
      console.warn('[Boot] RENDER_BACKUP_CFG invalide:', e.message);
    }
  }

  // 3. Toujours forcer le nom de chaîne Twitch depuis les variables d'env Render
  if (TWITCH_CHANNEL) {
    let cfg = {};
    try { cfg = JSON.parse(db.shared['joteam_config'] || '{}'); } catch(e) {}
    if (!cfg.twitch) cfg.twitch = {};
    // Ne pas écraser la photo de profil si elle est déjà là
    cfg.twitch.channel = TWITCH_CHANNEL;
    cfg.twitchChannel  = TWITCH_CHANNEL;
    db.shared['joteam_config'] = JSON.stringify(cfg);
    console.log(`[Boot] Chaîne Twitch forcée : ${TWITCH_CHANNEL}`);
  }

  // 4. Restaurer les secrets Twitch (clientId + token)
  if (TWITCH_CLIENT_ID || TWITCH_TOKEN) {
    let sec = {};
    try { sec = JSON.parse(db.shared['joteam_twitch_secret'] || '{}'); } catch(e) {}
    if (TWITCH_CLIENT_ID) sec.clientId = TWITCH_CLIENT_ID;
    if (TWITCH_TOKEN)     sec.token    = TWITCH_TOKEN;
    db.shared['joteam_twitch_secret'] = JSON.stringify(sec);
  }

  writeDB(db);

  // 5. Auto-sync Twitch pour récupérer la photo de profil après le boot
  if (TWITCH_CHANNEL && TWITCH_CLIENT_ID && TWITCH_TOKEN) {
    console.log('[Boot] Auto-sync Twitch pour récupérer la photo de profil...');
    setTimeout(() => autoSyncTwitchProfile(db), 5000); // délai pour que le serveur soit prêt
  }
}

// ─── Auto-sync Twitch : récupère la photo de profil via l'API Helix ──────────
function autoSyncTwitchProfile(db) {
  const channel = TWITCH_CHANNEL;
  const clientId = TWITCH_CLIENT_ID;
  const token = TWITCH_TOKEN;
  if (!channel || !clientId || !token) return;

  const options = {
    hostname: 'api.twitch.tv',
    path: `/helix/users?login=${encodeURIComponent(channel)}`,
    headers: {
      'Client-Id': clientId,
      'Authorization': `Bearer ${token}`
    }
  };

  https.get(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.data && parsed.data[0]) {
          const user = parsed.data[0];
          // Mettre à jour la photo de profil dans data.json
          const freshDB = readDB();
          let cfg = {};
          try { cfg = JSON.parse(freshDB.shared['joteam_config'] || '{}'); } catch(e) {}
          if (!cfg.twitch) cfg.twitch = {};
          cfg.twitch.profile = {
            login: user.login,
            name: user.display_name,
            avatar: user.profile_image_url,
            id: user.id
          };
          cfg.twitch.lastSync = Date.now();
          freshDB.shared['joteam_config'] = JSON.stringify(cfg);
          writeDB(freshDB);

          // Sauvegarder dans Render ENV pour la prochaine fois
          persistToRenderEnv('RENDER_BACKUP_CFG', JSON.stringify(cfg))
            .then(ok => console.log(`[Boot] Photo de profil Twitch récupérée et ${ok ? 'sauvegardée dans Render ENV' : 'sauvegardée localement seulement'}`));
        }
      } catch(e) {
        console.warn('[Boot] Erreur sync Twitch profil:', e.message);
      }
    });
  }).on('error', (e) => console.warn('[Boot] Erreur connexion Twitch:', e.message));
}

// ─── Rate limiting manuel ─────────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(ip, maxReq, windowMs) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
  else entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > maxReq;
}
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (entry.start < cutoff) rateLimitMap.delete(ip);
  }
}, 600000);

// ─── Middlewares ──────────────────────────────────────────────────────────────
function globalRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (rateLimit(ip, 120, 60000)) return res.status(429).json({ error: 'Trop de requêtes, ralentis.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) { console.warn('[WARN] ADMIN_SECRET non configuré — routes non protégées !'); return next(); }
  const token = req.headers['x-admin-token'] || '';
  const valid = token.length === ADMIN_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_SECRET));
  if (!valid) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    console.warn(`[SECURITY] Tentative admin non autorisée depuis ${ip}`);
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  next();
}

const ALLOWED_KEYS = /^[a-zA-Z0-9_\-:]{1,120}$/;
function isValidKey(k) { return typeof k === 'string' && ALLOWED_KEYS.test(k); }

// ─── Lecture / écriture DB ────────────────────────────────────────────────────
function readDB() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { shared: {} };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { return { shared: {} }; }
}
function writeDB(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch(e) { console.error('Erreur écriture DB:', e); }
}

// ─── Sauvegarde automatique vers Render ENV après écriture de clés critiques ──
// Clés surveillées : joteam_games (votes) et joteam_config (Twitch + profil)
const WATCHED_KEYS = ['joteam_games', 'joteam_config'];
const RENDER_ENV_MAP = {
  'joteam_games':  'RENDER_BACKUP_GAMES',
  'joteam_config': 'RENDER_BACKUP_CFG'
};
async function maybePersistKey(key, value) {
  if (!WATCHED_KEYS.includes(key)) return;
  const envKey = RENDER_ENV_MAP[key];
  const ok = await persistToRenderEnv(envKey, value);
  if (ok) console.log(`[Persist] ${envKey} sauvegardé dans Render ENV`);
  else if (RENDER_API_KEY) console.warn(`[Persist] Échec sauvegarde ${envKey} dans Render ENV`);
}

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
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
app.use(express.json({ limit: '64kb' }));
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
app.post('/api/set', requireAdmin, async (req, res) => {
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

  // Sauvegarde asynchrone vers Render ENV (ne bloque pas la réponse)
  maybePersistKey(key, value).catch(() => {});

  res.json({ key, value, shared: true });
});

app.post('/api/delete', requireAdmin, (req, res) => {
  const { key } = req.body;
  if (!isValidKey(key)) return res.status(400).json({ error: 'Clé invalide.' });
  const db = readDB();
  if (db.shared && key in db.shared) { delete db.shared[key]; writeDB(db); }
  res.json({ key, deleted: true, shared: true });
});

// ─── Vérification du token admin ─────────────────────────────────────────────
app.post('/api/verify-admin', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (rateLimit('verify:' + ip, 10, 60000)) {
    console.warn(`[SECURITY] Brute-force détecté depuis ${ip}`);
    return res.status(429).json({ error: 'Trop de tentatives. Attends 1 minute.' });
  }
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'ADMIN_SECRET non configuré sur le serveur.' });
  const token = req.headers['x-admin-token'] || '';
  if (token.length === ADMIN_SECRET.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_SECRET))) {
    setTimeout(() => res.json({ ok: true }), 200);
  } else {
    setTimeout(() => res.status(403).json({ error: 'Token invalide.' }), 200);
  }
});

// ─── Route de statut de persistance (pour vérifier la config Render) ─────────
app.get('/api/persist-status', requireAdmin, (req, res) => {
  res.json({
    renderApiConfigured: !!(RENDER_API_KEY && RENDER_SERVICE_ID),
    backupGamesPresent:  !!process.env.RENDER_BACKUP_GAMES,
    backupCfgPresent:    !!process.env.RENDER_BACKUP_CFG,
    twitchChannel:       TWITCH_CHANNEL || null,
    twitchCredsPresent:  !!(TWITCH_CLIENT_ID && TWITCH_TOKEN),
  });
});

// ─── Proxy Steam search ───────────────────────────────────────────────────────
app.get('/api/steam-search', (req, res) => {
  const term = (req.query.term || '').slice(0, 100);
  if (!term) return res.json({ items: [] });
  const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=french&cc=FR`;
  const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };
  https.get(steamUrl, options, (steamRes) => {
    steamRes.setEncoding('utf8');
    let data = '';
    steamRes.on('data', chunk => data += chunk);
    steamRes.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.status(500).json({ error: 'Erreur réponse Steam' }); }
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

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  await restoreOnBoot();
  console.log('[Boot] Persistance Render ENV :', RENDER_API_KEY && RENDER_SERVICE_ID
    ? '✅ Configurée (RENDER_API_KEY + RENDER_SERVICE_ID présents)'
    : '⚠️  Non configurée — ajoute RENDER_API_KEY et RENDER_SERVICE_ID dans les variables d\'env Render');
});


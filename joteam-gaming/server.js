const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');

// Lecture de la base de données JSON
function readDB() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { shared: {} };
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { shared: {} };
  }
}

// Écriture dans la base de données JSON
function writeDB(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Erreur écriture DB:', e);
  }
}

app.use(express.json());

// Distribution des fichiers statiques du frontend
app.use(express.static(path.join(__dirname, 'public')));

// API simulation de window.storage
app.post('/api/get', (req, res) => {
  const { key } = req.body;
  const db = readDB();
  const target = db.shared || {};
  if (!(key in target)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ key, value: target[key], shared: true });
});

app.post('/api/set', (req, res) => {
  const { key, value } = req.body;
  const db = readDB();
  if (!db.shared) db.shared = {};
  db.shared[key] = value;
  writeDB(db);
  res.json({ key, value, shared: true });
});

app.post('/api/delete', (req, res) => {
  const { key } = req.body;
  const db = readDB();
  if (db.shared && key in db.shared) {
    delete db.shared[key];
    writeDB(db);
  }
  res.json({ key, deleted: true, shared: true });
});

app.post('/api/list', (req, res) => {
  const { prefix } = req.body;
  const db = readDB();
  const target = db.shared || {};
  const keys = Object.keys(target).filter(x => !prefix || x.startsWith(prefix));
  res.json({ keys, shared: true });
});

// Proxy de recherche Steam pour contourner CORS
app.get('/api/steam-search', (req, res) => {
  const term = req.query.term || '';
  if (!term) return res.json({ items: [] });

  const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=french&cc=FR`;

  https.get(steamUrl, (steamRes) => {
    steamRes.setEncoding('utf8');
    let data = '';
    steamRes.on('data', (chunk) => data += chunk);
    steamRes.on('end', () => {
      try {
        res.json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: 'Erreur d\'analyse de la réponse Steam' });
      }
    });
  }).on('error', (e) => {
    res.status(500).json({ error: 'Échec de connexion aux serveurs Steam' });
  });
});

// Proxy d'image Steam pour contourner les blocages de Referrer/CORS
app.get('/api/steam-image/:appid', (req, res) => {
  const appid = req.params.appid;
  const steamUrl = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
  
  https.get(steamUrl, (steamRes) => {
    if (steamRes.statusCode === 200) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h
      steamRes.pipe(res);
    } else {
      // Secours si le CDN moderne renvoie une erreur (404/etc)
      const legacyUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
      https.get(legacyUrl, (legacyRes) => {
        if (legacyRes.statusCode === 200) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          legacyRes.pipe(res);
        } else {
          res.status(404).end();
        }
      }).on('error', () => res.status(404).end());
    }
  }).on('error', (e) => {
    res.status(500).end();
  });
});

// Redirection globale vers index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

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

// Proxy de recherche Steam pour contourner CORS (avec User-Agent simulé)
app.get('/api/steam-search', (req, res) => {
  const term = req.query.term || '';
  if (!term) return res.json({ items: [] });

  const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=french&cc=FR`;
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };

  https.get(steamUrl, options, (steamRes) => {
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

// Fonction récursive pour suivre automatiquement les redirections (301/302/307)
function pipeSteamImage(url, options, res, onFail, redirectCount = 0) {
  if (redirectCount > 5) {
    return onFail();
  }

  https.get(url, options, (steamRes) => {
    const code = steamRes.statusCode;

    // Si c'est une redirection, on suit l'en-tête 'location'
    if (code >= 300 && code < 400 && steamRes.headers.location) {
      return pipeSteamImage(steamRes.headers.location, options, res, onFail, redirectCount + 1);
    }

    if (code === 200) {
      res.setHeader('Content-Type', steamRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h
      steamRes.pipe(res);
    } else {
      onFail();
    }
  }).on('error', () => {
    onFail();
  });
}

// Proxy d'image Steam avec suivi des redirections et cascade de serveurs
app.get('/api/steam-image/:appid', (req, res) => {
  const appid = req.params.appid;
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };

  const urlModern = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
  const urlAkamai = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
  const urlLegacy = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
  const urlCapsule = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_616x353.jpg`;

  // Étape 1 : On tente le CDN moderne Fastly
  pipeSteamImage(urlModern, options, res, () => {
    // Étape 2 : Secours sur le CDN Akamai
    pipeSteamImage(urlAkamai, options, res, () => {
      // Étape 3 : Secours sur le CDN Cloudflare
      pipeSteamImage(urlLegacy, options, res, () => {
        // Étape 4 : Secours sur l'image de capsule large en dernier recours
        pipeSteamImage(urlCapsule, options, res, () => {
          res.status(404).end();
        });
      });
    });
  });
});

// Redirection globale vers index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

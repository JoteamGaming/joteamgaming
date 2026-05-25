const express = require('express');
const fs = require('fs');
const path = require('path');
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

// Simuler l'API de stockage partagée
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

// Redirection par défaut vers index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
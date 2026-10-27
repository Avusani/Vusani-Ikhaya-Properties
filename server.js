require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.static(__dirname)); 

const sessions = new Map();
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

async function initDB() {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);
    const res = await client.query('SELECT * FROM app_state WHERE id = $1', ['main_db']);
    if (res.rowCount === 0) {
      const defaultDB = {
        rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] },
        reviews: { pending: [], approved: [], declined: [] },
        reports: { pending: [], approved: [], declined: [] },
        transports: { pending: [], approved: [], declined: [], removed: [] },
        tenantRequests: { pending: [], approved: [], declined: [], removed: [] },
        receipts: [],
        contacts: []
      };
      await client.query('INSERT INTO app_state (id, data) VALUES ($1, $2)', ['main_db', defaultDB]);
    }
    client.release();
  } catch (err) { console.error("DB Error:", err.message); }
}
initDB();

async function readDB() {
  const res = await pool.query('SELECT data FROM app_state WHERE id = $1', ['main_db']);
  return res.rows[0].data;
}

async function writeDB(db) {
  await pool.query('UPDATE app_state SET data = $1 WHERE id = $2', [db, 'main_db']);
}

app.get('/api/admin/reset-everything', async (req, res) => {
  try {
    const emptyDB = {
      rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] },
      reviews: { pending: [], approved: [], declined: [] },
      reports: { pending: [], approved: [], declined: [] },
      transports: { pending: [], approved: [], declined: [], removed: [] },
      tenantRequests: { pending: [], approved: [], declined: [], removed: [] },
      receipts: [],
      contacts: []
    };
    await writeDB(emptyDB);
    res.json({ ok: true, message: "Database reset." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload', upload.array('media', 9), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
    const urls = [];
    for (const file of req.files) {
      const b64 = Buffer.from(file.buffer).toString('base64');
      const dataURI = `data:${file.mimetype};base64,${b64}`;
      const result = await cloudinary.uploader.upload(dataURI, { folder: 'vusani_properties', resource_type: 'auto' });
      urls.push(result.secure_url);
    }
    res.json({ success: true, urls });
  } catch (err) { res.status(500).json({ error: "Upload failed" }); }
});

app.get('/api/public', async (req, res) => {
  try {
    const db = await readDB();
    const rooms = db.rooms.approved.filter(r => r.online !== false).map(room => ({
      id: room.id, title: room.title, location: room.location, alexandraSuburb: room.alexandraSuburb || '',
      purpose: room.purpose || 'rent', amount: room.amount, deposit: room.deposit || 'No deposit',
      bedrooms: Number(room.bedrooms) || 1, bathrooms: Number(room.bathrooms) || 1, 
      parkingSpaces: Number(room.maxCars) || (room.parking === 'Yes' ? 1 : 0),
      childFriendly: room.childFriendly === 'Yes' ? 'Yes' : 'No', maxKids: room.maxKids || '0',
      toiletType: room.toiletType || 'Shared', bathroomType: room.bathroomType || 'Shared',
      tiles: room.tiles || 'No', ceiling: room.ceiling || 'No', images: room.images || [],
      mainImage: room.images?.[0] || '', thumbs: room.images?.slice(1, 4) || [], video: room.video || "",
      notes: room.notes, posterName: room.posterName, posterContact: room.posterContact
    }));
    res.json({ rooms });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const db = await readDB();
    const b = req.body;
    db.rooms.pending.unshift({ id: "post-" + Date.now(), ...b, online: true, status: "pending", createdAt: new Date().toISOString() });
    await writeDB(db);
    res.status(201).json({ ok: true, id: db.rooms.pending[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Incorrect password" });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  res.json({ token, success: true });
});

app.get('/api/admin/data', async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const db = await readDB();
    res.json({ ...db });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/action', async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const db = await readDB();
    const { action, section, from, to, id, data } = req.body;

    if (action === 'move') {
      const item = db[section][from].find(x => x.id === id);
      if (item) {
        db[section][from] = db[section][from].filter(x => x.id !== id);
        db[section][to].unshift({ ...item, status: to, updatedAt: new Date().toISOString() });
      }
    } 
    else if (action === 'edit') {
      const i = db[section][from].findIndex(x => x.id === id);
      if (i !== -1) db[section][from][i] = { ...db[section][from][i], ...data, updatedAt: new Date().toISOString() };
    }
    else if (action === 'delete') {
      db[section][from] = db[section][from].filter(x => x.id !== id);
    }
    else if (action === 'add-image') {
      const item = db[section][from].find(x => x.id === id);
      if (item) {
        if (!item.images) item.images = [];
        item.images.push(data.imageUrl);
      }
    }
    await writeDB(db);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server running on port ${PORT}`); });

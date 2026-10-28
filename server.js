require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
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

// ============ LOCATION GROUPING FOR MATCHING ============
const ALEXANDRA_EAST_GROUP = ['east bank','far east bank','ext 7','ext7','ext 8','ext8','ext 9','ext9','tsutsumane','river park','river park phase 3'];
const ALEXANDRA_AVENUES_GROUP = ['1st avenue – 12th avenue','1st avenue - 12th avenue','12th avenue – 22nd avenue','12th avenue - 22nd avenue','13th avenue – 22nd avenue','13th avenue - 22nd avenue','1st avenue – 22nd avenue','1st avenue - 22nd avenue'];
const NORTHERN_SUBURBS_GROUP = ['lombardy','bramley','kew','balfour','orange grove'];

function locationGroup(location, suburb) {
  const l = String(location || '').toLowerCase().trim();
  const s = String(suburb || '').toLowerCase().trim();
  const combined = (l + ' ' + s).trim();
  if (ALEXANDRA_EAST_GROUP.some(x => combined.includes(x))) return 'Alexandra East';
  if (ALEXANDRA_AVENUES_GROUP.some(x => combined.includes(x))) return 'Alexandra Avenues';
  if (NORTHERN_SUBURBS_GROUP.some(x => combined.includes(x))) return 'Northern Suburbs';
  if (combined.includes('alexandra')) return 'Alexandra Township';
  if (combined.includes('marlboro')) return 'Marlboro';
  if (combined.includes('wynberg')) return 'Wynberg';
  if (combined.includes('sandton')) return 'Sandton';
  if (combined.includes('kelvin')) return 'Kelvin';
  if (combined.includes('highlands north')) return 'Highlands North';
  if (combined.includes('savoy estate')) return 'Savoy Estate';
  if (combined.includes('edenvale')) return 'Edenvale';
  return l || 'Unknown';
}

function budgetInRange(amount, range) {
  const n = Number(String(amount || "").replace(/[^\d.]/g, ""));
  if (!n || !range) return false;
  const r = String(range).replace(/\s/g, '').toUpperCase();
  if (r === 'R800-R1500' || r === '800-1500') return n >= 800 && n <= 1500;
  if (r === 'R1600-R2500' || r === '1600-2500') return n >= 1600 && n <= 2500;
  if (r === 'R2600-R3500' || r === '2600-3500') return n >= 2600 && n <= 3500;
  if (r === 'R3600-R4500' || r === '3600-4500') return n >= 3600 && n <= 4500;
  if (r === 'R4600-R10000' || r === 'R4600-R8000' || r === '4600-10000' || r === '4600-8000') return n >= 4600 && n <= 10000;
  return false;
}

function locationMatch(landlordLoc, landlordSub, tenantLocations) {
  if (!Array.isArray(tenantLocations) || tenantLocations.length === 0) return false;
  const lg = locationGroup(landlordLoc, landlordSub);
  if (lg === 'Unknown') return false;
  for (const tLoc of tenantLocations) {
    const tg = locationGroup(tLoc, '');
    if (tg === 'Unknown') continue;
    if (tg === lg) return true;
    if (lg === 'Alexandra Township' && (tg === 'Alexandra East' || tg === 'Alexandra Avenues')) return true;
    if (tg === 'Alexandra Township' && (lg === 'Alexandra East' || lg === 'Alexandra Avenues')) return true;
    if (lg === 'Alexandra East' && tg === 'Alexandra Avenues') return true;
    if (lg === 'Alexandra Avenues' && tg === 'Alexandra East') return true;
    if (lg === 'Northern Suburbs' && tg === 'Northern Suburbs') return true;
  }
  return false;
}

// ============ ENDPOINTS ============

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

app.get('/api/public', async (req, res) => {
  try {
    const db = await readDB();
    const rooms = db.rooms.approved.filter(r => r.online !== false).map(room => {
      const imgs = Array.isArray(room.images) ? room.images : [];
      return {
        id: room.id, title: room.title, location: room.location, alexandraSuburb: room.alexandraSuburb || '',
        purpose: room.purpose || 'rent', amount: room.amount, deposit: room.deposit || 'No deposit',
        bedrooms: Number(room.bedrooms) || 1, bathrooms: Number(room.bathrooms) || 1, 
        parkingSpaces: Number(room.maxCars) || (room.parking === 'Yes' ? 1 : 0),
        childFriendly: room.childFriendly === 'Yes' ? 'Yes' : 'No', maxKids: room.maxKids || '0',
        toiletType: room.toiletType || 'Shared', bathroomType: room.bathroomType || 'Shared',
        tiles: room.tiles || 'No', ceiling: room.ceiling || 'No', 
        type: room.type || 'room', // Crucial for filters
        images: imgs,
        mainImage: imgs[0] || '',
        thumbs: imgs.slice(1, 4),
        video: room.video || "",
        notes: room.notes, posterName: room.posterName, posterContact: room.posterContact
      };
    });
    res.json({ 
      rooms, 
      reviews: db.reviews.approved, 
      transports: db.transports.approved, 
      tenantRequests: db.tenantRequests.approved 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const db = await readDB();
    const b = req.body;
    db.rooms.pending.unshift({ 
      id: "post-" + Date.now(), 
      ...b, 
      online: true, 
      status: "pending", 
      createdAt: new Date().toISOString() 
    });
    await writeDB(db);
    res.status(201).json({ ok: true, id: db.rooms.pending[0].id });
  } catch (err) { 
    console.error("Save error:", err);
    res.status(500).json({ error: err.message }); 
  }
});

app.post('/api/tenant-requests', async (req, res) => {
  try {
    const db = await readDB();
    const b = req.body;
    db.tenantRequests.pending.unshift({
      id: "request-" + Date.now(),
      ...b,
      status: "pending",
      createdAt: new Date().toISOString()
    });
    await writeDB(db);
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const db = await readDB(); const b = req.body;
    db.reviews.pending.unshift({
      id: "review-" + Date.now(), ...b, status: "pending", createdAt: new Date().toISOString()
    });
    await writeDB(db); res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reports', async (req, res) => {
  try {
    const db = await readDB(); const b = req.body;
    db.reports.pending.unshift({
      id: "report-" + Date.now(), ...b, status: "pending", createdAt: new Date().toISOString()
    });
    await writeDB(db); res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/transports', async (req, res) => {
  try {
    const db = await readDB(); const b = req.body;
    db.transports.pending.unshift({
      id: "transport-" + Date.now(), ...b, status: "pending", createdAt: new Date().toISOString()
    });
    await writeDB(db); res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contact', async (req, res) => {
  try {
    const db = await readDB(); const b = req.body;
    db.contacts.push({
      id: Date.now(), ...b, date: new Date().toISOString()
    });
    await writeDB(db); res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ ADMIN ROUTES ============

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
    res.json({ ...db, traffic: { today: 0, week: 0, month: 0, total: 0 } });
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
    else if (action === 'toggle-online') {
      const item = db[section][from].find(x => x.id === id);
      if (item) item.online = item.online === false ? true : false;
    }
    else if (action === 'mark-taken') {
      const room = db.rooms.approved.find((e) => e.id === id);
      if (room) {
        db.rooms.approved = db.rooms.approved.filter((e) => e.id !== id);
        db.rooms.taken.unshift({ ...room, status: "taken", takenAt: new Date().toISOString() });
        if(data && data.receipt) db.receipts.unshift({ ...data.receipt, roomId: room.id });
      }
    }
    
    await writeDB(db);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/matches', async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const db = await readDB();
    const landlords = db.rooms.approved.filter(r => r.online !== false);
    const tenants = db.tenantRequests.approved;
    const matches = [];
    
    landlords.forEach(l => {
      tenants.forEach(t => {
        const rMatch = budgetInRange(l.amount, t.budgetRange || t.budget);
        const lMatch = locationMatch(l.location, l.alexandraSuburb, t.preferredLocations);
        if (rMatch && lMatch) {
          matches.push({
            landlordId: l.id, landlordTitle: l.title, landlordLocation: l.location, landlordSuburb: l.alexandraSuburb,
            landlordLocationGroup: locationGroup(l.location, l.alexandraSuburb), landlordRent: l.amount,
            landlordContact: l.posterContact, landlordName: l.posterName, landlordRoomType: l.roomType || l.type,
            landlordTiles: l.tiles, landlordCeiling: l.ceiling, landlordChildFriendly: l.childFriendly, landlordParking: l.parking,
            tenantId: t.id, tenantName: t.tenantName, tenantContact: t.contactNumber,
            tenantLocations: t.preferredLocations || [], tenantBudgetRange: t.budgetRange || t.budget, tenantRoomType: t.roomType
          });
        }
      });
    });
    res.json({ matches });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SERVE PAGES ============

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'), (err) => {
    if (err) {
      console.error("Admin file not found:", err);
      res.status(404).send("<h1>Admin page not found.</h1><p>Make sure admin.html is in the same folder as server.js</p>");
    }
  });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      console.error("Index file not found:", err);
      res.status(404).send("<h1>Website not found.</h1><p>Make sure index.html is in the same folder as server.js</p>");
    }
  });
});

app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server running on port ${PORT}`); });

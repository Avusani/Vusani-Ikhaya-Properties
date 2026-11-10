require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');
const { initLocations, getTree } = require('./locations');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";

// 1. FILE STORAGE
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (err) {} }

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'img-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// 2. DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

// 3. AGENT FEE ENGINE (From your old server)
const RENTAL_FEE_TABLE = [
  { min: 800,   max: 1700,  fee: 300  },
  { min: 1800,  max: 2500,  fee: 350  },
  { min: 2600,  max: 3900,  fee: 400  },
  { min: 4000,  max: 6000,  fee: 500  },
  { min: 6100,  max: 7900,  fee: 700  },
  { min: 8000,  max: 15000, fee: 1500 },
];
const SALE_FEE_RATE = 0.12;
const NON_ALEX_SURCHARGE = 100;

const ALEXANDRA_TOWNSHIP_TOKENS = [
  'alexandra', 'alex', 'east bank', 'far east bank', 'tsutsumane',
  'river park', 'riverpark', '1st avenue', '2nd avenue', '3rd avenue',
  '4th avenue', '5th avenue', '6th avenue', '7th avenue', '8th avenue',
  '9th avenue', '10th avenue', '11th avenue', '12th avenue',
  '13th avenue', '14th avenue', '15th avenue', '16th avenue',
  '17th avenue', '18th avenue', '19th avenue', '20th avenue',
  '21st avenue', '22nd avenue', 'ext 7', 'ext7', 'ext 8', 'ext8', 'ext 9', 'ext9',
];

function isAlexandraTownship(location, suburb) {
  const blob = (String(location || '') + ' ' + String(suburb || '')).toLowerCase();
  return ALEXANDRA_TOWNSHIP_TOKENS.some(t => blob.includes(t));
}
function parseAmount(v) { return Number(String(v || '').replace(/[^\d.]/g, '')) || 0; }

function calculateAgentFee({ amount, purpose, location, alexandraSuburb }) {
  const amt = parseAmount(amount);
  const inAlex = isAlexandraTownship(location, alexandraSuburb);
  const surcharge = inAlex ? 0 : NON_ALEX_SURCHARGE;
  const p = String(purpose || 'rent').toLowerCase();
  const isSale = p === 'sale' || p === 'buy' || p === 'sell';

  if (isSale) {
    const base = Math.round(amt * SALE_FEE_RATE);
    return { kind: 'sale', base, surcharge, total: base + surcharge, inAlexandra: inAlex, manual: false,
             breakdown: `12% of R${amt.toLocaleString('en-ZA')} = R${base.toLocaleString('en-ZA')}` };
  }
  let base = 0, matchedRange = null;
  for (const row of RENTAL_FEE_TABLE) {
    if (amt >= row.min && amt <= row.max) { base = row.fee; matchedRange = `R${row.min}–R${row.max}`; break; }
  }
  if (!base) {
    if (amt > 0 && amt < 800) base = RENTAL_FEE_TABLE[0].fee;
    else if (amt > 15000) base = RENTAL_FEE_TABLE[RENTAL_FEE_TABLE.length - 1].fee;
  }
  return { kind: 'rent', base, surcharge, total: base + surcharge, inAlexandra: inAlex, manual: false,
           breakdown: matchedRange ? `Rent ${matchedRange} → R${base} fee` : `R${base} fee` };
}

function resolveAgentFee(room) {
  const override = Number(room.agentFeeOverride);
  if (Number.isFinite(override) && override > 0) {
    const auto = calculateAgentFee(room);
    return { kind: auto.kind, base: override, surcharge: 0, total: override, inAlexandra: auto.inAlexandra, manual: true,
             breakdown: `MANUAL override — R${override.toLocaleString('en-ZA')}` };
  }
  return calculateAgentFee(room);
}
function withFee(room) { return { ...room, agentFee: resolveAgentFee(room) }; }

// 4. DB INIT & LOCATIONS
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS app_state (id VARCHAR(50) PRIMARY KEY, data JSONB NOT NULL);`);
    await client.query(`CREATE TABLE IF NOT EXISTS financial_ledger (id SERIAL PRIMARY KEY, room_id VARCHAR(80), kind VARCHAR(20), amount NUMERIC(12,2), fee_base NUMERIC(12,2), surcharge NUMERIC(12,2), fee_total NUMERIC(12,2), in_alexandra BOOLEAN, location VARCHAR(200), suburb VARCHAR(200), event VARCHAR(40), manual BOOLEAN DEFAULT FALSE, actor VARCHAR(80), created_at TIMESTAMPTZ DEFAULT NOW());`);
    await client.query(`ALTER TABLE financial_ledger ADD COLUMN IF NOT EXISTS manual BOOLEAN DEFAULT FALSE;`);
    await client.query(`CREATE TABLE IF NOT EXISTS admin_audit (id SERIAL PRIMARY KEY, actor VARCHAR(80), action VARCHAR(120), detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    
    const res = await client.query('SELECT * FROM app_state WHERE id = $1', ['main_db']);
    if (res.rowCount === 0) {
      const defaultDB = { rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] }, reviews: { pending: [], approved: [], declined: [] }, reports: { pending: [], approved: [], declined: [] }, transports: { pending: [], approved: [], declined: [], removed: [] }, tenantRequests: { pending: [], approved: [], declined: [], removed: [] }, receipts: [], contacts: [] };
      await client.query('INSERT INTO app_state (id, data) VALUES ($1, $2)', ['main_db', defaultDB]);
    }
  } finally { client.release(); }
}

async function readDB() { const res = await pool.query('SELECT data FROM app_state WHERE id = $1', ['main_db']); return res.rows[0].data; }
async function writeDB(db) { await pool.query('UPDATE app_state SET data = $1 WHERE id = $2', [db, 'main_db']); }
async function audit(actor, action, detail) { try { await pool.query('INSERT INTO admin_audit (actor, action, detail) VALUES ($1,$2,$3)', [actor || 'admin', action, detail || '']); } catch (_) {} }

initDB().catch(err => console.error('DB init failed:', err.message));
initLocations(pool).catch(err => console.error('Locations init failed:', err.message));

// 5. UPLOADS
app.post('/api/upload', upload.array('images'), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
  res.json({ success: true, urls: req.files.map(f => `/uploads/${f.filename}`) });
});

// 6. PUBLIC ENDPOINTS
app.get('/api/locations', async (req, res) => {
  try { res.json({ locations: await getTree(pool) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/public', async (req, res) => {
  try {
    const db = await readDB();
    const rooms = db.rooms.approved
      .filter(r => r.online !== false)
      .map(room => ({
        id: room.id, title: room.title, location: room.location, mainLocation: room.mainLocation || '', sublocation: room.sublocation || room.alexandraSuburb || '', alexandraSuburb: room.alexandraSuburb || '', purpose: room.purpose || 'rent', amount: room.amount, deposit: room.deposit || 'No deposit', bedrooms: Number(room.bedrooms) || 1, bathrooms: Number(room.bathrooms) || 1, parkingSpaces: Number(room.maxCars) || (room.parking === 'Yes' ? 1 : 0), childFriendly: room.childFriendly === 'Yes' ? 'Yes' : 'No', maxKids: room.maxKids || '0', toiletType: room.toiletType || 'Shared', bathroomType: room.bathroomType || 'Shared', tiles: room.tiles || 'No', ceiling: room.ceiling || 'No', type: room.type || 'room', images: Array.isArray(room.images) ? room.images : [], video: room.video || '', notes: room.notes, posterName: room.posterName, posterContact: room.posterContact, mapLat: room.mapLat ?? null, mapLng: room.mapLng ?? null, mapLabel: room.mapLabel || '', kitchenType: room.kitchenType, furniture: room.furniture, wardrobe: room.wardrobe, kitchenUnit: room.kitchenUnit, petsFriendly: room.petsFriendly
      }));
    res.json({ rooms, reviews: db.reviews.approved, transports: db.transports.approved, tenantRequests: db.tenantRequests.approved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const db = await readDB();
    const room = { id: 'post-' + Date.now(), ...req.body, online: true, status: 'pending', createdAt: new Date().toISOString() };
    room.agentFeeSnapshot = calculateAgentFee(room);
    db.rooms.pending.unshift(room);
    await writeDB(db);
    res.status(201).json({ ok: true, id: room.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. AUTH
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  req.actor = 'admin'; next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect credentials' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  audit('admin', 'login', 'Admin logged in');
  res.json({ token, success: true });
});

// 8. ADMIN DATA
app.get('/api/admin/data', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const enriched = {};
    for (const key of Object.keys(db.rooms)) enriched[key] = (db.rooms[key] || []).map(withFee);
    db.rooms = enriched;

    const feeTotals = { rent: 0, sale: 0, surcharges: 0, manual: 0, grand: 0, byStatus: {} };
    for (const status of Object.keys(enriched)) {
      let statusTotal = 0;
      for (const r of enriched[status]) {
        if (r.agentFee.manual) feeTotals.manual += r.agentFee.total;
        else { feeTotals[r.agentFee.kind] += r.agentFee.base; feeTotals.surcharges += r.agentFee.surcharge; }
        feeTotals.grand += r.agentFee.total; statusTotal += r.agentFee.total;
      }
      feeTotals.byStatus[status] = statusTotal;
    }

    const ledger = await pool.query(`SELECT * FROM financial_ledger ORDER BY created_at DESC LIMIT 500`);
    const auditRows = await pool.query(`SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT 200`);

    res.json({ ...db, feeTotals, ledger: ledger.rows, auditTrail: auditRows.rows, feeConfig: { rentalTable: RENTAL_FEE_TABLE, saleRate: SALE_FEE_RATE, nonAlexSurcharge: NON_ALEX_SURCHARGE } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 9. ADMIN ACTIONS
app.post('/api/admin/action', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const { action, section, from, to, id, data } = req.body;

    if (action === 'move') {
      const item = db[section][from].find(x => x.id === id);
      if (item) {
        db[section][from] = db[section][from].filter(x => x.id !== id);
        const fresh = { ...item, status: to, updatedAt: new Date().toISOString() };
        fresh.agentFeeSnapshot = resolveAgentFee(fresh);
        db[section][to].unshift(fresh);

        if (section === 'rooms' && to === 'approved') {
          const f = fresh.agentFeeSnapshot;
          await pool.query(`INSERT INTO financial_ledger (room_id, kind, amount, fee_base, surcharge, fee_total, in_alexandra, location, suburb, event, manual, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [fresh.id, f.kind, parseAmount(fresh.amount), f.base, f.surcharge, f.total, f.inAlexandra, fresh.location || '', fresh.alexandraSuburb || '', 'approved', !!f.manual, req.actor]);
          audit(req.actor, 'approve-room', `${fresh.id} → fee R${f.total}`);
        }
      }
    }
    else if (action === 'edit') {
      const i = db[section][from].findIndex(x => x.id === id);
      if (i !== -1) {
        const merged = { ...db[section][from][i], ...data, updatedAt: new Date().toISOString() };
        if (Object.prototype.hasOwnProperty.call(data, 'agentFeeOverride')) {
          const n = Number(data.agentFeeOverride);
          if (Number.isFinite(n) && n > 0) merged.agentFeeOverride = n; else delete merged.agentFeeOverride;
        }
        merged.agentFeeSnapshot = resolveAgentFee(merged);
        db[section][from][i] = merged;
        audit(req.actor, 'edit-room', `${id} → updated`);
      }
    }
    else if (action === 'delete') {
      db[section][from] = db[section][from].filter(x => x.id !== id);
      audit(req.actor, 'delete-room', `${id} from ${from}`);
    }
    
    await writeDB(db);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 10. STATIC ROUTES
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";

// ==========================================
// 1. FILE STORAGE SETUP
// ==========================================
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (err) {}
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'img-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ==========================================
// 2. DATABASE SETUP
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

// ==========================================
// 3. AGENT FEE ENGINE  (single source of truth)
// ==========================================
const RENTAL_FEE_TABLE = [
  { min: 800,  max: 1700,  fee: 300  },
  { min: 1800, max: 2500,  fee: 350  },
  { min: 2600, max: 3900,  fee: 400  },
  { min: 4000, max: 6000,  fee: 500  },
  { min: 6100, max: 7900,  fee: 700  },
  { min: 8000, max: 15000, fee: 1500 },
];
const SALE_FEE_RATE = 0.12;
const NON_ALEX_SURCHARGE = 100;

// Detect whether a listing is inside Alexandra Township proper.
// East Bank / Avenues / Tsutsumane / River Park are "Alexandra" for the
// surcharge rule — the user asked for "besides Alexandra Township" to pay extra,
// and those areas are part of Alexandra Township.
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

function parseAmount(v) {
  return Number(String(v || '').replace(/[^\d.]/g, '')) || 0;
}

/**
 * Calculates the agent fee for a listing.
 * Returns { base, surcharge, total, kind, inAlexandra, breakdown }
 * - kind: 'rent' | 'sale' | 'unknown'
 * - Never double-applies: `total` is always base + surcharge computed fresh.
 */
function calculateAgentFee({ amount, purpose, location, alexandraSuburb }) {
  const amt = parseAmount(amount);
  const inAlex = isAlexandraTownship(location, alexandraSuburb);
  const surcharge = inAlex ? 0 : NON_ALEX_SURCHARGE;
  const isSale = String(purpose || 'rent').toLowerCase() === 'sale' ||
                 String(purpose || 'rent').toLowerCase() === 'buy' ||
                 String(purpose || 'rent').toLowerCase() === 'sell';

  if (isSale) {
    const base = Math.round(amt * SALE_FEE_RATE);
    return {
      kind: 'sale',
      base,
      surcharge,
      total: base + surcharge,
      inAlexandra: inAlex,
      breakdown: `12% of R${amt.toLocaleString('en-ZA')} (R${base.toLocaleString('en-ZA')})` +
                 (surcharge ? ` + R${surcharge} location surcharge` : '')
    };
  }

  // Rental lookup
  let base = 0;
  let matchedRange = null;
  for (const row of RENTAL_FEE_TABLE) {
    if (amt >= row.min && amt <= row.max) {
      base = row.fee;
      matchedRange = `R${row.min.toLocaleString('en-ZA')}–R${row.max.toLocaleString('en-ZA')}`;
      break;
    }
  }
  if (!base) {
    // Out-of-range: fall back to nearest bucket so we never silently return 0
    if (amt > 0 && amt < 800)         base = RENTAL_FEE_TABLE[0].fee;
    else if (amt > 15000)             base = RENTAL_FEE_TABLE[RENTAL_FEE_TABLE.length - 1].fee;
  }

  return {
    kind: 'rent',
    base,
    surcharge,
    total: base + surcharge,
    inAlexandra: inAlex,
    breakdown: matchedRange
      ? `Rent ${matchedRange} → R${base} fee` + (surcharge ? ` + R${surcharge} location surcharge` : '')
      : `R${base} fee` + (surcharge ? ` + R${surcharge} location surcharge` : '')
  };
}

// Attach fee fields to any room object, without mutating the stored record.
function withFee(room) {
  const fee = calculateAgentFee({
    amount: room.amount,
    purpose: room.purpose,
    location: room.location,
    alexandraSuburb: room.alexandraSuburb,
  });
  return { ...room, agentFee: fee };
}

// ==========================================
// 4. DB INIT
// ==========================================
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS financial_ledger (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(80),
        kind VARCHAR(20),          -- 'rent' | 'sale'
        amount NUMERIC(12,2),      -- listing amount
        fee_base NUMERIC(12,2),
        surcharge NUMERIC(12,2),
        fee_total NUMERIC(12,2),
        in_alexandra BOOLEAN,
        location VARCHAR(200),
        suburb VARCHAR(200),
        event VARCHAR(40),         -- 'approved' | 'reposted' | 'adjusted'
        actor VARCHAR(80),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit (
        id SERIAL PRIMARY KEY,
        actor VARCHAR(80),
        action VARCHAR(120),
        detail TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
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
  } finally { client.release(); }
}

async function readDB() {
  const res = await pool.query('SELECT data FROM app_state WHERE id = $1', ['main_db']);
  return res.rows[0].data;
}
async function writeDB(db) {
  await pool.query('UPDATE app_state SET data = $1 WHERE id = $2', [db, 'main_db']);
}
async function audit(actor, action, detail) {
  try { await pool.query('INSERT INTO admin_audit (actor, action, detail) VALUES ($1,$2,$3)',
    [actor || 'admin', action, detail || '']); } catch (_) {}
}

initDB().catch(err => console.error('DB init failed:', err.message));

// ==========================================
// 5. UPLOADS
// ==========================================
app.post('/api/upload', upload.array('images'), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
  res.json({ success: true, urls: req.files.map(f => `/uploads/${f.filename}`) });
});
app.post('/api/admin/upload', upload.array('images'), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
  res.json({ success: true, urls: req.files.map(f => `/uploads/${f.filename}`) });
});

// ==========================================
// 6. PUBLIC ENDPOINTS
// ==========================================
app.get('/api/public', async (req, res) => {
  try {
    const db = await readDB();
    const rooms = db.rooms.approved
      .filter(r => r.online !== false)
      .map(room => {
        const withFeeRoom = withFee(room);
        return {
          id: room.id,
          title: room.title,
          location: room.location,
          alexandraSuburb: room.alexandraSuburb || '',
          purpose: room.purpose || 'rent',
          amount: room.amount,
          deposit: room.deposit || 'No deposit',
          bedrooms: Number(room.bedrooms) || 1,
          bathrooms: Number(room.bathrooms) || 1,
          parkingSpaces: Number(room.maxCars) || (room.parking === 'Yes' ? 1 : 0),
          childFriendly: room.childFriendly === 'Yes' ? 'Yes' : 'No',
          maxKids: room.maxKids || '0',
          toiletType: room.toiletType || 'Shared',
          bathroomType: room.bathroomType || 'Shared',
          tiles: room.tiles || 'No',
          ceiling: room.ceiling || 'No',
          type: room.type || 'room',
          images: Array.isArray(room.images) ? room.images : [],
          mainImage: (room.images || [])[0] || '',
          thumbs: (room.images || []).slice(1, 4),
          video: room.video || '',
          notes: room.notes,
          posterName: room.posterName,
          posterContact: room.posterContact,
          agentFee: withFeeRoom.agentFee,   // <-- always server-computed
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
    const room = {
      id: 'post-' + Date.now(),
      ...req.body,
      online: true,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    // Stamp the fee at submission time — recomputable, never trusted blindly.
    room.agentFeeSnapshot = calculateAgentFee(room);
    db.rooms.pending.unshift(room);
    await writeDB(db);
    res.status(201).json({ ok: true, id: room.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tenant-requests', async (req, res) => {
  try {
    const db = await readDB();
    db.tenantRequests.pending.unshift({ id: 'request-' + Date.now(), ...req.body, status: 'pending', createdAt: new Date().toISOString() });
    await writeDB(db);
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const db = await readDB();
    db.reviews.pending.unshift({ id: 'review-' + Date.now(), ...req.body, status: 'pending', createdAt: new Date().toISOString() });
    await writeDB(db);
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reports', async (req, res) => {
  try {
    const db = await readDB();
    db.reports.pending.unshift({ id: 'report-' + Date.now(), ...req.body, status: 'pending', createdAt: new Date().toISOString() });
    await writeDB(db);
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/transports', async (req, res) => {
  try {
    const db = await readDB();
    db.transports.pending.unshift({ id: 'transport-' + Date.now(), ...req.body, status: 'pending', createdAt: new Date().toISOString() });
    await writeDB(db);
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contact', async (req, res) => {
  try {
    const db = await readDB();
    db.contacts.push({ id: Date.now(), ...req.body, date: new Date().toISOString() });
    await writeDB(db);
    res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 7. ADMIN AUTH
// ==========================================
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  req.actor = 'admin';
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  audit('admin', 'login', 'Admin logged in');
  res.json({ token, success: true });
});

// ==========================================
// 8. ADMIN DATA (all rooms have live fee)
// ==========================================
app.get('/api/admin/data', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const enriched = {};
    for (const key of Object.keys(db.rooms)) {
      enriched[key] = (db.rooms[key] || []).map(withFee);
    }
    db.rooms = enriched;

    // Live fee totals across the whole system
    const feeTotals = { rent: 0, sale: 0, surcharges: 0, grand: 0, byStatus: {} };
    for (const status of Object.keys(enriched)) {
      let statusTotal = 0;
      for (const r of enriched[status]) {
        feeTotals[r.agentFee.kind] += r.agentFee.base;
        feeTotals.surcharges += r.agentFee.surcharge;
        feeTotals.grand     += r.agentFee.total;
        statusTotal         += r.agentFee.total;
      }
      feeTotals.byStatus[status] = statusTotal;
    }

    // Financial ledger (approved fee events)
    const ledger = await pool.query(
      `SELECT * FROM financial_ledger ORDER BY created_at DESC LIMIT 500`
    );

    // Audit trail
    const auditRows = await pool.query(
      `SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT 200`
    );

    res.json({
      ...db,
      feeTotals,
      ledger: ledger.rows,
      auditTrail: auditRows.rows,
      feeConfig: {
        rentalTable: RENTAL_FEE_TABLE,
        saleRate: SALE_FEE_RATE,
        nonAlexSurcharge: NON_ALEX_SURCHARGE,
      },
      traffic: { today: 0, week: 0, month: 0, total: 0 },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 9. ADMIN ACTIONS
// ==========================================
app.post('/api/admin/action', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const { action, section, from, to, id, data } = req.body;

    if (action === 'move') {
      const item = db[section][from].find(x => x.id === id);
      if (item) {
        db[section][from] = db[section][from].filter(x => x.id !== id);
        const fresh = { ...item, status: to, updatedAt: new Date().toISOString() };
        fresh.agentFeeSnapshot = calculateAgentFee(fresh); // recompute on move
        db[section][to].unshift(fresh);

        // When a room is approved, freeze the fee into the financial ledger.
        if (section === 'rooms' && to === 'approved') {
          const f = fresh.agentFeeSnapshot;
          await pool.query(
            `INSERT INTO financial_ledger
              (room_id, kind, amount, fee_base, surcharge, fee_total, in_alexandra, location, suburb, event, actor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [fresh.id, f.kind, parseAmount(fresh.amount), f.base, f.surcharge, f.total,
             f.inAlexandra, fresh.location || '', fresh.alexandraSuburb || '', 'approved', req.actor]
          );
          audit(req.actor, 'approve-room', `${fresh.id} → fee R${f.total} (base R${f.base} + surcharge R${f.surcharge})`);
        }
        if (section === 'rooms' && from === 'approved' && to !== 'approved') {
          audit(req.actor, 'unapprove-room', `${fresh.id} → ${to}`);
        }
      }
    }
    else if (action === 'edit') {
      const i = db[section][from].findIndex(x => x.id === id);
      if (i !== -1) {
        const merged = { ...db[section][from][i], ...data, updatedAt: new Date().toISOString() };
        merged.agentFeeSnapshot = calculateAgentFee(merged); // recompute after edit
        db[section][from][i] = merged;
        audit(req.actor, 'edit-room', `${id} → fee R${merged.agentFeeSnapshot.total}`);
      }
    }
    else if (action === 'delete') {
      db[section][from] = db[section][from].filter(x => x.id !== id);
      audit(req.actor, 'delete-room', `${id} from ${from}`);
    }
    else if (action === 'toggle-online') {
      const item = db[section][from].find(x => x.id === id);
      if (item) item.online = item.online === false ? true : false;
    }
    else if (action === 'add-images') {
      const item = db[section][from].find(x => x.id === id);
      if (item) {
        if (!item.images) item.images = [];
        item.images.push(...data.images);
      }
    }
    else if (action === 'remove-image') {
      const item = db[section][from].find(x => x.id === id);
      if (item && item.images) item.images = item.images.filter((_, i) => i !== data.index);
    }
    else if (action === 'fee-preview') {
      // used by the edit modal to show the live fee while typing
      const fee = calculateAgentFee({
        amount: data.amount, purpose: data.purpose,
        location: data.location, alexandraSuburb: data.alexandraSuburb,
      });
      await writeDB(db);
      return res.json({ ok: true, fee });
    }

    await writeDB(db);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fee preview endpoint (no auth needed for server-side consistency check)
app.post('/api/fee-preview', (req, res) => {
  try {
    const fee = calculateAgentFee(req.body || {});
    res.json({ fee });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ==========================================
// 10. FINANCIAL LEDGER / REPORTS
// ==========================================
app.get('/api/admin/ledger', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = `SELECT * FROM financial_ledger`;
    const params = [];
    if (from && to) {
      q += ` WHERE created_at >= $1 AND created_at <= $2`;
      params.push(from, to);
    }
    q += ` ORDER BY created_at DESC`;
    const r = await pool.query(q, params);
    res.json({ ledger: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/ledger.csv', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM financial_ledger ORDER BY created_at DESC`);
    const headers = ['id','room_id','kind','amount','fee_base','surcharge','fee_total','in_alexandra','location','suburb','event','actor','created_at'];
    const lines = [headers.join(',')];
    for (const row of r.rows) {
      lines.push(headers.map(h => {
        const v = row[h];
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="ledger.csv"');
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 11. RESET (admin-only, audited)
// ==========================================
app.get('/api/admin/reset-everything', requireAuth, async (req, res) => {
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
    await pool.query('DELETE FROM financial_ledger');
    audit(req.actor, 'reset-everything', 'All data wiped');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 12. STATIC ROUTES
// ==========================================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));

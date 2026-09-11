const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";
const SESSION_KEY = process.env.SESSION_KEY || "mySuperSecretSessionKey12345";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "database");
const DB_FILE = path.join(DATA_DIR, "db.json");
const TRAFFIC_FILE = path.join(DATA_DIR, "traffic.json");
const sessions = new Map();
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

const defaultDB = {
  rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] },
  reviews: { pending: [], approved: [], declined: [] },
  reports: { pending: [], approved: [], declined: [] },
  transports: { pending: [], approved: [], declined: [], removed: [] },
  tenantRequests: { pending: [], approved: [], declined: [], removed: [] },
  receipts: [],
  contacts: []
};

app.use(cors());
app.use(express.json({ limit: '80mb' }));

// =========================================================
// VISITOR TRACKING MIDDLEWARE (runs before static serving)
// =========================================================
app.use((req, res, next) => {
  try {
    const isPublicPage =
      req.method === 'GET' &&
      !req.path.startsWith('/api/') &&
      !req.path.startsWith('/admin') &&
      !req.path.startsWith('/database/') &&
      !req.path.startsWith('/favicon') &&
      !/\.[a-z0-9]+$/i.test(req.path); // skip files with extensions (.png, .css, .js)
    if (isPublicPage) recordVisit(req);
  } catch (e) { /* never block */ }
  next();
});

app.use(express.static(ROOT));

// =========================================================
// DATABASE HELPERS
// =========================================================
function normalizeSection(section, defaults) {
  const source = section && typeof section === "object" && !Array.isArray(section) ? section : {};
  return Object.fromEntries(
    Object.keys(defaults).map((status) => [status, Array.isArray(source[status]) ? source[status] : []])
  );
}

function normalizeDB(db) {
  db = db || {};
  db.rooms = normalizeSection(db.rooms, defaultDB.rooms);
  db.reviews = normalizeSection(db.reviews, defaultDB.reviews);
  db.reports = normalizeSection(db.reports, defaultDB.reports);
  db.transports = normalizeSection(db.transports, defaultDB.transports);
  db.tenantRequests = normalizeSection(db.tenantRequests, defaultDB.tenantRequests);
  db.receipts = Array.isArray(db.receipts) ? db.receipts : [];
  db.contacts = Array.isArray(db.contacts) ? db.contacts : [];
  return db;
}

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) { fs.mkdirSync(DATA_DIR, { recursive: true }); console.log('📁 Database directory created'); }
  if (!fs.existsSync(DB_FILE)) { writeDB(defaultDB); console.log('📁 New database created'); }
  if (!fs.existsSync(TRAFFIC_FILE)) { writeTraffic({ days: {}, totalUniqueVisitors: 0, totalPageviews: 0 }); console.log('📁 New traffic file created'); }
}

function readDB() {
  ensureDB();
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, "");
    const parsed = raw.trim() ? JSON.parse(raw) : defaultDB;
    return normalizeDB(parsed);
  } catch (error) {
    console.error('❌ Failed to read database:', error.message);
    const restored = restoreFromBackup();
    if (restored) return readDB();
    return defaultDB;
  }
}

function writeDB(db) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    backupDB();
    const tempFile = DB_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(normalizeDB(db), null, 2));
    fs.renameSync(tempFile, DB_FILE);
    return true;
  } catch (error) { console.error('❌ Failed to write database:', error.message); return false; }
}

function backupDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const backupFile = path.join(DATA_DIR, `db.backup.${Date.now()}.json`);
      fs.copyFileSync(DB_FILE, backupFile);
      const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('db.backup.')).sort();
      while (backups.length > 5) fs.unlinkSync(path.join(DATA_DIR, backups.shift()));
    }
  } catch (error) { console.log('⚠️ Backup failed:', error.message); }
}

function restoreFromBackup() {
  try {
    const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('db.backup.')).sort();
    if (backups.length === 0) return false;
    const latest = backups[backups.length - 1];
    const data = fs.readFileSync(path.join(DATA_DIR, latest), 'utf8');
    fs.writeFileSync(DB_FILE, JSON.stringify(JSON.parse(data), null, 2));
    console.log(`✅ Restored from backup: ${latest}`);
    return true;
  } catch (error) { console.log('⚠️ Restore failed:', error.message); return false; }
}

function clearAllData() { backupDB(); writeDB(defaultDB); return true; }

// =========================================================
// VISITOR TRACKING
// =========================================================
function readTraffic() {
  try {
    if (!fs.existsSync(TRAFFIC_FILE)) {
      return { days: {}, totalUniqueVisitors: 0, totalPageviews: 0 };
    }
    const raw = fs.readFileSync(TRAFFIC_FILE, "utf8").replace(/^\uFEFF/, "");
    const parsed = raw.trim() ? JSON.parse(raw) : { days: {}, totalUniqueVisitors: 0, totalPageviews: 0 };
    if (!parsed.days) parsed.days = {};
    return parsed;
  } catch (e) {
    return { days: {}, totalUniqueVisitors: 0, totalPageviews: 0 };
  }
}

function writeTraffic(t) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(t, null, 2));
  } catch (e) { console.error('⚠️ Traffic write failed:', e.message); }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function isBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return true;
  const bots = ['bot', 'crawl', 'spider', 'slurp', 'facebookexternalhit', 'whatsapp', 'telegrambot', 'preview', 'curl', 'wget', 'python-requests', 'python-urllib', 'java/', 'monitoring', 'uptime', 'pingdom', 'ahrefs', 'semrush', 'mj12', 'dotbot', 'petal', 'yandex', 'baidu', 'googlebot', 'bingbot', 'duckduckbot', 'headlesschrome', 'phantomjs', 'lighthouse'];
  return bots.some(b => ua.includes(b));
}

function getVisitorID(req) {
  const ip = getClientIP(req);
  const ua = String(req.headers['user-agent'] || '');
  return crypto.createHash('md5').update(ip + '|' + ua).digest('hex').slice(0, 16);
}

function recordVisit(req) {
  try {
    if (isBot(req)) return;
    const t = readTraffic();
    const today = todayKey();
    if (!t.days[today]) t.days[today] = { pageviews: 0, visitors: {} };
    t.days[today].pageviews += 1;
    const vid = getVisitorID(req);
    if (!t.days[today].visitors[vid]) {
      t.days[today].visitors[vid] = 1;
      t.totalUniqueVisitors = (t.totalUniqueVisitors || 0) + 1;
    } else {
      t.days[today].visitors[vid] += 1;
    }
    t.totalPageviews = (t.totalPageviews || 0) + 1;

    // Keep last 365 days
    const keys = Object.keys(t.days).sort();
    while (keys.length > 365) delete t.days[keys.shift()];

    writeTraffic(t);
  } catch (e) { /* silently fail */ }
}

function trafficSummary() {
  const t = readTraffic();
  const today = todayKey();
  const todayData = t.days[today] || { pageviews: 0, visitors: {} };

  // This week — last 7 days including today
  const weekVisitors = {};
  let weekPageviews = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = t.days[k];
    if (day) {
      weekPageviews += day.pageviews || 0;
      Object.keys(day.visitors || {}).forEach(v => { weekVisitors[v] = true; });
    }
  }

  // This month
  const monthVisitors = {};
  let monthPageviews = 0;
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  Object.keys(t.days).forEach(k => {
    if (k.startsWith(monthPrefix)) {
      const day = t.days[k];
      monthPageviews += day.pageviews || 0;
      Object.keys(day.visitors || {}).forEach(v => { monthVisitors[v] = true; });
    }
  });

  // Previous 7 days for % change
  const prevWeekVisitors = {};
  for (let i = 7; i < 14; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = t.days[k];
    if (day) Object.keys(day.visitors || {}).forEach(v => { prevWeekVisitors[v] = true; });
  }

  const todayCount = Object.keys(todayData.visitors || {}).length;
  const weekCount = Object.keys(weekVisitors).length;
  const monthCount = Object.keys(monthVisitors).length;
  const prevWeekCount = Object.keys(prevWeekVisitors).length;
  const weekChange = prevWeekCount ? Math.round(((weekCount - prevWeekCount) / prevWeekCount) * 100) : 0;

  // Last 7 days chart data
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = t.days[k] || { pageviews: 0, visitors: {} };
    last7Days.push({
      date: k,
      visitors: Object.keys(day.visitors || {}).length,
      pageviews: day.pageviews || 0
    });
  }

  return {
    today: todayCount,
    todayPageviews: todayData.pageviews || 0,
    week: weekCount,
    weekPageviews: weekPageviews,
    weekChange: weekChange,
    month: monthCount,
    monthPageviews: monthPageviews,
    total: t.totalUniqueVisitors || 0,
    totalPageviews: t.totalPageviews || 0,
    last7Days: last7Days
  };
}

// =========================================================
// GENERAL HELPERS
// =========================================================
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function sendMedia(res, src) {
  if (!src) return send(res, 404, { error: "Media not found" });
  if (/^https?:\/\//i.test(src)) { res.writeHead(302, { Location: src, "Cache-Control": "no-store" }); res.end(); return; }
  const match = String(src).match(/^data:((?:image|video)\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return send(res, 404, { error: "Media not found" });
  res.writeHead(200, { "Content-Type": match[1], "Cache-Control": "public, max-age=3600" });
  res.end(Buffer.from(match[2], "base64"));
}

function encodePart(v) { return encodeURIComponent(String(v || "")); }
function cleanText(v, max = 600) { return String(v || "").trim().slice(0, max); }
function cleanImages(images) { return Array.isArray(images) ? images.filter((s) => typeof s === "string" && /^(data:image\/|https?:\/\/)/i.test(s)).slice(0, 5) : []; }
function cleanVideo(video) { return typeof video === "string" && /^(data:video\/|https?:\/\/)/i.test(video) ? video : ""; }
function moneyNumber(v) { const p = Number(String(v || "").replace(/[^\d.]/g, "")); return Number.isFinite(p) ? p : 0; }

function serviceFeeForRent(rent) {
  const a = moneyNumber(rent);
  if (a >= 1000 && a <= 1900) return 300;
  if (a >= 2000 && a <= 3000) return 350;
  if (a >= 3100 && a <= 3800) return 400;
  if (a >= 3900 && a <= 7000) return 500;
  return 0;
}

function monthKey(dateValue) {
  const v = cleanText(dateValue, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 7);
  const d = v ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function cleanReceipt(details) {
  const rentAmount = cleanText(details?.rentAmount || details?.rentPrice, 40);
  const fee = serviceFeeForRent(rentAmount) || moneyNumber(details?.serviceFee);
  return {
    id: cleanText(details?.id || `ART-${Date.now()}`, 80),
    date: cleanText(details?.date || new Date().toISOString().slice(0, 10), 20),
    tenantName: cleanText(details?.tenantName, 140),
    tenantNumber: cleanText(details?.tenantNumber, 80),
    paymentType: cleanText(details?.paymentType || "Cash", 80),
    roomAddress: cleanText(details?.roomAddress, 220),
    rentAmount,
    depositAmount: cleanText(details?.depositAmount, 80),
    serviceFee: fee,
    serviceFeeText: `R${fee}`,
    month: monthKey(details?.date || new Date().toISOString())
  };
}

// =========================================================
// LOCATION GROUPING
// =========================================================
const ALEXANDRA_EAST_GROUP = [
  'east bank', 'far east bank',
  'ext 7', 'ext7', 'ext 8', 'ext8', 'ext 9', 'ext9',
  'tsutsumane', 'river park', 'river park phase 3'
];

const ALEXANDRA_AVENUES_GROUP = [
  '1st avenue – 12th avenue', '1st avenue - 12th avenue',
  '12th avenue – 22nd avenue', '12th avenue - 22nd avenue',
  '13th avenue – 22nd avenue', '13th avenue - 22nd avenue',
  '1st avenue – 22nd avenue', '1st avenue - 22nd avenue'
];

const NORTHERN_SUBURBS_GROUP = [
  'lombardy', 'bramley', 'kew', 'balfour', 'orange grove'
];

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

function normalizeAlexandraSuburb(value) {
  const v = cleanText(value, 80);
  if (!v) return '';
  const lv = v.toLowerCase();
  if (ALEXANDRA_AVENUES_GROUP.some(x => lv.includes(x))) return 'Alexandra Avenues';
  if (ALEXANDRA_EAST_GROUP.some(x => lv.includes(x))) return 'Alexandra East';
  return v;
}

function publicRoom(room) {
  return {
    ...room,
    images: (room.images || []).map((_, i) => `/api/room-media/${encodePart(room.id)}/image/${i}`),
    video: room.video ? `/api/room-media/${encodePart(room.id)}/video` : ""
  };
}

function publicTransport(d) {
  return {
    id: d.id, firstName: d.firstName, surname: d.surname,
    carPicture: d.carPicture ? `/api/transport-media/${encodePart(d.id)}/carPicture` : "",
    localPrice: d.localPrice, outsidePrice: d.outsidePrice, status: d.status
  };
}

function adminToken(req) {
  const auth = req.headers.authorization || "";
  const headerToken = auth.replace(/^Bearer\s+/i, "");
  if (req.query && req.query.token) return req.query.token;
  return headerToken;
}

function requireAdmin(req, res) {
  const token = adminToken(req);
  if (!token || !sessions.has(token)) { res.status(401).json({ error: "Admin login required" }); return false; }
  const s = sessions.get(token);
  if (s && Date.now() - s.created > SESSION_TIMEOUT) {
    sessions.delete(token);
    res.status(401).json({ error: "Session expired, please login again" });
    return false;
  }
  return token;
}

function adminMediaURL(section, status, id, field, index, token) {
  const base = `/api/admin/media/${encodePart(section)}/${encodePart(status)}/${encodePart(id)}/${encodePart(field)}`;
  const suffix = field === "images" ? `/${index}` : "";
  return `${base}${suffix}?token=${encodePart(token)}`;
}

function adminItem(item, section, status, token) {
  const next = { ...item };
  if (Array.isArray(next.images)) next.images = next.images.map((_, i) => adminMediaURL(section, status, next.id, "images", i, token));
  if (next.video) next.video = adminMediaURL(section, status, next.id, "video", 0, token);
  if (next.carPicture) next.carPicture = adminMediaURL(section, status, next.id, "carPicture", 0, token);
  if (next.idPicture) next.idPicture = adminMediaURL(section, status, next.id, "idPicture", 0, token);
  return next;
}

function adminSection(name, section, token) {
  return Object.fromEntries(
    Object.entries(section).map(([status, list]) => [status, (Array.isArray(list) ? list : []).map((i) => adminItem(i, name, status, token))])
  );
}

function adminDB(db, token) {
  return {
    rooms: adminSection("rooms", db.rooms, token),
    reviews: db.reviews,
    reports: db.reports,
    transports: adminSection("transports", db.transports, token),
    tenantRequests: adminSection("tenantRequests", db.tenantRequests, token),
    receipts: db.receipts,
    contacts: db.contacts
  };
}

function moveItem(db, section, from, to, id) {
  if (!db[section] || !Array.isArray(db[section][from]) || !Array.isArray(db[section][to])) return false;
  const item = db[section][from].find((e) => e.id === id);
  if (!item) return false;
  db[section][from] = db[section][from].filter((e) => e.id !== id);
  db[section][to] = db[section][to].filter((e) => e.id !== id);
  db[section][to].unshift({ ...item, status: to, updatedAt: new Date().toISOString() });
  return true;
}

function deleteItem(db, section, from, id) {
  if (!db[section] || !Array.isArray(db[section][from])) return false;
  const before = db[section][from].length;
  db[section][from] = db[section][from].filter((e) => e.id !== id);
  return db[section][from].length !== before;
}

// =========================================================
// PUBLIC ROUTES
// =========================================================
app.get('/api/public', (req, res) => {
  const db = readDB();
  res.json({
    rooms: db.rooms.approved.map(publicRoom),
    reviews: db.reviews.approved,
    transports: db.transports.approved.map(publicTransport),
    tenantRequests: db.tenantRequests.approved
  });
});

app.get('/api/properties', (req, res) => { res.json(readDB().rooms.approved || []); });

app.get('/api/properties/:id', (req, res) => {
  const p = readDB().rooms.approved.find(p => p.id === req.params.id);
  if (p) res.json(p); else res.status(404).json({ error: 'Property not found' });
});

app.get('/api/room-media/:id/:kind', (req, res) => {
  const r = readDB().rooms.approved.find((e) => e.id === decodeURIComponent(req.params.id || ""));
  if (req.params.kind === "video") return sendMedia(res, r?.video);
  return sendMedia(res, r?.images?.[0]);
});

app.get('/api/room-media/:id/image/:index', (req, res) => {
  const r = readDB().rooms.approved.find((e) => e.id === decodeURIComponent(req.params.id || ""));
  const i = Math.max(0, Number(req.params.index) || 0);
  return sendMedia(res, r?.images?.[i]);
});

app.get('/api/room-media/:id/video', (req, res) => {
  const r = readDB().rooms.approved.find((e) => e.id === decodeURIComponent(req.params.id || ""));
  return sendMedia(res, r?.video);
});

app.get('/api/transport-media/:id/carPicture', (req, res) => {
  const d = readDB().transports.approved.find((e) => e.id === decodeURIComponent(req.params.id || ""));
  return sendMedia(res, d?.carPicture);
});

// ===== POST ROOM =====
app.post('/api/rooms', async (req, res) => {
  const db = readDB();
  const b = req.body;
  db.rooms.pending.unshift({
    id: "post-" + Date.now(),
    title: cleanText(b.title, 120),
    location: cleanText(b.location, 80),
    alexandraSuburb: normalizeAlexandraSuburb(b.alexandraSuburb),
    address: cleanText(b.address, 220),
    type: cleanText(b.type, 40),
    roomType: cleanText(b.roomType || "Any", 40),
    amount: cleanText(b.amount, 40),
    deposit: cleanText(b.deposit || "No deposit stated", 80),
    childFriendly: cleanText(b.childFriendly, 10),
    maxKids: cleanText(b.maxKids, 10),
    parking: cleanText(b.parking, 10),
    maxCars: cleanText(b.maxCars, 10),
    bath: cleanText(b.bath, 120),
    images: cleanImages(b.images),
    video: cleanVideo(b.video),
    posterName: cleanText(b.posterName, 100),
    posterContact: cleanText(b.posterContact, 160),
    notes: cleanText(b.notes, 800),
    online: true,
    status: "pending",
    createdAt: new Date().toISOString()
  });
  writeDB(db);
  res.status(201).json({ ok: true, id: db.rooms.pending[0].id });
});

// ===== POST TENANT =====
app.post('/api/tenant-requests', async (req, res) => {
  const db = readDB();
  const b = req.body;
  const preferredLocations = Array.isArray(b.preferredLocations)
    ? b.preferredLocations.map(l => cleanText(l, 80)).filter(Boolean)
    : [];
  db.tenantRequests.pending.unshift({
    id: "request-" + Date.now(),
    tenantName: cleanText(b.tenantName, 100),
    contactNumber: cleanText(b.contactNumber, 80),
    preferredLocations: preferredLocations,
    alexandraSuburb: cleanText(b.alexandraSuburb, 200),
    roomType: cleanText(b.roomType, 40),
    budget: cleanText(b.budget, 40),
    budgetRange: cleanText(b.budgetRange, 40),
    moveInDate: cleanText(b.moveInDate, 40),
    childFriendly: cleanText(b.childFriendly, 10),
    childrenCount: cleanText(b.childrenCount, 10),
    childrenAges: cleanText(b.childrenAges, 120),
    parking: cleanText(b.parking, 10),
    carsCount: cleanText(b.carsCount, 10),
    notes: cleanText(b.notes, 800),
    status: "pending",
    createdAt: new Date().toISOString()
  });
  writeDB(db);
  res.status(201).json({ ok: true });
});

app.post('/api/reviews', async (req, res) => {
  const db = readDB(); const b = req.body;
  db.reviews.pending.unshift({
    id: "review-" + Date.now(),
    roomId: cleanText(b.roomId, 80),
    roomTitle: cleanText(b.roomTitle, 140),
    name: cleanText(b.name, 100),
    rating: Math.max(1, Math.min(5, Number(b.rating) || 5)),
    comment: cleanText(b.comment, 800),
    status: "pending",
    createdAt: new Date().toISOString()
  });
  writeDB(db); res.status(201).json({ ok: true });
});

app.post('/api/reports', async (req, res) => {
  const db = readDB(); const b = req.body;
  db.reports.pending.unshift({
    id: "report-" + Date.now(),
    room: cleanText(b.room, 180),
    reporterContact: cleanText(b.reporterContact, 160),
    reason: cleanText(b.reason, 1000),
    status: "pending",
    createdAt: new Date().toISOString()
  });
  writeDB(db); res.status(201).json({ ok: true });
});

app.post('/api/transports', async (req, res) => {
  const db = readDB(); const b = req.body;
  db.transports.pending.unshift({
    id: "transport-" + Date.now(),
    firstName: cleanText(b.firstName, 100),
    surname: cleanText(b.surname, 100),
    phone: cleanText(b.phone, 80),
    email: cleanText(b.email, 160),
    carPicture: cleanImages([b.carPicture])[0] || "",
    idPicture: cleanImages([b.idPicture])[0] || "",
    localPrice: cleanText(b.localPrice, 80),
    outsidePrice: cleanText(b.outsidePrice, 80),
    notes: cleanText(b.notes, 800),
    status: "pending",
    createdAt: new Date().toISOString()
  });
  writeDB(db); res.status(201).json({ ok: true });
});

app.post('/api/contact', async (req, res) => {
  const db = readDB(); const b = req.body;
  db.contacts = db.contacts || [];
  db.contacts.push({
    id: Date.now(),
    name: cleanText(b.name, 100),
    email: cleanText(b.email, 160),
    phone: cleanText(b.phone, 80),
    message: cleanText(b.message, 1000),
    date: new Date().toISOString()
  });
  writeDB(db);
  res.status(201).json({ success: true, message: 'Message sent successfully!' });
});

// =========================================================
// ADMIN ROUTES
// =========================================================
app.post('/api/admin/login', async (req, res) => {
  const b = req.body;
  if (b.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Incorrect password" });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now(), expires: Date.now() + SESSION_TIMEOUT });
  res.json({ token, success: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = adminToken(req);
  if (token && sessions.has(token)) sessions.delete(token);
  res.json({ success: true });
});

app.get('/api/admin/check-session', (req, res) => {
  const token = adminToken(req);
  res.json({ valid: token && sessions.has(token) });
});

app.get('/api/admin/data', (req, res) => {
  const token = requireAdmin(req, res); if (!token) return;
  const payload = adminDB(readDB(), token);
  payload.traffic = trafficSummary();
  res.json(payload);
});

app.get('/api/admin/traffic', (req, res) => {
  const token = requireAdmin(req, res); if (!token) return;
  res.json(trafficSummary());
});

app.get('/api/admin/media/:section/:status/:id/:field', (req, res) => {
  const token = requireAdmin(req, res); if (!token) return;
  const db = readDB();
  const list = db[decodeURIComponent(req.params.section || "")]?.[decodeURIComponent(req.params.status || "")] || [];
  const item = list.find((e) => e.id === decodeURIComponent(req.params.id || ""));
  return sendMedia(res, item?.[decodeURIComponent(req.params.field || "")]);
});

app.get('/api/admin/media/:section/:status/:id/images/:index', (req, res) => {
  const token = requireAdmin(req, res); if (!token) return;
  const db = readDB();
  const list = db[decodeURIComponent(req.params.section || "")]?.[decodeURIComponent(req.params.status || "")] || [];
  const item = list.find((e) => e.id === decodeURIComponent(req.params.id || ""));
  const i = Math.max(0, Number(req.params.index) || 0);
  return sendMedia(res, item?.images?.[i]);
});

// =========================================================
// ADMIN ACTION (fixed — every action returns a proper ok/error)
// =========================================================
app.post('/api/admin/action', async (req, res) => {
  const token = requireAdmin(req, res); if (!token) return;
  const db = readDB(); const body = req.body;

  try {
    if (body.action === "move") {
      const ok = moveItem(db, body.section, body.from, body.to, body.id);
      if (!ok) return res.status(400).json({ ok: false, error: "Item not found or invalid section" });
    }

    if (body.action === "edit") {
      const section = db[body.section];
      if (section && Array.isArray(section[body.from])) {
        const i = section[body.from].findIndex(e => e.id === body.id);
        if (i === -1) return res.status(404).json({ ok: false, error: "Item not found" });
        const cur = section[body.from][i];
        const u = body.data || {};
        section[body.from][i] = {
          ...cur,
          title: cleanText(u.title || cur.title, 120),
          location: cleanText(u.location || cur.location, 80),
          address: cleanText(u.address || cur.address, 220),
          amount: cleanText(u.amount || cur.amount, 40),
          deposit: cleanText(u.deposit || cur.deposit, 80),
          posterName: cleanText(u.posterName || cur.posterName, 100),
          posterContact: cleanText(u.posterContact || cur.posterContact, 160),
          notes: cleanText(u.notes || cur.notes, 800),
          tenantName: cleanText(u.tenantName || cur.tenantName, 100),
          contactNumber: cleanText(u.contactNumber || cur.contactNumber, 80),
          roomType: cleanText(u.roomType || cur.roomType, 40),
          budgetRange: cleanText(u.budgetRange || cur.budgetRange, 40),
          budget: cleanText(u.budget || cur.budget, 40),
          updatedAt: new Date().toISOString()
        };
      }
    }

    if (body.action === "mark-taken") {
      const room = db.rooms.approved.find((e) => e.id === body.id);
      if (!room) return res.status(404).json({ ok: false, error: "Room not found in approved" });
      const receipt = cleanReceipt({
        ...(body.receipt || {}),
        roomAddress: body.receipt?.roomAddress || room.address,
        rentAmount: body.receipt?.rentAmount || room.amount,
        depositAmount: body.receipt?.depositAmount || room.deposit
      });
      db.rooms.approved = db.rooms.approved.filter((e) => e.id !== body.id);
      db.rooms.taken = db.rooms.taken.filter((e) => e.id !== body.id);
      db.rooms.taken.unshift({ ...room, status: "taken", receipt, takenAt: new Date().toISOString() });
      db.receipts.unshift({ ...receipt, roomId: room.id, manual: false });
    }

    if (body.action === "manual-receipt") {
      const receipt = cleanReceipt(body.receipt || {});
      const manualRoom = {
        id: `manual-${Date.now()}`,
        title: cleanText(body.title || "Manual receipt", 120),
        address: receipt.roomAddress,
        type: cleanText(body.type || "Manual room", 40),
        roomType: cleanText(body.roomType || "Any", 40),
        amount: receipt.rentAmount,
        deposit: receipt.depositAmount,
        images: [], video: "", status: "taken", receipt, manual: true,
        takenAt: new Date().toISOString()
      };
      db.rooms.taken.unshift(manualRoom);
      db.receipts.unshift({ ...receipt, roomId: manualRoom.id, manual: true });
    }

    if (body.action === "delete") {
      const ok = deleteItem(db, body.section, body.from, body.id);
      if (!ok) return res.status(400).json({ ok: false, error: "Item not found" });
    }

    if (body.action === "repost") {
      const section = db[body.section];
      const fromList = section && Array.isArray(section[body.from]) ? section[body.from] : [];
      const item = fromList.find((e) => e.id === body.id);
      if (!item) return res.status(404).json({ ok: false, error: "Item not found" });
      section[body.from] = section[body.from].filter((e) => e.id !== body.id);
      if (Array.isArray(section.pending)) {
        section.pending.unshift({ ...item, id: "repost-" + Date.now(), status: "pending" });
      }
    }

    if (body.action === "remove-image") {
      const fromList = db[body.section]?.[body.from] || [];
      const room = fromList.find((e) => e.id === body.id);
      if (room) room.images = (room.images || []).filter((_, i) => i !== Number(body.index));
    }

    if (body.action === "remove-video") {
      const fromList = db[body.section]?.[body.from] || [];
      const room = fromList.find((e) => e.id === body.id);
      if (room) room.video = "";
    }

    if (body.action === "toggle-online") {
      const list = db[body.section]?.[body.from] || [];
      const item = list.find((e) => e.id === body.id);
      if (!item) return res.status(404).json({ ok: false, error: "Room not found" });
      item.online = item.online === false ? true : false;
    }

    if (body.action === "clear-all-data") {
      clearAllData();
      return res.json({ ok: true });
    }

    writeDB(db);
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin action error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =========================================================
// MATCHING ENGINE
// =========================================================
function budgetInRange(amount, range) {
  const n = moneyNumber(amount);
  if (!n) return false;
  if (range === 'R800-R1500') return n >= 800 && n <= 1500;
  if (range === 'R1600-R2500') return n >= 1600 && n <= 2500;
  if (range === 'R2600-R3500') return n >= 2600 && n <= 3500;
  if (range === 'R3600-R4500') return n >= 3600 && n <= 4500;
  if (range === 'R4600-R8000') return n >= 4600 && n <= 8000;
  return true;
}

function locationMatch(landlordLoc, landlordSub, tenantLocations) {
  if (!Array.isArray(tenantLocations) || tenantLocations.length === 0) return true;
  const lg = locationGroup(landlordLoc, landlordSub);
  for (const tLoc of tenantLocations) {
    const tg = locationGroup(tLoc, '');
    if (tg === lg) return true;
    if (lg === 'Alexandra Township' && (tg === 'Alexandra East' || tg === 'Alexandra Avenues')) return true;
    if (tg === 'Alexandra Township' && (lg === 'Alexandra East' || lg === 'Alexandra Avenues')) return true;
    if (lg === 'Alexandra East' && tg === 'Alexandra Avenues') return true;
    if (lg === 'Alexandra Avenues' && tg === 'Alexandra East') return true;
  }
  return false;
}

function roomTypeMatch(landlordType, tenantType) {
  const tt = String(tenantType || '').trim().toLowerCase();
  if (!tt || tt === 'any' || tt === 'any / not sure') return true;
  const lt = String(landlordType || '').trim().toLowerCase();
  if (!lt) return false;
  return lt === tt;
}

function matchOne(l, t) {
  if (!roomTypeMatch(l.roomType, t.roomType)) return false;
  if (t.budgetRange && !budgetInRange(l.amount, t.budgetRange)) return false;
  if (!locationMatch(l.location, l.alexandraSuburb, t.preferredLocations)) return false;
  if (String(l.childFriendly || 'No').toLowerCase() !== String(t.childFriendly || 'No').toLowerCase()) return false;
  if (String(l.parking || 'No').toLowerCase() !== String(t.parking || 'No').toLowerCase()) return false;
  return true;
}

app.get('/api/admin/matches', (req, res) => {
  const token = requireAdmin(req, res); if (!token) return;
  const db = readDB();
  const landlords = [...db.rooms.approved, ...db.rooms.taken].filter(r => r.online !== false);
  const tenants = db.tenantRequests.approved;

  const matches = [];
  const tenantMatches = {};

  landlords.forEach(l => {
    tenants.forEach(t => {
      if (matchOne(l, t)) {
        const m = {
          landlordId: l.id,
          landlordTitle: l.title,
          landlordLocation: l.location,
          landlordSuburb: l.alexandraSuburb || '',
          landlordLocationGroup: locationGroup(l.location, l.alexandraSuburb),
          landlordRent: l.amount,
          landlordContact: l.posterContact,
          landlordName: l.posterName,
          landlordOnline: l.online !== false,
          tenantId: t.id,
          tenantName: t.tenantName,
          tenantContact: t.contactNumber,
          tenantLocations: t.preferredLocations || [],
          tenantLocationGroups: (t.preferredLocations || []).map(loc => locationGroup(loc, '')),
          tenantBudget: t.budget,
          tenantBudgetRange: t.budgetRange || '',
          tenantRoomType: t.roomType,
          childFriendly: l.childFriendly,
          parking: l.parking
        };
        matches.push(m);
        if (!tenantMatches[m.tenantId]) tenantMatches[m.tenantId] = [];
        tenantMatches[m.tenantId].push(m);
      }
    });
  });

  res.json({
    matches,
    tenantMatches,
    totalLandlordsOnline: landlords.length,
    totalTenantsApproved: tenants.length
  });
});

// =========================================================
// FRONTEND ROUTES
// =========================================================
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
app.get('/transport', (req, res) => res.sendFile(path.join(ROOT, 'transport.html')));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ VUSANI IKHAYA PROPERTIES running on port ${PORT}`);
  console.log(`📊 Visitor tracking active — see admin panel`);
});

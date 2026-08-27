const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "database");
const DB_FILE = path.join(DATA_DIR, "db.json");
const sessions = new Set();

const defaultDB = {
  rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] },
  reviews: { pending: [], approved: [], declined: [] },
  reports: { pending: [], approved: [], declined: [] },
  transports: { pending: [], approved: [], declined: [], removed: [] },
  receipts: []
};

function normalizeSection(section, defaults) {
  const source = section && typeof section === "object" && !Array.isArray(section) ? section : {};
  return Object.fromEntries(
    Object.keys(defaults).map((status) => [
      status,
      Array.isArray(source[status]) ? source[status] : []
    ])
  );
}

function normalizeDB(db) {
  db = db || {};
  db.rooms = normalizeSection(db.rooms, defaultDB.rooms);
  db.reviews = normalizeSection(db.reviews, defaultDB.reviews);
  db.reports = normalizeSection(db.reports, defaultDB.reports);
  db.transports = normalizeSection(db.transports, defaultDB.transports);
  db.receipts = Array.isArray(db.receipts) ? db.receipts : [];
  return db;
}

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDB(defaultDB);
}

function readDB() {
  ensureDB();
  let parsed;
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, "");
    parsed = raw.trim() ? JSON.parse(raw) : defaultDB;
  } catch {
    parsed = defaultDB;
  }
  return normalizeDB(parsed);
}

function writeDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(normalizeDB(db), null, 2));
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function sendMedia(res, src) {
  if (!src) return send(res, 404, { error: "Media not found" });
  if (/^https?:\/\//i.test(src)) {
    res.writeHead(302, { Location: src, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const match = String(src).match(/^data:((?:image|video)\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return send(res, 404, { error: "Media not found" });
  res.writeHead(200, { "Content-Type": match[1], "Cache-Control": "public, max-age=3600" });
  res.end(Buffer.from(match[2], "base64"));
}

function encodePart(value) {
  return encodeURIComponent(String(value || ""));
}

function publicRoom(room) {
  return {
    ...room,
    images: (room.images || []).map((_, index) => `/api/room-media/${encodePart(room.id)}/image/${index}`),
    video: room.video ? `/api/room-media/${encodePart(room.id)}/video` : ""
  };
}

function publicTransport(driver) {
  return {
    id: driver.id,
    firstName: driver.firstName,
    surname: driver.surname,
    carPicture: driver.carPicture ? `/api/transport-media/${encodePart(driver.id)}/carPicture` : "",
    localPrice: driver.localPrice,
    outsidePrice: driver.outsidePrice,
    status: driver.status
  };
}

function adminMediaURL(section, status, id, field, index, token) {
  const base = `/api/admin/media/${encodePart(section)}/${encodePart(status)}/${encodePart(id)}/${encodePart(field)}`;
  const suffix = field === "images" ? `/${index}` : "";
  return `${base}${suffix}?token=${encodePart(token)}`;
}

function adminItem(item, section, status, token) {
  const next = { ...item };
  if (Array.isArray(next.images)) {
    next.images = next.images.map((_, index) => adminMediaURL(section, status, next.id, "images", index, token));
  }
  if (next.video) next.video = adminMediaURL(section, status, next.id, "video", 0, token);
  if (next.carPicture) next.carPicture = adminMediaURL(section, status, next.id, "carPicture", 0, token);
  if (next.idPicture) next.idPicture = adminMediaURL(section, status, next.id, "idPicture", 0, token);
  return next;
}

function adminSection(sectionName, section, token) {
  return Object.fromEntries(
    Object.entries(section).map(([status, list]) => [
      status,
      (Array.isArray(list) ? list : []).map((item) => adminItem(item, sectionName, status, token))
    ])
  );
}

function adminDB(db, token) {
  return {
    rooms: adminSection("rooms", db.rooms, token),
    reviews: db.reviews,
    reports: db.reports,
    transports: adminSection("transports", db.transports, token),
    receipts: db.receipts
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function cleanText(value, max = 600) {
  return String(value || "").trim().slice(0, max);
}

function cleanImages(images) {
  return Array.isArray(images)
    ? images.filter((src) => typeof src === "string" && /^(data:image\/|https?:\/\/)/i.test(src)).slice(0, 5)
    : [];
}

function cleanVideo(video) {
  return typeof video === "string" && /^(data:video\/|https?:\/\/)/i.test(video) ? video : "";
}

function moneyNumber(value) {
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function serviceFeeForRent(rent) {
  const amount = moneyNumber(rent);
  if (amount >= 800 && amount <= 1500) return 200;
  if (amount >= 1600 && amount <= 2000) return 250;
  if (amount >= 2100 && amount <= 3000) return 300;
  if (amount >= 3100 && amount <= 5000) return 400;
  return 0;
}

function monthKey(dateValue) {
  const value = cleanText(dateValue, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
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

function adminToken(req, url) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || String(url?.searchParams.get("token") || "");
}

function requireAdmin(req, res, url) {
  const token = adminToken(req, url);
  if (!token || !sessions.has(token)) {
    send(res, 401, { error: "Admin login required" });
    return false;
  }
  return token;
}

function moveItem(db, section, from, to, id) {
  if (!db[section] || !Array.isArray(db[section][from]) || !Array.isArray(db[section][to])) return;
  const item = db[section][from].find((entry) => entry.id === id);
  if (!item) return;
  db[section][from] = db[section][from].filter((entry) => entry.id !== id);
  db[section][to] = db[section][to].filter((entry) => entry.id !== id);
  db[section][to].unshift({ ...item, status: to, updatedAt: new Date().toISOString() });
}

function deleteItem(db, section, from, id) {
  if (!db[section] || !Array.isArray(db[section][from])) return;
  db[section][from] = db[section][from].filter((entry) => entry.id !== id);
}

async function api(req, res, url) {
  const db = readDB();

  if (req.method === "GET" && url.pathname.startsWith("/api/room-image/")) {
    const [, , , id, indexText] = url.pathname.split("/");
    const room = db.rooms.approved.find((entry) => entry.id === decodeURIComponent(id || ""));
    const index = Math.max(0, Number(indexText) || 0);
    return sendMedia(res, room?.images?.[index]);
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/room-media/")) {
    const [, , , id, kind, indexText] = url.pathname.split("/");
    const room = db.rooms.approved.find((entry) => entry.id === decodeURIComponent(id || ""));
    if (kind === "video") return sendMedia(res, room?.video);
    const index = Math.max(0, Number(indexText) || 0);
    return sendMedia(res, room?.images?.[index]);
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/transport-media/")) {
    const [, , , id, field] = url.pathname.split("/");
    const driver = db.transports.approved.find((entry) => entry.id === decodeURIComponent(id || ""));
    return sendMedia(res, field === "carPicture" ? driver?.carPicture : "");
  }

  if (req.method === "GET" && url.pathname === "/api/public") {
    send(res, 200, {
      rooms: db.rooms.approved.map(publicRoom),
      reviews: db.reviews.approved,
      transports: db.transports.approved.map(publicTransport)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(req);
    db.rooms.pending.unshift({
      id: "post-" + Date.now(),
      title: cleanText(body.title, 120),
      location: cleanText(body.location, 80),
      address: cleanText(body.address, 220),
      type: cleanText(body.type, 40),
      roomType: cleanText(body.roomType || "Any", 40),
      amount: cleanText(body.amount, 40),
      deposit: cleanText(body.deposit || "No deposit stated", 80),
      childFriendly: cleanText(body.childFriendly, 10),
      parking: cleanText(body.parking, 10),
      bath: cleanText(body.bath, 120),
      images: cleanImages(body.images),
      video: cleanVideo(body.video),
      posterName: cleanText(body.posterName, 100),
      posterContact: cleanText(body.posterContact, 160),
      notes: cleanText(body.notes, 800),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reviews") {
    const body = await readBody(req);
    db.reviews.pending.unshift({
      id: "review-" + Date.now(),
      roomId: cleanText(body.roomId, 80),
      roomTitle: cleanText(body.roomTitle, 140),
      name: cleanText(body.name, 100),
      rating: Math.max(1, Math.min(5, Number(body.rating) || 5)),
      comment: cleanText(body.comment, 800),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reports") {
    const body = await readBody(req);
    db.reports.pending.unshift({
      id: "report-" + Date.now(),
      room: cleanText(body.room, 180),
      reporterContact: cleanText(body.reporterContact, 160),
      reason: cleanText(body.reason, 1000),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transports") {
    const body = await readBody(req);
    db.transports.pending.unshift({
      id: "transport-" + Date.now(),
      firstName: cleanText(body.firstName, 100),
      surname: cleanText(body.surname, 100),
      phone: cleanText(body.phone, 80),
      email: cleanText(body.email, 160),
      carPicture: cleanImages([body.carPicture])[0] || "",
      idPicture: cleanImages([body.idPicture])[0] || "",
      localPrice: cleanText(body.localPrice, 80),
      outsidePrice: cleanText(body.outsidePrice, 80),
      notes: cleanText(body.notes, 800),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readBody(req);
    if (body.password !== ADMIN_PASSWORD) return send(res, 401, { error: "Incorrect password" });
    const token = crypto.randomBytes(24).toString("hex");
    sessions.add(token);
    send(res, 200, { token });
    return;
  }

  if (url.pathname.startsWith("/api/admin/")) {
    const token = requireAdmin(req, res, url);
    if (!token) return;

    if (req.method === "GET" && url.pathname.startsWith("/api/admin/media/")) {
      const [, , , , section, status, id, field, indexText] = url.pathname.split("/");
      const list = db[decodeURIComponent(section || "")]?.[decodeURIComponent(status || "")] || [];
      const item = list.find((entry) => entry.id === decodeURIComponent(id || ""));
      if (field === "images") return sendMedia(res, item?.images?.[Math.max(0, Number(indexText) || 0)]);
      return sendMedia(res, item?.[decodeURIComponent(field || "")]);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/data") return send(res, 200, adminDB(db, token));

    if (req.method === "POST" && url.pathname === "/api/admin/action") {
      const body = await readBody(req);
      if (body.action === "move") moveItem(db, body.section, body.from, body.to, body.id);
      if (body.action === "mark-taken") {
        const room = db.rooms.approved.find((entry) => entry.id === body.id);
        if (room) {
          const receipt = cleanReceipt({
            ...(body.receipt || {}),
            roomAddress: body.receipt?.roomAddress || room.address,
            rentAmount: body.receipt?.rentAmount || room.amount,
            depositAmount: body.receipt?.depositAmount || room.deposit
          });
          db.rooms.approved = db.rooms.approved.filter((entry) => entry.id !== body.id);
          db.rooms.taken = db.rooms.taken.filter((entry) => entry.id !== body.id);
          db.rooms.taken.unshift({ ...room, status: "taken", receipt, takenAt: new Date().toISOString() });
          db.receipts.unshift({ ...receipt, roomId: room.id, manual: false });
        }
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
          images: [],
          video: "",
          status: "taken",
          receipt,
          manual: true,
          takenAt: new Date().toISOString()
        };
        db.rooms.taken.unshift(manualRoom);
        db.receipts.unshift({ ...receipt, roomId: manualRoom.id, manual: true });
      }
      if (body.action === "delete") deleteItem(db, body.section, body.from, body.id);
      if (body.action === "repost") {
        const section = db[body.section];
        const fromList = section && Array.isArray(section[body.from]) ? section[body.from] : [];
        const item = fromList.find((entry) => entry.id === body.id);
        if (item && Array.isArray(section.pending)) {
          section.pending.unshift({ ...item, id: "repost-" + Date.now(), status: "pending" });
        }
      }
      if (body.action === "remove-image") {
        const section = db[body.section];
        const fromList = section && Array.isArray(section[body.from]) ? section[body.from] : [];
        const room = fromList.find((entry) => entry.id === body.id);
        if (room) room.images = (room.images || []).filter((_, index) => index !== Number(body.index));
      }
      if (body.action === "remove-video") {
        const section = db[body.section];
        const fromList = section && Array.isArray(section[body.from]) ? section[body.from] : [];
        const room = fromList.find((entry) => entry.id === body.id);
        if (room) room.video = "";
      }
      writeDB(db);
      send(res, 200, { ok: true });
      return;
    }

  }

  send(res, 404, { error: "Not found" });
}

function serveFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".zip": "application/zip" }[ext] || "application/octet-stream";
  send(res, 200, fs.readFileSync(file), type);
}

ensureDB();
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    serveFile(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
}).listen(PORT, () => console.log(`VUSANI IKHAYA PROPERTIES running at http://localhost:${PORT}`));

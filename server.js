"use strict";
// Booking Ruang Rapat MRDK — server mandiri (Express + PostgreSQL)
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ACCESS_PIN = (process.env.ACCESS_PIN || "").trim(); // kosong = tanpa PIN akses
const ADMIN_PIN = (process.env.ADMIN_PIN || "").trim();   // kosong = mode admin nonaktif
const TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Jakarta";

const ROOMS = {
  ex2wm: "RR Executive 2 WM",
  ex3wm: "RR Executive 3 WM",
  rdk3s: "RR RDK Lantai 3 Soemitro",
};
const DAY_START = 7 * 60, DAY_END = 20 * 60, STEP = 30;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL belum diisi. Lihat README untuk cara menjalankan aplikasi.");
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  max: 5,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room        text NOT NULL,
      date        date NOT NULL,
      start_min   integer NOT NULL,
      end_min     integer NOT NULL,
      title       text NOT NULL,
      unit        text NOT NULL,
      dk          text,
      name        text NOT NULL,
      pax         integer,
      owner_hash  text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CHECK (end_min > start_min)
    );
    CREATE INDEX IF NOT EXISTS bookings_room_date ON bookings (room, date);
    CREATE INDEX IF NOT EXISTS bookings_date ON bookings (date);
  `);
}

/* ---------- helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const toHM = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function nowLocal() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const isHM = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const cleanText = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isAdmin = (req) => !!ADMIN_PIN && !!req.get("x-admin-pin") && safeEqual(req.get("x-admin-pin"), ADMIN_PIN);
const ownerHash = (req) => { const t = req.get("x-owner-token") || ""; return /^[A-Za-z0-9-]{16,100}$/.test(t) ? sha256(t) : null; };

function rowOut(r, req) {
  const oh = ownerHash(req);
  return {
    id: r.id, room: r.room, date: r.date, start: toHM(r.start_min), end: toHM(r.end_min),
    title: r.title, unit: r.unit, dk: r.dk, name: r.name, pax: r.pax, createdAt: r.created_at,
    mine: !!oh && oh === r.owner_hash,
  };
}
const SELECT = `SELECT id, room, to_char(date,'YYYY-MM-DD') AS date, start_min, end_min, title, unit, dk, name, pax, owner_hash, created_at FROM bookings`;

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/config", (req, res) => {
  res.json({ pinRequired: !!ACCESS_PIN, adminEnabled: !!ADMIN_PIN, rooms: ROOMS, today: nowLocal().date, timeZone: TIME_ZONE });
});

// PIN akses untuk semua endpoint /api lainnya
app.use("/api", (req, res, next) => {
  if (!ACCESS_PIN) return next();
  const pin = req.get("x-access-pin");
  if (pin && safeEqual(pin, ACCESS_PIN)) return next();
  res.status(401).json({ error: "pin", message: "PIN akses salah atau belum diisi." });
});

app.get("/api/check-pin", (req, res) => res.json({ ok: true }));
app.get("/api/admin/check", (req, res) => (isAdmin(req) ? res.json({ ok: true }) : res.status(403).json({ error: "admin", message: "PIN admin salah." })));

app.get("/api/bookings", async (req, res, next) => {
  try {
    const today = nowLocal().date;
    let from = isDate(req.query.from) ? req.query.from : today;
    let to = isDate(req.query.to) ? req.query.to : from;
    if (to < from) [from, to] = [to, from];
    const { rows } = await pool.query(`${SELECT} WHERE date BETWEEN $1 AND $2 ORDER BY date, start_min, room LIMIT 2000`, [from, to]);
    res.json({ bookings: rows.map((r) => rowOut(r, req)) });
  } catch (e) { next(e); }
});

app.get("/api/bookings/mine", async (req, res, next) => {
  try {
    const oh = ownerHash(req);
    if (!oh) return res.json({ bookings: [] });
    const { rows } = await pool.query(`${SELECT} WHERE owner_hash = $1 AND date >= $2 ORDER BY date, start_min LIMIT 500`, [oh, nowLocal().date]);
    res.json({ bookings: rows.map((r) => rowOut(r, req)) });
  } catch (e) { next(e); }
});

app.post("/api/bookings", async (req, res, next) => {
  const b = req.body || {};
  const oh = ownerHash(req);
  const fail = (message) => res.status(400).json({ error: "invalid", message });
  if (!oh) return fail("Browser ini belum punya penanda pemesan. Muat ulang halaman lalu coba lagi.");
  if (!ROOMS[b.room]) return fail("Ruang tidak dikenal.");
  if (!isDate(b.date)) return fail("Tanggal tidak valid.");
  if (!isHM(b.start) || !isHM(b.end)) return fail("Jam tidak valid.");
  const s = toMin(b.start), e = toMin(b.end);
  if (s % STEP || e % STEP || s < DAY_START || e > DAY_END || e <= s) return fail("Jam harus antara 07:00–20:00, kelipatan 30 menit, dan jam selesai setelah jam mulai.");
  const now = nowLocal();
  if (b.date < now.date || (b.date === now.date && s < now.min - 5)) return fail("Waktu ini sudah lewat.");
  const title = cleanText(b.title, 120), unit = cleanText(b.unit, 80), name = cleanText(b.name, 80), dk = cleanText(b.dk, 10) || null;
  if (!title) return fail("Isi agenda rapat.");
  if (!unit) return fail("Pilih satuan kerja pengguna ruang.");
  if (!name) return fail("Isi nama pemesan.");
  let pax = null;
  if (b.pax !== undefined && b.pax !== null && b.pax !== "") {
    pax = Number(b.pax);
    if (!Number.isInteger(pax) || pax < 1 || pax > 500) return fail("Jumlah peserta harus 1–500.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Kunci per ruang+tanggal agar dua pesanan bersamaan tidak sama-sama lolos
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [b.room + "|" + b.date]);
    const clash = await client.query(`${SELECT} WHERE room = $1 AND date = $2 AND start_min < $4 AND $3 < end_min ORDER BY start_min LIMIT 1`, [b.room, b.date, s, e]);
    if (clash.rows.length) {
      await client.query("ROLLBACK");
      const c = rowOut(clash.rows[0], req);
      return res.status(409).json({ error: "conflict", message: `Bentrok dengan ${c.start}–${c.end} ${c.title} (${c.unit}).`, conflict: c });
    }
    const ins = await client.query(
      `INSERT INTO bookings (room, date, start_min, end_min, title, unit, dk, name, pax, owner_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, room, to_char(date,'YYYY-MM-DD') AS date, start_min, end_min, title, unit, dk, name, pax, owner_hash, created_at`,
      [b.room, b.date, s, e, title, unit, dk, name, pax, oh]
    );
    await client.query("COMMIT");
    res.status(201).json({ booking: rowOut(ins.rows[0], req) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.delete("/api/bookings/:id", async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "not_found", message: "Pesanan tidak ditemukan." });
    const { rows } = await pool.query(`${SELECT} WHERE id = $1`, [req.params.id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "not_found", message: "Pesanan tidak ditemukan atau sudah dibatalkan." });
    const admin = isAdmin(req);
    const oh = ownerHash(req);
    if (!admin && !(oh && oh === r.owner_hash)) return res.status(403).json({ error: "forbidden", message: "Hanya pemesan atau admin yang bisa membatalkan pesanan ini." });
    if (!admin && r.date < nowLocal().date) return res.status(400).json({ error: "past", message: "Pesanan yang sudah lewat tidak bisa dibatalkan." });
    await pool.query("DELETE FROM bookings WHERE id = $1", [r.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use("/api", (req, res) => res.status(404).json({ error: "not_found", message: "Alamat API tidak dikenal." }));

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: "5m" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server", message: "Terjadi kesalahan di server. Coba lagi sebentar lagi." });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`Booking Ruang Rapat MRDK berjalan di port ${PORT}`)))
  .catch((e) => { console.error("Gagal menyiapkan database:", e); process.exit(1); });

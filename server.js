"use strict";
// Booking Ruang Rapat MRDK — server mandiri (Express + PostgreSQL)
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const ExcelJS = require("exceljs");

const PORT = process.env.PORT || 3000;
const ACCESS_PIN = (process.env.ACCESS_PIN || "").trim(); // kosong = tanpa PIN akses
const ADMIN_PIN = (process.env.ADMIN_PIN || "").trim();   // kosong = mode admin nonaktif
const TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Jakarta";

const ROOMS = {
  ex2wm: "RR Executive 2 WM",
  ex3wm: "RR Executive 3 WM",
  rdk3s: "RR RDK Soemitro",
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
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at timestamptz;
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

const MAX_RANGE_DAYS = 366;
const addDaysStr = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Rentang tanggal dari query (?from=&to=), dibatasi maksimal satu tahun
function rangeFrom(q) {
  const today = nowLocal().date;
  let from = isDate(q.from) ? q.from : today;
  let to = isDate(q.to) ? q.to : from;
  if (to < from) [from, to] = [to, from];
  const cap = addDaysStr(from, MAX_RANGE_DAYS);
  if (to > cap) to = cap;
  return { from, to };
}

app.get("/api/bookings", async (req, res, next) => {
  try {
    const { from, to } = rangeFrom(req.query);
    const { rows } = await pool.query(`${SELECT} WHERE date BETWEEN $1 AND $2 ORDER BY date, start_min, room LIMIT 3000`, [from, to]);
    res.json({ from, to, bookings: rows.map((r) => rowOut(r, req)) });
  } catch (e) { next(e); }
});

// Unduh rekap sebagai file Excel
app.get("/api/bookings/export.xlsx", async (req, res, next) => {
  try {
    const { from, to } = rangeFrom(req.query);
    const room = ROOMS[req.query.room] ? req.query.room : null;
    const { rows } = await pool.query(
      `${SELECT} WHERE date BETWEEN $1 AND $2 AND ($3::text IS NULL OR room = $3) ORDER BY date, start_min, room LIMIT 5000`,
      [from, to, room]
    );
    const dayName = new Intl.DateTimeFormat("id-ID", { weekday: "long", timeZone: "UTC" });
    const asDate = (s) => new Date(s + "T00:00:00Z");
    const fmtDMY = (s) => s.split("-").reverse().join("/");

    const wb = new ExcelJS.Workbook();
    wb.creator = "Booking Ruang Rapat MRDK";
    wb.created = new Date();

    const ws = wb.addWorksheet("Rekap", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "No", key: "no", width: 5 },
      { header: "Tanggal", key: "date", width: 12, style: { numFmt: "dd/mm/yyyy" } },
      { header: "Hari", key: "day", width: 9 },
      { header: "Mulai", key: "start", width: 7 },
      { header: "Selesai", key: "end", width: 8 },
      { header: "Durasi (jam)", key: "dur", width: 11, style: { numFmt: "0.0" } },
      { header: "Ruang", key: "room", width: 22 },
      { header: "Agenda", key: "title", width: 44 },
      { header: "Satuan Kerja", key: "unit", width: 13 },
      { header: "Bidang", key: "dk", width: 8 },
      { header: "Pemesan", key: "name", width: 20 },
      { header: "Peserta", key: "pax", width: 8 },
    ];
    rows.forEach((r, i) => ws.addRow({
      no: i + 1, date: asDate(r.date), day: dayName.format(asDate(r.date)),
      start: toHM(r.start_min), end: toHM(r.end_min), dur: (r.end_min - r.start_min) / 60,
      room: ROOMS[r.room] || r.room, title: r.title, unit: r.unit, dk: r.dk || "", name: r.name, pax: r.pax ?? "",
    }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCECF1" } };
    ws.autoFilter = { from: "A1", to: "L1" };

    const sum = wb.addWorksheet("Ringkasan");
    sum.columns = [{ width: 26 }, { width: 16 }, { width: 12 }];
    sum.addRow(["Rekap booking ruang rapat"]).font = { bold: true, size: 13 };
    sum.addRow(["Periode", `${fmtDMY(from)} s.d. ${fmtDMY(to)}`]);
    sum.addRow(["Ruang", room ? ROOMS[room] : "Semua ruang"]);
    const n = nowLocal();
    sum.addRow(["Diunduh", `${fmtDMY(n.date)} ${toHM(n.min)} WIB`]);
    sum.addRow([]);
    sum.addRow(["Ruang", "Jumlah booking", "Total jam"]).font = { bold: true };
    let totalN = 0, totalMin = 0;
    for (const [id, nm] of Object.entries(ROOMS)) {
      if (room && id !== room) continue;
      const rr = rows.filter((r) => r.room === id);
      const mins = rr.reduce((a, r) => a + r.end_min - r.start_min, 0);
      totalN += rr.length; totalMin += mins;
      sum.addRow([nm, rr.length, mins / 60]).getCell(3).numFmt = "0.0";
    }
    const tr = sum.addRow(["Total", totalN, totalMin / 60]);
    tr.font = { bold: true }; tr.getCell(3).numFmt = "0.0";

    const fname = `rekap-ruang-rapat_${from}_sd_${to}${room ? "_" + room : ""}.xlsx`;
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", `attachment; filename="${fname}"`);
    res.set("Cache-Control", "no-store");
    await wb.xlsx.write(res);
    res.end();
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

// Validasi isian booking. `existing` diisi saat mengubah booking.
function validate(b, existing) {
  if (!ROOMS[b.room]) return { error: "Ruang tidak dikenal." };
  if (!isDate(b.date)) return { error: "Tanggal tidak valid." };
  if (!isHM(b.start) || !isHM(b.end)) return { error: "Jam tidak valid." };
  const s = toMin(b.start), e = toMin(b.end);
  if (s % STEP || e % STEP || s < DAY_START || e > DAY_END || e <= s) return { error: "Jam harus antara 07:00–20:00, kelipatan 30 menit, dan jam selesai setelah jam mulai." };
  const now = nowLocal();
  // Saat mengubah, jam mulai yang tidak diubah boleh sudah lewat (mis. memperpanjang rapat yang sedang berjalan)
  const startUnchanged = existing && existing.date === b.date && existing.start_min === s;
  if (b.date < now.date) return { error: "Tanggal ini sudah lewat." };
  if (!startUnchanged && b.date === now.date && s < now.min - 5) return { error: "Waktu ini sudah lewat." };
  if (b.date === now.date && e <= now.min) return { error: "Jam selesai sudah lewat." };
  const title = cleanText(b.title, 120), unit = cleanText(b.unit, 80), name = cleanText(b.name, 80), dk = cleanText(b.dk, 10) || null;
  if (!title) return { error: "Isi agenda rapat." };
  if (!unit) return { error: "Pilih satuan kerja pengguna ruang." };
  if (!name) return { error: "Isi nama pemesan." };
  let pax = null;
  if (b.pax !== undefined && b.pax !== null && b.pax !== "") {
    pax = Number(b.pax);
    if (!Number.isInteger(pax) || pax < 1 || pax > 500) return { error: "Jumlah peserta harus 1–500." };
  }
  return { v: { room: b.room, date: b.date, s, e, title, unit, dk, name, pax } };
}

const RETURNING = `RETURNING id, room, to_char(date,'YYYY-MM-DD') AS date, start_min, end_min, title, unit, dk, name, pax, owner_hash, created_at`;

// Dijalankan di dalam transaksi: kunci ruang+tanggal, lalu cari bentrok (selain booking `exceptId`)
async function lockAndFindClash(client, v, exceptId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [v.room + "|" + v.date]);
  const q = await client.query(
    `${SELECT} WHERE room = $1 AND date = $2 AND start_min < $4 AND $3 < end_min AND ($5::uuid IS NULL OR id <> $5::uuid) ORDER BY start_min LIMIT 1`,
    [v.room, v.date, v.s, v.e, exceptId || null]
  );
  return q.rows[0] || null;
}
const conflictBody = (row, req) => { const c = rowOut(row, req); return { error: "conflict", message: `Bentrok dengan ${c.start}–${c.end} ${c.title} (${c.unit}).`, conflict: c }; };

app.post("/api/bookings", async (req, res, next) => {
  const oh = ownerHash(req);
  if (!oh) return res.status(400).json({ error: "invalid", message: "Browser ini belum punya penanda pemesan. Muat ulang halaman lalu coba lagi." });
  const { v, error } = validate(req.body || {});
  if (error) return res.status(400).json({ error: "invalid", message: error });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const clash = await lockAndFindClash(client, v);
    if (clash) { await client.query("ROLLBACK"); return res.status(409).json(conflictBody(clash, req)); }
    const ins = await client.query(
      `INSERT INTO bookings (room, date, start_min, end_min, title, unit, dk, name, pax, owner_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ${RETURNING}`,
      [v.room, v.date, v.s, v.e, v.title, v.unit, v.dk, v.name, v.pax, oh]
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

app.put("/api/bookings/:id", async (req, res, next) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "not_found", message: "Booking tidak ditemukan." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = (await client.query(`${SELECT} WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found", message: "Booking tidak ditemukan atau sudah dibatalkan." }); }
    const admin = isAdmin(req), oh = ownerHash(req);
    if (!admin && !(oh && oh === cur.owner_hash)) { await client.query("ROLLBACK"); return res.status(403).json({ error: "forbidden", message: "Hanya pemesan atau admin yang bisa mengubah booking ini." }); }
    const now = nowLocal();
    if (cur.date < now.date || (cur.date === now.date && cur.end_min <= now.min)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "past", message: "Rapat ini sudah selesai sehingga tidak bisa diubah." }); }
    const { v, error } = validate(req.body || {}, cur);
    if (error) { await client.query("ROLLBACK"); return res.status(400).json({ error: "invalid", message: error }); }
    const clash = await lockAndFindClash(client, v, cur.id);
    if (clash) { await client.query("ROLLBACK"); return res.status(409).json(conflictBody(clash, req)); }
    const up = await client.query(
      `UPDATE bookings SET room=$2, date=$3, start_min=$4, end_min=$5, title=$6, unit=$7, dk=$8, name=$9, pax=$10, updated_at=now()
       WHERE id=$1 ${RETURNING}`,
      [cur.id, v.room, v.date, v.s, v.e, v.title, v.unit, v.dk, v.name, v.pax]
    );
    await client.query("COMMIT");
    res.json({ booking: rowOut(up.rows[0], req) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.delete("/api/bookings/:id", async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "not_found", message: "Booking tidak ditemukan." });
    const { rows } = await pool.query(`${SELECT} WHERE id = $1`, [req.params.id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "not_found", message: "Booking tidak ditemukan atau sudah dibatalkan." });
    const admin = isAdmin(req);
    const oh = ownerHash(req);
    if (!admin && !(oh && oh === r.owner_hash)) return res.status(403).json({ error: "forbidden", message: "Hanya pemesan atau admin yang bisa membatalkan booking ini." });
    if (!admin && r.date < nowLocal().date) return res.status(400).json({ error: "past", message: "Booking yang sudah lewat tidak bisa dibatalkan." });
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

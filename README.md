# Booking Ruang Rapat MRDK

Aplikasi web untuk mengecek ketersediaan dan memesan ruang rapat:

- RR Executive 2 WM
- RR Executive 3 WM
- RR RDK Lantai 3 Soemitro

Siapa pun yang punya alamat aplikasi (dan PIN akses, bila diaktifkan) bisa melihat jadwal dan memesan, tanpa perlu akun apa pun.

## Fitur

- Status setiap ruang (tersedia sekarang / dipakai sampai jam berapa)
- Papan jadwal harian 07:00–20:00; klik slot kosong untuk memesan
- Cek bentrok otomatis, beserta saran ruang lain yang kosong di jam yang sama
- Anti pesanan ganda: bila dua orang memesan slot yang sama bersamaan, hanya satu yang berhasil (dikunci di database)
- Pilihan pengguna ruang berdasarkan satuan kerja OJK (DK1–DK9 beserta deputi komisioner dan departemennya), atau isian bebas
- Tab "Pesanan saya", ubah pesanan (ruang, tanggal, jam, agenda, pengguna), dan pembatalan pesanan sendiri
- PIN akses unit (opsional) dan mode admin untuk membatalkan pesanan siapa pun
- Jadwal diperbarui otomatis setiap 15 detik

## Struktur repositori

| Path                        | Isi                                                                 |
|-----------------------------|---------------------------------------------------------------------|
| `server.js`                 | Server Express + API + pembuatan tabel database otomatis            |
| `public/index.html`         | Halaman aplikasi                                                     |
| `render.yaml`               | Konfigurasi deploy Render (web service + PostgreSQL)                |
| `claude-artifact/index.html`| Versi awal yang berjalan sebagai artifact di claude.ai (arsip)      |

## Deploy ke Render

1. Masuk ke [render.com](https://render.com) dan hubungkan akun GitHub.
2. Pilih **New → Blueprint**, lalu pilih repositori `booking-ruang-rapat-mrdk`. Render membaca `render.yaml` dan menyiapkan:
   - web service `booking-ruang-rapat-mrdk`
   - database PostgreSQL `booking-ruang-rapat-db`
3. Render akan meminta dua nilai:
   - `ACCESS_PIN` — PIN yang dibagikan ke rekan-rekan untuk membuka aplikasi. Kosongkan bila aplikasi boleh dibuka siapa saja yang tahu alamatnya.
   - `ADMIN_PIN` — PIN khusus pengelola untuk membatalkan pesanan siapa pun. Kosongkan untuk menonaktifkan mode admin.
4. Klik **Apply**. Setelah selesai, alamat aplikasi tampil di halaman web service (format `https://booking-ruang-rapat-mrdk.onrender.com` atau serupa).

Catatan paket gratis Render: web service tertidur bila lama tidak diakses (pembukaan pertama bisa butuh beberapa puluh detik), dan database gratis punya batas masa pakai. Cek ketentuan terbaru di halaman harga Render, dan pertimbangkan paket berbayar bila aplikasi dipakai rutin.

## Menjalankan di komputer sendiri

Butuh Node.js 18+ dan PostgreSQL.

```bash
npm install
DATABASE_URL=postgres://user:password@localhost:5432/booking_ruang_rapat \
ACCESS_PIN=1234 ADMIN_PIN=9999 \
npm start
```

Buka `http://localhost:3000`.

## Variabel lingkungan

| Nama            | Wajib | Keterangan                                                        |
|-----------------|-------|-------------------------------------------------------------------|
| `DATABASE_URL`  | Ya    | Alamat koneksi PostgreSQL                                         |
| `ACCESS_PIN`    | Tidak | PIN untuk membuka aplikasi; kosong = tanpa PIN                    |
| `ADMIN_PIN`     | Tidak | PIN mode admin; kosong = mode admin nonaktif                      |
| `APP_TIME_ZONE` | Tidak | Zona waktu untuk aturan "waktu sudah lewat"; bawaan `Asia/Jakarta`|
| `PGSSL`         | Tidak | Isi `true` bila database mewajibkan SSL (mis. koneksi eksternal)  |
| `PORT`          | Tidak | Port server; diisi otomatis oleh Render                           |

## Cara kerja kepemilikan pesanan

Setiap browser mendapat penanda acak yang disimpan di browser itu. Pesanan yang dibuat dari browser tersebut ditandai "Anda" dan bisa diubah atau dibatalkan dari sana. Rapat yang sudah selesai tidak bisa diubah. Bila pemesan berganti perangkat atau menghapus data browser, pembatalan dilakukan oleh admin.

## API

Semua endpoint `/api` (kecuali `/api/config`) memerlukan header `X-Access-Pin` bila `ACCESS_PIN` diaktifkan.

| Metode   | Path                              | Keterangan                                   |
|----------|-----------------------------------|----------------------------------------------|
| `GET`    | `/api/config`                     | Pengaturan aplikasi (PIN wajib atau tidak)   |
| `GET`    | `/api/bookings?from=&to=`         | Daftar pesanan pada rentang tanggal          |
| `GET`    | `/api/bookings/mine`              | Pesanan mendatang milik browser ini          |
| `POST`   | `/api/bookings`                   | Buat pesanan (409 bila bentrok)              |
| `PUT`    | `/api/bookings/:id`               | Ubah pesanan (pemilik atau admin; 409 bila bentrok) |
| `DELETE` | `/api/bookings/:id`               | Batalkan pesanan (pemilik atau admin)        |

## Catatan kebijakan

Aplikasi ini menyimpan agenda rapat, satuan kerja, dan nama pemesan. Sebelum dipakai untuk data internal, pastikan penggunaan hosting di luar infrastruktur OJK sesuai ketentuan yang berlaku.

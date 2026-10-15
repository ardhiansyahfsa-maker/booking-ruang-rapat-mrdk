# Booking Ruang Rapat MRDK

Aplikasi web untuk mengecek ketersediaan dan memesan ruang rapat:

- RR Executive 2 WM
- RR Executive 3 WM
- RR RDK Lantai 3 Soemitro

## Fitur

- Status setiap ruang (tersedia sekarang / dipakai sampai jam berapa)
- Papan jadwal harian 07:00–20:00; klik slot kosong untuk memesan
- Cek bentrok otomatis, beserta saran ruang lain yang kosong di jam yang sama
- Pencegahan pesanan ganda saat dua orang memesan slot yang sama bersamaan
- Pilihan pengguna ruang berdasarkan satuan kerja OJK (DK1–DK9 beserta deputi komisioner dan departemennya)
- Daftar "Pesanan saya" dan pembatalan pesanan

## Catatan teknis

Versi ini adalah satu file `index.html` yang menyimpan jadwal melalui penyimpanan bawaan halaman claude.ai
(`claude.use("db")` dan `claude.use("user")`). Karena itu aplikasi hanya berfungsi penuh saat dibuka
sebagai artifact di claude.ai. Jika dibuka dari hosting lain (GitHub Pages, Render, dll.), halaman tampil
tetapi jadwal tidak termuat.

Untuk dipakai sebagai aplikasi mandiri, penyimpanan perlu diganti dengan server dan database sendiri.

## Struktur data pesanan (koleksi `bookings`)

| Field       | Contoh                     | Keterangan                              |
|-------------|----------------------------|-----------------------------------------|
| `room`      | `ex2wm` / `ex3wm` / `rdk3s` | Kode ruang                              |
| `date`      | `2026-10-20`               | Tanggal (YYYY-MM-DD)                    |
| `start`     | `09:00`                    | Jam mulai                               |
| `end`       | `11:00`                    | Jam selesai                             |
| `title`     | `Rapat koordinasi`         | Agenda rapat                            |
| `unit`      | `DPAI`                     | Akronim satuan kerja pengguna ruang     |
| `dk`        | `DK1`                      | Bidang (jika satuan kerja ada di daftar) |
| `name`      | `Nama pemesan`             | Nama orang yang memesan                 |
| `pax`       | `12`                       | Jumlah peserta (opsional)               |
| `by`        | `u_…`                      | ID pengguna claude.ai pemesan           |
| `createdAt` | ISO timestamp              | Waktu pesanan dibuat                    |

# MyDataset v1.1.6 — Stable Release

MyDataset v1.1.6 adalah rilis stabil/final berbasis Electron + Node.js untuk pengumpulan, cleaning, audit, penggabungan, dan export data review web menjadi dataset terstruktur.

## Highlight

- HAR/Network: Traveloka, Tiket, Agoda, Trip, Booking.
- DOM: Tiket, Agoda, Trip.
- Pagination, checkpoint, provenance, duplicate audit, merge, dan export.
- Fresh/stale record detection untuk Trip.
- Status coverage yang membedakan akhir sumber, batas langkah, dan batas retrieval sumber.
- Fallback ID Tiket dengan prefix `synthetic:tiket:` saat ID native tidak tersedia.
- Browser Monitor read-only dan UI Isolation.

## Windows

File portable release yang disarankan:

`MyDataset-v1.1.6-Windows-x64.exe`

Pengguna EXE tidak perlu memasang Node.js.

## Source

Untuk menjalankan atau membangun dari source diperlukan Node.js 22.12.0 atau lebih baru.

```bash
npm ci
npm start
```

Build Windows x64 portable EXE:

```bash
npm ci
npm run build:win
```

## Status proyek

Stable / Maintenance Mode. Pengembangan fitur utama telah selesai.

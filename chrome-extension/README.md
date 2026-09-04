# MyDataset Capture v1.0.0

Pendamping opsional MyDataset untuk capture Network review dari DevTools Chrome/Edge.

## Platform aktif
- Traveloka
- Tiket

Extension mendeteksi platform dari tab yang sedang diperiksa dan hanya memantau endpoint review yang sudah memiliki profile. Tidak ada mode capture semua XHR/Fetch JSON.

## Posisi dalam workflow
HAR Chrome tetap direkomendasikan sebagai sumber mentah utama untuk penelitian. Extension dipakai sebagai jalur cepat ketika pengguna ingin paket/JSON capture yang lebih kecil.

## Instalasi
1. Ekstrak ZIP extension.
2. Buka `chrome://extensions` atau `edge://extensions`.
3. Aktifkan Developer mode.
4. Pilih **Load unpacked**.
5. Pilih folder yang langsung berisi `manifest.json`.

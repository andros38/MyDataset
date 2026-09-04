# Changelog

Semua perubahan penting MyDataset dicatat di file ini.

## [1.1.6] - 2026-09-04

### Stable / Maintenance Release

- Membekukan MyDataset sebagai baseline stabil berbasis Electron + Node.js.
- Menambahkan **fresh-record stabilization** untuk Trip agar card stale dari halaman sebelumnya tidak dianggap sebagai review baru.
- Menambahkan diagnostik `rawItemCount`, `freshItemCount`, `staleItemCount`, dan item key pada page history.
- Menambahkan verifikasi terminal Tiket secara read-only sebelum menyatakan akhir sumber.
- Menambahkan audit `nativeReviewIds`, `syntheticReviewIds`, dan `missingReviewIds`.
- Menampilkan audit ID sintetis pada hasil/ringkasan proses ketika relevan.
- Mempertahankan core pagination, extractor, cleaning, deduplication, mapping, dan merge yang telah stabil.

### Final validation notes

- Trip dapat mempertahankan node/card stale dari halaman sebelumnya di DOM; v1.1.6 membedakan card stale dan fresh sebelum ekstraksi.
- Pada kasus pengujian Trip tertentu, jumlah review yang dilaporkan website lebih besar daripada listing aktual karena sumber menyatakan sebagian review telah disaring. MyDataset mempertahankan hanya review yang benar-benar tersedia.
- Agoda tetap memiliki status `completed_source_limit` bila endpoint sumber berhenti mengembalikan review pada batas retrieval yang teramati.

## [1.1.5] - 2026-09-03

- Membersihkan `review_text` Trip dari toolbar/label terjemahan.
- Menolak agregasi metadata reviewer/kamar/perjalanan yang salah terpilih sebagai `review_text`.
- Menambahkan stabilisasi awal jumlah card Trip pada halaman pendek.
- Menambahkan fallback `review_id` Tiket deterministik dengan prefix `synthetic:tiket:` ketika ID native tidak tersedia.

## [1.1.4] - 2026-09-03

- Memisahkan semantik `review_date` dan `stay_detail` pada Trip.
- Tanggal penuh hari-bulan-tahun diprioritaskan sebagai tanggal review.
- Bulan-tahun / informasi menginap diperlakukan sebagai `stay_detail`.

## [1.1.3] - 2026-09-03

- Memperbaiki validator pemilihan `review_date` agar semantic-first dan signature-flexible.
- Menyelaraskan preview/picker dengan perilaku runner untuk field tanggal.

## [1.1.2] - 2026-09-03

- Menambahkan inspeksi terminal read-only saat batas langkah tercapai.
- Memisahkan status `completed`, `completed_step_limit`, dan `completed_source_limit` secara lebih tegas.

## [1.1.1] - 2026-09-03

- Default DOM baru: multipage, 5 langkah, jeda 3 detik, tombol halaman berikutnya.
- Menambahkan status `completed_step_limit` / `USER_STEP_LIMIT_REACHED`.

## [1.1.0] - 2026-09-03

- Menambahkan UI Isolation dan Browser Monitor read-only.
- Menambahkan status batas sumber Agoda.
- Memperkuat pembacaan `review_text` Trip.
- Menyederhanakan workflow `canonical_object` pada Dataset Gabungan.

## [1.0.21]

- Menjadi baseline pagination DOM yang stabil untuk Trip/Tiket/Agoda pada rangkaian pengujian pengembangan.
- Memperbaiki navigasi Trip melewati window paginator, termasuk transisi halaman 5 ke 6 dan seterusnya.

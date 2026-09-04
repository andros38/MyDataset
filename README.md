# MyDataset

MyDataset adalah aplikasi desktop berbasis **Electron + Node.js** untuk mengumpulkan, membersihkan, mengaudit, menggabungkan, dan mengekspor data review web menjadi dataset terstruktur untuk kebutuhan analisis dan penelitian.

**Versi:** 1.1.6  
**Status:** Stable / Maintenance Mode  
**Platform utama:** Windows 10/11 x64  
**Lisensi:** MIT  
**Dibuat oleh:** Ahmad Asyhari

> Pengembangan fitur utama telah selesai. Versi ini dibekukan sebagai baseline stabil. Pembaruan berikutnya hanya ditujukan untuk perbaikan bug penting atau penyesuaian kompatibilitas jika diperlukan.

## Fitur utama

- Akuisisi data melalui **HAR / Network**.
- Akuisisi interaktif melalui **Halaman Web / DOM** untuk sumber yang didukung.
- Browser tertanam untuk konfigurasi dan pengambilan DOM.
- Pemilihan field review secara visual.
- Pagination multi-halaman dengan checkpoint dan audit proses.
- Cleaning dan normalisasi field.
- Audit duplikat pasti dan potensi duplikat.
- Provenance data dan identitas sumber.
- Penggabungan beberapa sesi menjadi **Dataset Gabungan**.
- Normalisasi rating lintas skala ketika diperlukan.
- Export dataset untuk analisis lanjutan.
- Riwayat run, status coverage, dan rincian proses.
- Browser Monitor read-only selama scraping aktif.
- Fallback `review_id` sintetis yang tetap dibedakan dari ID asli sumber.

## Dukungan sumber dan metode

| Website | HAR / Network | Halaman Web / DOM | Adapter HAR utama |
|---|---:|---:|---|
| Traveloka | Ya | Tidak | `getReviews` |
| Tiket | Ya | Ya | `verticalReview/internalReview` |
| Agoda | Ya | Ya | `ReviewComments` |
| Trip | Ya | Ya | `getHotelCommentInfo` |
| Booking | Ya | Tidak | GraphQL `ReviewList` |

Nama website pada aplikasi ditulis sebagai **Traveloka, Tiket, Agoda, Trip, dan Booking**. MyDataset bukan aplikasi resmi dari platform-platform tersebut.

## Metode 1 — HAR / Network

HAR direkomendasikan untuk dataset berukuran besar karena response JSON umumnya lebih deterministik dibanding struktur visual halaman.

Alur umum:

1. Buka halaman review pada Chrome atau Edge.
2. Buka **DevTools → Network**.
3. Aktifkan **Preserve log** bila diperlukan.
4. Lakukan pagination sampai data yang diperlukan termuat.
5. Simpan melalui **Save all as HAR with content**.
6. Impor file `.har` ke MyDataset.
7. Periksa website, objek, response, pagination, coverage, dan status hasil.

MyDataset hanya dapat memproses response yang benar-benar terdapat di dalam HAR. File HAR yang berhasil diimpor tidak otomatis dianggap mencakup seluruh populasi sumber.

## Metode 2 — Halaman Web / DOM

DOM tersedia untuk **Tiket, Agoda, dan Trip**.

Alur umum:

1. Pilih **Halaman Web / DOM**.
2. Pilih website target.
3. Buka URL pada browser tertanam.
4. Pilih field review secara visual.
5. Periksa preview dan pemetaan field.
6. Atur cakupan, batas langkah, jeda, dan metode pagination.
7. Jalankan pengambilan.

Metode DOM bergantung pada HTML, SPA state, cookie/session, A/B testing, koneksi, serta perubahan antarmuka website. Untuk akuisisi besar, HAR tetap direkomendasikan bila tersedia.

## Coverage dan keterbatasan sumber

MyDataset membedakan beberapa kondisi penyelesaian run, antara lain:

- `completed` — akhir sumber dapat diverifikasi.
- `completed_step_limit` — batas langkah pengguna tercapai; akhir sumber belum diklaim.
- `completed_source_limit` — sumber berhenti pada batas retrieval yang teramati.

Jumlah yang dilaporkan website tidak selalu sama dengan jumlah review yang benar-benar ditampilkan. Sebuah website dapat menyaring, menyembunyikan, atau membatasi review pada listing/endpoint tertentu. MyDataset tidak mengarang record yang tidak tersedia dari sumber.

Contoh yang teramati pada pengujian Trip: website dapat melaporkan total review lebih besar daripada review yang benar-benar tampil pada listing karena sebagian review disaring oleh sumber. Dalam kondisi tersebut, coverage MyDataset dinilai terhadap data yang benar-benar tersedia untuk metode akuisisi yang digunakan.

## Provenance dan identitas review

MyDataset mempertahankan informasi provenance agar data hasil tidak kehilangan konteks sumber.

Jika Tiket tidak menyediakan ID native untuk sebuah review, MyDataset dapat menghasilkan fallback deterministik:

```text
synthetic:tiket:<hash>
```

Prefix `synthetic:` sengaja dipertahankan agar ID tersebut tidak disalahartikan sebagai ID asli website.

Audit identitas menyimpan jumlah:

- native review ID;
- synthetic review ID;
- missing review ID.

## Audit duplikat

- **Duplikat Pasti** hanya dipisahkan bila identitas yang cukup kuat menunjukkan record yang sama.
- Kemiripan teks, reviewer, rating, atau tanggal diperlakukan sebagai **Potensi Duplikat** dan tidak dihapus otomatis.
- Dataset Gabungan membedakan kandidat intra-session dan lintas sumber.

## Rating dan normalisasi

- `rating_score` dan `rating_max` disimpan terpisah.
- Nilai rating asli tetap dipertahankan.
- Dataset Gabungan dapat menambahkan `rating_normalized` bila terdapat lebih dari satu skala rating.
- Target normalisasi lintas skala adalah 10.

## Identitas objek lintas sumber

Single-run mempertahankan nama sumber pada `source_object_name`.

Pada Dataset Gabungan:

- `canonical_object` dapat ditentukan manual melalui **Nama objek gabungan**;
- jika kosong, pencocokan otomatis dapat digunakan;
- `source_object_name` tetap menyimpan nama asli dari masing-masing website.

## Schema

Schema canonical:

```text
mydataset-review-v8
```

Schema standard:

```text
mydataset-review-standard-v8
```

Field utama antara lain:

- `review_id`
- `canonical_object`
- `source_object_name`
- `review_provider`
- `review_title`
- `review_text`
- `review_original_text`
- `review_positive_text`
- `review_negative_text`
- `review_date`
- `rating_score`
- `rating_max`
- `rating_label`
- reviewer / travel / room metadata
- `stay_start_date`
- `stay_end_date`
- `stay_detail`
- `source_site`
- `source_url`
- acquisition / session / run provenance

## Menjalankan dari source

### Persyaratan

- Windows 10/11 x64
- **Node.js 22.12.0 atau lebih baru**
- npm
- koneksi internet saat pemasangan dependency pertama

### Cara termudah

1. Clone atau download repository.
2. Buka folder MyDataset.
3. Jalankan:

```text
START-MYDATASET.bat
```

Script akan menjalankan `npm ci` pada penggunaan pertama, lalu membuka aplikasi Electron.

### Cara manual

```bash
npm ci
npm start
```

## Membuat aplikasi Windows EXE

Repository sudah menyertakan:

```text
BUILD-EXE-WINDOWS.bat
```

Persyaratan build:

- Windows 10/11 x64
- Node.js 22.12.0 atau lebih baru
- npm
- koneksi internet saat dependency Electron/electron-builder belum tersedia

Cara build:

1. Clone/download repository.
2. Jalankan `BUILD-EXE-WINDOWS.bat`.
3. Tunggu `npm ci` dan `electron-builder` selesai.
4. EXE akan dibuat pada:

```text
dist\MyDataset-v1.1.6-Windows-x64.exe
```

Perintah manual yang setara:

```bash
npm ci
npm run build:win
```

Hasil build adalah **portable Windows x64 EXE**. Pengguna file EXE tidak perlu menginstal Node.js secara terpisah.

## Lokasi data pengguna

Workspace utama berada di:

```text
Documents\MyDataset\
```

Folder tersebut menyimpan project, run, dataset individual, Dataset Gabungan, audit, checkpoint, dan metadata proses.

## MyDataset Capture

Folder `chrome-extension` disertakan sebagai pendamping capture historis/opsional. Workflow Network utama tetap **HAR with content**.

## Struktur repository

```text
MyDataset/
├── src/
│   ├── core/
│   ├── engine/
│   ├── shared/
│   └── ui/
├── chrome-extension/
├── build/
├── .gitignore
├── BUILD-EXE-WINDOWS.bat
├── START-MYDATASET.bat
├── CHANGELOG.md
├── LICENSE
├── package.json
├── package-lock.json
└── README.md
```

## Catatan penelitian dan penggunaan data

MyDataset dirancang sebagai perangkat bantu pengumpulan dan pengolahan dataset. Pengguna bertanggung jawab memastikan pengambilan dan penggunaan data sesuai dengan ketentuan situs, izin akses, kebijakan privasi, serta kebutuhan etika penelitian yang berlaku.

Aplikasi tidak dimaksudkan untuk melewati autentikasi, pembatasan akses, atau mekanisme proteksi website.

## Project status

**Stable / Maintenance Mode.**

v1.1.6 merupakan versi final yang dibekukan untuk penggunaan dan dokumentasi penelitian. Pengembangan fitur utama dihentikan. Perubahan berikutnya, bila ada, sebaiknya dibatasi pada bug penting atau kompatibilitas.

Riwayat perubahan tersedia di [CHANGELOG.md](CHANGELOG.md).

## Lisensi

MyDataset dirilis dengan **MIT License**. Lihat [LICENSE](LICENSE).

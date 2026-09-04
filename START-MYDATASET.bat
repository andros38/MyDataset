@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo MyDataset v1.1.6 - Source / Node.js
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js belum terpasang.
  echo Pasang Node.js 22.12.0 atau lebih baru, lalu jalankan file ini lagi.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm tidak ditemukan pada PATH.
  echo Perbaiki instalasi Node.js lalu coba lagi.
  pause
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number); process.exit(v[0]>22 || (v[0]===22 && v[1]>=12) ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Versi Node.js terlalu lama.
  echo Diperlukan Node.js 22.12.0 atau lebih baru.
  node --version
  pause
  exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" (
  echo Menyiapkan dependency MyDataset untuk pertama kali...
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto :error
)

echo Menjalankan MyDataset...
call "node_modules\.bin\electron.cmd" .
exit /b %errorlevel%

:error
echo.
echo [ERROR] Dependency tidak dapat dipasang.
echo Periksa koneksi internet dan instalasi Node.js/npm.
pause
exit /b 1

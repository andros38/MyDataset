@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo Build MyDataset v1.1.6 - Windows x64 EXE
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js belum terpasang.
  echo Pasang Node.js 22.12.0 atau lebih baru.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm tidak ditemukan pada PATH.
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

echo [1/2] Memasang dependency build...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :error

echo.
echo [2/2] Membuat portable EXE Windows x64...
call npm run build:win
if errorlevel 1 goto :error

echo.
echo ========================================
echo BUILD SELESAI
echo ========================================
echo File hasil:
echo   dist\MyDataset-v1.1.6-Windows-x64.exe
echo.
echo Pengguna EXE tidak perlu menginstal Node.js.
pause
exit /b 0

:error
echo.
echo ========================================
echo BUILD GAGAL
echo ========================================
echo Periksa pesan error di atas.
pause
exit /b 1

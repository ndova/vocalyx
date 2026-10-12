@echo off
rem Interpreter Python 3.11 untuk script build/staging (bytecode harus 3.11).
rem Urutan: runtime repo -> runtime terpasang -> python PATH.
rem DelayedExpansion WAJIB: %errorlevel% di dalam blok kurung (...) mengembang
rem saat blok di-parse (selalu 0) sehingga kegagalan build terlihat sukses.
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
if exist "build\runtime\python.exe" (
  build\runtime\python.exe %*
  exit /b !errorlevel!
)
if exist "%APPDATA%\VocaLyx\runtime\python.exe" (
  "%APPDATA%\VocaLyx\runtime\python.exe" %*
  exit /b !errorlevel!
)
python %*
exit /b %errorlevel%

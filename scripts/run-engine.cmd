@echo off
rem VocaLyx engine launcher — picks a working Python regardless of PATH.
rem DEV ONLY: buka auth engine (tanpa token) karena frontend vite tanpa Tauri
rem tak bisa baca file token. Rilis (spawn via Tauri) TIDAK PERNAH set ini.
set VX_ENGINE_OPEN=1
rem Order: repo portable runtime (py3.11, matches staged premium .pyc)
rem   -> installed runtime in %%APPDATA%% -> dev Python 3.13 -> bare `python`.
rem Each candidate must at least import fastapi + PIL or it is skipped.
cd /d "%~dp0.."

if exist "build\runtime\python.exe" (
  build\runtime\python.exe -c "import fastapi, PIL" >nul 2>&1
  if not errorlevel 1 (
    echo [engine] using build\runtime\python.exe
    build\runtime\python.exe -u python-engine/server.py %*
    exit /b %errorlevel%
  )
)

if exist "%APPDATA%\VocaLyx\runtime\python.exe" (
  "%APPDATA%\VocaLyx\runtime\python.exe" -c "import fastapi, PIL" >nul 2>&1
  if not errorlevel 1 (
    echo [engine] using %%APPDATA%%\VocaLyx\runtime\python.exe
    "%APPDATA%\VocaLyx\runtime\python.exe" -u python-engine/server.py %*
    exit /b %errorlevel%
  )
)

if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" -c "import fastapi, PIL" >nul 2>&1
  if not errorlevel 1 (
    echo [engine] using Python313 ^(karaoke AI unavailable: no audio-separator^)
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" -u python-engine/server.py %*
    exit /b %errorlevel%
  )
)

where python >nul 2>&1
if not errorlevel 1 (
  python -c "import fastapi, PIL" >nul 2>&1
  if not errorlevel 1 (
    echo [engine] using PATH python
    python -u python-engine/server.py %*
    exit /b %errorlevel%
  )
)

echo [engine] ERROR: no working Python found.
echo   Install deps into your Python with:
echo     python -m pip install fastapi "uvicorn[standard]" python-multipart Pillow numpy scipy soundfile librosa requests mutagen imageio-ffmpeg yt-dlp ytmusicapi
echo   Or reinstall the app once so %%APPDATA%%\VocaLyx\runtime exists.
exit /b 1

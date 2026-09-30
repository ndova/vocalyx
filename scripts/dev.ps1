# TuneBox dev launcher (Windows)
# Jalankan: powershell -File scripts/dev.ps1  (atau klik kanan > Run with PowerShell)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (-not ($env:Path -split ";" | Where-Object { $_ -like "*\.cargo\bin*" })) {
  $env:Path += ";$env:USERPROFILE\.cargo\bin"
}
cargo --version
npx tauri dev

@echo off
rem ZALET HOME: connect to home over Tailscale and open the panel (asks for admin rights)
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0.zalet\start.ps1"

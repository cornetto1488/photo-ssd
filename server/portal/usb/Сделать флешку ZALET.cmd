@echo off
rem ZALET HOME: format a USB flash drive and write the home-access kit onto it (asks for admin rights)
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0.maker\make-flash.ps1"

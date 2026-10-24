@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更高版本，然后重新打开此文件。
  pause
  exit /b 1
)
node server.js
if errorlevel 1 pause

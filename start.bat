@echo off
title Trakin Thumbnail Studio
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again. & pause & exit /b)
where codex >nul 2>nul || (echo Installing the Codex CLI... & call npm install -g @openai/codex)
call codex login status >nul 2>nul || (echo. & echo Sign in with YOUR ChatGPT account in the browser window that opens... & call codex login)
node server.js --open
pause

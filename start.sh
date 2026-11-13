#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org first."; exit 1; }
command -v codex >/dev/null || npm install -g @openai/codex
codex login status >/dev/null 2>&1 || codex login
node server.js --open

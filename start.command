#!/bin/bash
# macOS: double-click this file (or run ./start.command in Terminal)
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null; then
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/macos/"; read -p "Press Enter to close"; exit 1
fi
[ -x .venv/bin/python ] || { echo "Creating Python environment..."; python3 -m venv .venv || { read -p "Could not create .venv. Press Enter"; exit 1; }; }
if ! .venv/bin/python -c "import uvicorn, fastapi, anthropic, dotenv, bs4" 2>/dev/null; then
  echo "Installing packages..."
  .venv/bin/python -m pip install -r requirements.txt || { read -p "Install failed. Press Enter"; exit 1; }
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Please put your API keys in the .env file, then run this again."
  open -e .env; exit 0
fi
if [ ! -f data/knowledge.json ]; then
  echo "Reading the company website..."
  .venv/bin/python backend/crawler.py
fi
echo "Opening http://localhost:8000 (use Chrome). Press Ctrl+C here to stop."
(sleep 2; open "http://localhost:8000") &
.venv/bin/python -m uvicorn backend.app:app --port 8000

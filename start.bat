@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Creating Python environment...
  python -m venv .venv
  .venv\Scripts\python -m pip install -r requirements.txt
)
if not exist .env (
  copy .env.example .env
  echo Please put your API keys in the .env file, then run this again.
  notepad .env
  exit /b
)
if not exist data\knowledge.json (
  echo Reading the company website...
  .venv\Scripts\python backend\crawler.py
)
echo Open http://localhost:8000 in Chrome or Edge
start "" http://localhost:8000
.venv\Scripts\python -m uvicorn backend.app:app --port 8000

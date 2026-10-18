@echo off
cd /d "%~dp0"
.venv\Scripts\python backend\crawler.py %*
pause

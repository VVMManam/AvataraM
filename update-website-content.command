#!/bin/bash
# macOS: refresh the website content the avatar knows
cd "$(dirname "$0")" || exit 1
.venv/bin/python backend/crawler.py "$@"
read -p "Done. Press Enter to close"

"""
AvataraM backend: serves the avatar web page and answers questions about the company.

Run (from the project folder):
    uvicorn backend.app:app --port 8000
Then open http://localhost:8000
"""
import json
import math
import os
import re
import time
from collections import Counter
from pathlib import Path

import httpx
from anthropic import Anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-haiku-5-5")
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY", "")
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION", "")
# If the whole website is smaller than this, send all of it (cheap with prompt caching).
FULL_CONTEXT_CHARS = int(os.getenv("FULL_CONTEXT_CHARS", "150000"))

CONFIG_PATH = ROOT / "config" / "personas.json"
KNOWLEDGE_PATH = ROOT / "data" / "knowledge.json"
FRONTEND = ROOT / "frontend"

app = FastAPI(title="AvataraM")
client = Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None


def load_config():
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- knowledge
class Knowledge:
    """Website text, with a small BM25 search for large sites."""

    def __init__(self):
        self.mtime = None
        self.full_text = ""
        self.chunks = []

    def _load(self):
        if not KNOWLEDGE_PATH.exists():
            self.full_text, self.chunks, self.mtime = "", [], None
            return
        m = KNOWLEDGE_PATH.stat().st_mtime
        if m == self.mtime:
            return
        data = json.loads(KNOWLEDGE_PATH.read_text(encoding="utf-8"))
        parts, chunks = [], []
        for p in data.get("pages", []):
            parts.append(f"### {p['title']}\nURL: {p['url']}\n{p['text']}")
            text = p["text"]
            for i in range(0, len(text), 1200):
                chunks.append({"url": p["url"], "title": p["title"], "text": text[max(0, i - 150): i + 1200]})
        self.full_text = "\n\n".join(parts)
        self.chunks = chunks
        self._index()
        self.mtime = m

    @staticmethod
    def _tok(s):
        return re.findall(r"\w+", s.lower())

    def _index(self):
        self.docs = [Counter(self._tok(c["title"] + " " + c["text"])) for c in self.chunks]
        self.lens = [sum(d.values()) for d in self.docs]
        self.avg = (sum(self.lens) / len(self.lens)) if self.lens else 1
        df = Counter()
        for d in self.docs:
            df.update(d.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def search(self, query, k=8):
        q = self._tok(query)
        scores = []
        for i, d in enumerate(self.docs):
            s = 0.0
            for t in q:
                if t in d:
                    tf = d[t]
                    s += self.idf.get(t, 0) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * self.lens[i] / self.avg))
            scores.append((s, i))
        top = [i for s, i in sorted(scores, reverse=True)[:k] if s > 0]
        return "\n\n".join(f"### {self.chunks[i]['title']}\nURL: {self.chunks[i]['url']}\n{self.chunks[i]['text']}" for i in top)

    def context_for(self, question, history):
        self._load()
        if not self.full_text:
            return "", False
        if len(self.full_text) <= FULL_CONTEXT_CHARS:
            return self.full_text, True
        query = question
        if re.search(r"[^\x00-\x7F]", question):  # non-English script: get English search words first
            query = english_keywords(question) + " " + question
        recent = " ".join(h.get("content", "") for h in history[-2:] if h.get("role") == "user")
        return self.search(query + " " + recent), False


KB = Knowledge()


def english_keywords(text):
    try:
        r = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=60,
            messages=[{"role": "user", "content": f"Give 5-10 English search keywords for this question. Keywords only.\n\n{text}"}],
        )
        return r.content[0].text
    except Exception:  # noqa: BLE001
        return ""


# ---------------------------------------------------------------- API
class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    language: str = "en-IN"
    gender: str = "F"
    history: list[dict] = []


SYSTEM = """You are {name}, a friendly spoken AI assistant (a talking avatar) for {company}.
Visitors talk to you by voice to learn about the company.

Rules:
- Answer ONLY using the website content below. If the answer is not there, say you don't have that detail and suggest contacting {company} through {website}.
- Reply in {language_label} (language code {language}), even if the content is in English. Use natural, everyday wording a native speaker would use; keep company, product and technical names as they are.
- Your reply will be spoken aloud: 2-4 short sentences, no markdown, no bullet points, no emojis, no URLs unless asked.
- Be warm and professional. Never invent prices, clients, numbers or contact details.

WEBSITE CONTENT ({website}):
{content}"""


@app.post("/api/chat")
def chat(body: ChatIn):
    if not client:
        raise HTTPException(500, "ANTHROPIC_API_KEY is missing in .env")
    cfg = load_config()
    lang = cfg["languages"].get(body.language) or cfg["languages"][cfg["defaultLanguage"]]
    persona = lang.get(body.gender) or lang["F"]
    content, full = KB.context_for(body.message, body.history)
    if not content:
        content = "(No website content loaded yet. Tell the visitor the knowledge base is being prepared.)"

    system = [{
        "type": "text",
        "text": SYSTEM.format(name=persona["name"], company=cfg["company"], website=cfg["website"],
                              language_label=lang["label"], language=body.language, content=content),
    }]
    if full:
        system[0]["cache_control"] = {"type": "ephemeral"}  # reuse the website text cheaply between questions

    msgs = [{"role": h["role"], "content": str(h["content"])[:2000]}
            for h in body.history[-8:] if h.get("role") in ("user", "assistant") and h.get("content")]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    msgs.append({"role": "user", "content": body.message})

    r = client.messages.create(model=CLAUDE_MODEL, max_tokens=400, system=system, messages=msgs)
    answer = "".join(b.text for b in r.content if b.type == "text").strip()
    return {"answer": answer, "persona": persona["name"]}


_token = {"value": None, "exp": 0}


@app.get("/api/speech-token")
def speech_token():
    """Short-lived Azure Speech token, so the Azure key never reaches the browser."""
    if not (AZURE_SPEECH_KEY and AZURE_SPEECH_REGION):
        raise HTTPException(500, "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION missing in .env")
    if _token["value"] and time.time() < _token["exp"]:
        return {"token": _token["value"], "region": AZURE_SPEECH_REGION}
    r = httpx.post(f"https://{AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken",
                   headers={"Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY}, timeout=10)
    if r.status_code != 200:
        raise HTTPException(502, f"Azure token error {r.status_code}: check key and region")
    _token.update(value=r.text, exp=time.time() + 8 * 60)  # tokens last 10 minutes
    return {"token": r.text, "region": AZURE_SPEECH_REGION}


@app.get("/api/config")
def config():
    cfg = load_config()
    KB._load()
    cfg["knowledgePages"] = len({c["url"] for c in KB.chunks})
    return cfg


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")

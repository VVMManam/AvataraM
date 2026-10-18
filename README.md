# AvataraM – Talking AI Avatar for Manam Technologies

A 3D talking avatar that answers questions about Manam Technologies, using only content from
www.manamtechnologies.com. It hears which language the visitor speaks and switches to a
persona for that language (male or female), then answers out loud with lip-sync.

```
 Visitor speaks ──► Azure Speech-to-Text (+ language detection)
                         │  "hi-IN"
                         ▼
 Website content ──► Claude (Haiku) writes the answer in Hindi as persona "Priya"/"Rahul"
 (data/knowledge.json)   │
                         ▼
                    Azure Neural Voice (hi-IN-SwaraNeural) + viseme timings
                         │
                         ▼
                    3D avatar (TalkingHead) speaks with lip-sync
```

## 1. Get your two keys (one-time, ~10 minutes)

| Service | What it does | Where | Cost |
|---|---|---|---|
| **Anthropic (Claude)** | The "brain" that writes answers | console.anthropic.com → API Keys | Pay per use, a few $ a month at low traffic |
| **Azure AI Speech** | Hears the visitor, detects language, speaks with male/female voices | Azure Portal → Create resource → "Speech service" → Pricing tier **Free F0** → Keys and Endpoint | Free tier: 5 h speech-to-text + 0.5 M characters of voice per month |

Note the Azure **Key 1** and **Region**, for example `centralindia` or `uksouth`.

## 2. Run it (Windows)

Install **Python 3.10+** from python.org (tick "Add to PATH"), then:

1. Double-click **`start.bat`**. The first time, it installs everything and opens `.env` in Notepad.
2. Paste your keys into `.env`, save, and close Notepad.
3. Double-click **`start.bat`** again. It reads the website the first time, then opens **http://localhost:8000**.
4. Use **Chrome or Edge**, allow the microphone, tap the blue mic and speak.

When the website changes, double-click **`update-website-content.bat`** to refresh the content the agent knows.

Manual commands (any OS):
```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
copy .env.example .env      # then edit it
python backend/crawler.py   # add --render if the site is built with JavaScript
python -m uvicorn backend.app:app --port 8000
```

> If the crawler reports "Very little text found", run
> `pip install playwright && python -m playwright install chromium`, then
> `python backend/crawler.py --render`.

## 3. Customise: `config/personas.json`

- **Languages and personas.** Each language has an `F` and an `M` persona, each with a name and an Azure voice.
  The full voice list is in Azure Speech Studio → Voice Gallery.
- **`speechCandidates`.** The languages the microphone auto-detects. Azure allows up to **4**; the default is
  English, Hindi, Telugu and Arabic. Swap one for `ta-IN` to add Tamil. Every other language can still be picked from the drop-down.
- **Avatars.** By default every persona shares one female and one male 3D model. To give each language its own
  look (for example an Indian woman for Priya or an Emirati man for Hamdan), add `"avatar": "avatars/priya.glb"` to that persona.

### Making your own avatars (free)
The two included models are **demo models for non-commercial use only** (the male one has a vendor logo on the shirt).
Replace them before going live:
- **Avaturn** (avaturn.me): build a realistic avatar from a selfie and export it as `.glb`. You need a model with ARKit + Oculus viseme blend shapes; enable that export option.
- **MPFB for Blender** (free, CC0): full control over age, gender and ethnicity. See the TalkingHead guide.
Put the `.glb` files in `frontend/avatars/` and reference them in `personas.json`.

## 4. Project layout
```
backend/crawler.py      reads the website → data/knowledge.json
backend/app.py          API: /api/chat (Claude), /api/speech-token (Azure), serves the web page
config/personas.json    languages, voices, names, avatars
frontend/               web page (index.html, app.js, styles.css), 3D avatars, TalkingHead library (MIT)
```

## 5. Notes
- Your keys stay on the server. The browser only receives a 10-minute Azure token.
- Answers come only from the crawled website. If the content doesn't cover a question, the agent says so.
- For small websites the whole site is sent with each question, using prompt caching to keep it cheap.
  For large sites, only the most relevant sections are sent.
- Visitors choose the avatar gender with the Female/Male switch. Language is detected automatically, or can be fixed in the drop-down.
- To publish it on the internet, deploy to Render, Railway or Azure App Service and set the same `.env` values there.
  Browsers allow microphone access only over HTTPS.

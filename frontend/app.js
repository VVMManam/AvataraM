import { TalkingHead } from "talkinghead";
import { makeChild, dress } from "./kids.js";

const SDK = window.SpeechSDK;
const $ = (id) => document.getElementById(id);

// Azure viseme ID (0-21) -> Oculus viseme used by TalkingHead
const VISEME_MAP = ["sil", "aa", "aa", "O", "E", "RR", "I", "U", "O", "O", "O", "I",
                    "kk", "RR", "nn", "SS", "CH", "TH", "FF", "DD", "kk", "PP"];

let cfg, head;
let loadedAvatar = null;
const state = { lang: null, gender: null, auto: true, busy: false, history: [] };
const speech = { token: null, region: null, at: 0 };

// ------------------------------------------------------------------ setup
async function init() {
  cfg = await (await fetch("/api/config")).json();
  state.lang = cfg.defaultLanguage;
  state.gender = cfg.defaultGender;

  $("companyName").textContent = cfg.company;
  $("kbInfo").textContent = cfg.knowledgePages
    ? `AI assistant · ${cfg.knowledgePages} website pages loaded`
    : "AI assistant · website not crawled yet";

  const sel = $("langSelect");
  sel.add(new Option("Auto-detect", "auto"));
  for (const [code, l] of Object.entries(cfg.languages)) sel.add(new Option(l.label, code));
  sel.value = "auto";
  sel.onchange = async () => {
    state.auto = sel.value === "auto";
    if (!state.auto) await setPersona({ lang: sel.value });
  };

  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.onclick = () => setPersona({ gender: b.dataset.gender });
  });

  head = new TalkingHead($("avatar"), {
    ttsEndpoint: "",            // not used: Azure speech is handled in this file
    lipsyncModules: ["en"],
    lipsyncLang: "en",
    cameraView: "upper",
    avatarMood: "neutral",
  });

  $("micBtn").onclick = listen;
  $("askForm").onsubmit = (e) => {
    e.preventDefault();
    const text = $("textInput").value.trim();
    if (!text) return;
    $("textInput").value = "";
    const lang = state.auto ? detectScript(text) : state.lang;
    ask(text, lang);
  };

  document.addEventListener("visibilitychange", () => {
    document.visibilityState === "visible" ? head.start() : head.stop();
  });

  await setPersona({});
}

function persona() {
  const L = cfg.languages[state.lang];
  return { ...L[state.gender], label: L.label };
}

async function setPersona({ lang = state.lang, gender = state.gender }) {
  state.lang = lang;
  state.gender = gender;
  const p = persona();
  $("personaName").textContent = p.name;
  $("personaLang").textContent = p.label;
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.gender === gender));
  if (!state.auto) $("langSelect").value = lang;

  const base = cfg.avatars[gender];
  const url = p.avatar || base.url;
  if (url === loadedAvatar) { dress(head, base.child, p.outfit); return; }
  $("loading").hidden = false;
  $("loading").textContent = "Loading avatar…";
  try {
    head.stopSpeaking();
    await head.showAvatar({ ...base, url, lipsyncLang: "en", avatarMood: "neutral" }, (ev) => {
      if (ev.lengthComputable) $("loading").textContent = `Loading avatar ${Math.round((ev.loaded / ev.total) * 100)}%`;
    });
    makeChild(head, base.child);
    dress(head, base.child, p.outfit);
    loadedAvatar = url;
    $("loading").hidden = true;
  } catch (err) {
    console.error(err);
    $("loading").textContent = "Could not load the avatar model (" + url + ")";
  }
}

// Language of typed text, from its script (used when language is Auto-detect)
function detectScript(text) {
  const has = (code) => code in cfg.languages;
  if (/[ఀ-౿]/.test(text) && has("te-IN")) return "te-IN";
  if (/[஀-௿]/.test(text) && has("ta-IN")) return "ta-IN";
  if (/[ऀ-ॿ]/.test(text) && has("hi-IN")) return "hi-IN";
  if (/[؀-ۿ]/.test(text) && has("ar-AE")) return "ar-AE";
  return state.lang.startsWith("en") ? state.lang : (has("en-IN") ? "en-IN" : cfg.defaultLanguage);
}

// ------------------------------------------------------------------ Azure speech
async function speechConfig() {
  if (!speech.token || Date.now() - speech.at > 7 * 60 * 1000) {
    const r = await fetch("/api/speech-token");
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "Speech token failed");
    Object.assign(speech, { token: j.token, region: j.region, at: Date.now() });
  }
  return SDK.SpeechConfig.fromAuthorizationToken(speech.token, speech.region);
}

async function listen() {
  head.audioCtx?.resume();
  if (head.isSpeaking) head.stopSpeaking();      // tap to interrupt
  if (state.busy) return;
  state.busy = true;
  const mic = $("micBtn");
  mic.classList.add("listening");
  status("Listening…");
  try {
    const sc = await speechConfig();
    const audio = SDK.AudioConfig.fromDefaultMicrophoneInput();
    let rec;
    if (state.auto) {
      const auto = SDK.AutoDetectSourceLanguageConfig.fromLanguages(cfg.speechCandidates.slice(0, 4));
      rec = SDK.SpeechRecognizer.FromConfig(sc, auto, audio);
    } else {
      sc.speechRecognitionLanguage = state.lang;
      rec = new SDK.SpeechRecognizer(sc, audio);
    }
    rec.recognizing = (_, e) => status("Hearing: " + e.result.text);
    const result = await new Promise((res, rej) => rec.recognizeOnceAsync(res, rej));
    rec.close();
    mic.classList.remove("listening");

    if (result.reason !== SDK.ResultReason.RecognizedSpeech || !result.text) {
      status("Sorry, I didn't catch that. Tap the mic and try again.");
      state.busy = false;
      return;
    }
    let lang = state.lang;
    if (state.auto) lang = SDK.AutoDetectSourceLanguageResult.fromResult(result).language || lang;
    state.busy = false;
    await ask(result.text, lang);
  } catch (err) {
    mic.classList.remove("listening");
    state.busy = false;
    showError(err);
  }
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function speak(text) {
  const p = persona();
  const sc = await speechConfig();
  sc.speechSynthesisOutputFormat = SDK.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
  const synth = new SDK.SpeechSynthesizer(sc, null);   // null = don't play; TalkingHead plays it
  const vis = [];
  const words = [];
  synth.visemeReceived = (_, e) => vis.push({ v: VISEME_MAP[e.visemeId] || "sil", t: e.audioOffset / 10000 });
  synth.wordBoundary = (_, e) => {
    if (e.boundaryType === SDK.SpeechSynthesisBoundaryType.Punctuation) return;
    words.push({ w: e.text, t: e.audioOffset / 10000, d: Math.max(50, e.duration / 10000) });
  };

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${state.lang}">` +
               `<voice name="${p.voice}"><prosody pitch="${p.pitch ?? cfg.avatars[state.gender].pitch ?? "+0%"}">${escapeXml(text)}</prosody></voice></speak>`;
  const result = await new Promise((res, rej) => synth.speakSsmlAsync(ssml, res, rej));
  synth.close();
  if (result.reason !== SDK.ResultReason.SynthesizingAudioCompleted) {
    throw new Error("Speech synthesis failed: " + (result.errorDetails || result.reason));
  }

  const audio = await head.audioCtx.decodeAudioData(result.audioData.slice(0));
  const lip = vis.length ? fromVisemes(vis, audio.duration * 1000) : fromWords(words);
  head.speakAudio({
    audio,
    words: words.map((x) => x.w), wtimes: words.map((x) => x.t), wdurations: words.map((x) => x.d),
    visemes: lip.visemes, vtimes: lip.vtimes, vdurations: lip.vdurations,
  }, { lipsyncLang: "en" });
}

function fromVisemes(vis, totalMs) {
  vis.sort((a, b) => a.t - b.t);
  const out = { visemes: [], vtimes: [], vdurations: [] };
  vis.forEach((x, i) => {
    const end = i + 1 < vis.length ? vis[i + 1].t : Math.min(x.t + 120, totalMs);
    out.visemes.push(x.v); out.vtimes.push(x.t); out.vdurations.push(Math.max(20, end - x.t));
  });
  return out;
}

// Fallback if a voice gives no visemes: simple open/close mouth per syllable
function fromWords(words) {
  const shapes = ["aa", "E", "O", "I", "U"];
  const out = { visemes: [], vtimes: [], vdurations: [] };
  for (const w of words) {
    const n = Math.max(1, Math.round([...w.w].length / 3));
    const step = w.d / n;
    for (let i = 0; i < n; i++) {
      out.visemes.push(shapes[(i + w.w.length) % shapes.length]);
      out.vtimes.push(w.t + i * step);
      out.vdurations.push(step * 0.8);
    }
  }
  return out;
}

// ------------------------------------------------------------------ conversation
async function ask(text, lang) {
  if (state.busy) return;
  state.busy = true;
  setButtons(false);
  head.audioCtx?.resume();
  try {
    if (lang && lang !== state.lang && cfg.languages[lang]) await setPersona({ lang });
    addMsg("user", text, "You");
    status(`${persona().name} is thinking…`);

    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, language: state.lang, gender: state.gender, history: state.history }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "Chat request failed");

    state.history.push({ role: "user", content: text }, { role: "assistant", content: j.answer });
    state.history = state.history.slice(-12);
    addMsg("bot", j.answer, j.persona);
    showCaption(j.answer);
    status("");
    await speak(j.answer);
  } catch (err) {
    showError(err);
  } finally {
    state.busy = false;
    setButtons(true);
  }
}

function addMsg(kind, text, who) {
  const el = document.createElement("div");
  el.className = "msg " + kind;
  el.dir = "auto";
  const w = document.createElement("span");
  w.className = "who";
  w.textContent = who;
  el.append(w, document.createTextNode(text));
  $("log").append(el);
  $("log").scrollTop = $("log").scrollHeight;
}

function showCaption(text) {
  const c = $("caption");
  c.textContent = text;
  c.dir = "auto";
  c.hidden = false;
  clearTimeout(showCaption.t);
  showCaption.t = setTimeout(() => (c.hidden = true), Math.max(6000, text.length * 90));
}

function status(t) { $("status").textContent = t; }
function setButtons(on) { $("micBtn").disabled = !on; document.querySelector(".send").disabled = !on; }
function showError(err) {
  console.error(err);
  status("");
  addMsg("bot error", String(err.message || err), "Error");
}

init().catch(showError);

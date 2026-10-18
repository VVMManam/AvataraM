"""
Crawl the company website and save its text to data/knowledge.json.

Usage (from the project folder):
    python backend/crawler.py                       # crawl www.manamtechnologies.com
    python backend/crawler.py --max-pages 300
    python backend/crawler.py --render              # for JavaScript-built sites (needs Playwright)

Re-run whenever the website changes. The AI agent only answers from this file.
"""
import argparse
import json
import re
import sys
import time
from collections import deque
from pathlib import Path
from urllib.parse import urljoin, urlparse, urldefrag

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "knowledge.json"
CONFIG = json.loads((ROOT / "config" / "personas.json").read_text(encoding="utf-8"))

SKIP_EXT = re.compile(r"\.(jpg|jpeg|png|gif|svg|webp|ico|pdf|zip|rar|mp4|mp3|wav|css|js|json|xml|woff2?|ttf|eot)$", re.I)
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; AvataraM-KnowledgeBot/1.0)"}


def norm(url: str) -> str:
    url, _ = urldefrag(url)
    p = urlparse(url)
    path = p.path.rstrip("/") or "/"
    return f"{p.scheme}://{p.netloc.lower()}{path}" + (f"?{p.query}" if p.query else "")


def same_site(url: str, host: str) -> bool:
    h = urlparse(url).netloc.lower().removeprefix("www.")
    return h == host


def extract(html: str):
    soup = BeautifulSoup(html, "html.parser")
    title = (soup.title.string or "").strip() if soup.title else ""
    links = [a.get("href") for a in soup.find_all("a", href=True)]
    for tag in soup(["script", "style", "noscript", "svg", "iframe", "form"]):
        tag.decompose()
    # Keep header/nav/footer out of the main text (they repeat on every page)
    for tag in soup.find_all(["nav", "footer"]):
        tag.decompose()
    lines = []
    for line in soup.get_text("\n").splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if len(line) > 1:
            lines.append(line)
    return title, "\n".join(lines), links


def sitemap_urls(base: str):
    urls = []
    try:
        r = requests.get(urljoin(base, "/sitemap.xml"), headers=HEADERS, timeout=15)
        if r.ok:
            urls = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", r.text)
    except requests.RequestException:
        pass
    return urls


class Fetcher:
    def __init__(self, render: bool):
        self.render = render
        if render:
            try:
                from playwright.sync_api import sync_playwright
            except ImportError:
                sys.exit("Install Playwright first:  pip install playwright  &&  python -m playwright install chromium")
            self._pw = sync_playwright().start()
            self._browser = self._pw.chromium.launch()
            self._page = self._browser.new_page()

    def get(self, url: str):
        if self.render:
            self._page.goto(url, wait_until="networkidle", timeout=45000)
            return self._page.content(), self._page.url
        r = requests.get(url, headers=HEADERS, timeout=20)
        if not r.ok or "text/html" not in r.headers.get("content-type", ""):
            return None, url
        return r.text, r.url

    def close(self):
        if self.render:
            self._browser.close()
            self._pw.stop()


def crawl(start: str, max_pages: int, render: bool, delay: float):
    host = urlparse(start).netloc.lower().removeprefix("www.")
    queue = deque([start] + [u for u in sitemap_urls(start) if same_site(u, host)])
    seen, pages, texts_seen = set(), [], set()
    fetcher = Fetcher(render)
    try:
        while queue and len(pages) < max_pages:
            url = norm(queue.popleft())
            if url in seen or SKIP_EXT.search(urlparse(url).path):
                continue
            seen.add(url)
            try:
                html, final_url = fetcher.get(url)
            except Exception as e:  # noqa: BLE001
                print(f"  ! {url}: {e}")
                continue
            if not html:
                continue
            title, text, links = extract(html)
            key = hash(text)
            if len(text) > 80 and key not in texts_seen:
                texts_seen.add(key)
                pages.append({"url": final_url, "title": title, "text": text})
                print(f"  + [{len(pages):3}] {final_url}  ({len(text)} chars)")
            for href in links:
                if href.startswith(("mailto:", "tel:", "javascript:")):
                    continue
                nxt = urljoin(final_url, href)
                if same_site(nxt, host) and norm(nxt) not in seen:
                    queue.append(nxt)
            time.sleep(delay)
    finally:
        fetcher.close()
    return pages


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=CONFIG["website"])
    ap.add_argument("--max-pages", type=int, default=150)
    ap.add_argument("--render", action="store_true", help="use a headless browser (for JS-built sites)")
    ap.add_argument("--delay", type=float, default=0.3, help="seconds between requests")
    args = ap.parse_args()

    print(f"Crawling {args.url} ...")
    pages = crawl(args.url, args.max_pages, args.render, args.delay)
    total = sum(len(p["text"]) for p in pages)
    if total < 1500 and not args.render:
        print("\nVery little text found - the site is probably built with JavaScript.")
        print("Run again with:  python backend/crawler.py --render")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"source": args.url, "crawled_at": time.strftime("%Y-%m-%d %H:%M"),
                               "pages": pages}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nSaved {len(pages)} pages ({total:,} characters) to {OUT}")


if __name__ == "__main__":
    main()

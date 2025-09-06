#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Scrape Minnesota DNR park pages for:
- park name
- official DNR URL
- "Park highlights"
- "Park hours"
- Wikimedia/Wikipedia image (best effort)

Output: parks.json (UTF-8, pretty)
"""

import re
import json
import time
import html
import logging
import unicodedata
from typing import List, Dict, Optional
from urllib.parse import urljoin, urlencode

import requests
from bs4 import BeautifulSoup

BASE = "https://www.dnr.state.mn.us"
INDEX_URL = "https://www.dnr.state.mn.us/state_parks/list_alpha.html"
HEADERS = {
    "User-Agent": "MN-State-Parks-Scraper/1.0 (Educational use; contact: you@example.com)"
}
DELAY_SEC = 0.7  # be polite

WIKI_API = "https://en.wikipedia.org/w/api.php"


def slugify(text: str) -> str:
    """Generate a stable slug (ASCII-lowercase, dash-separated) for joins."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text


def clean_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def get_index_links() -> List[str]:
    """Fetch the A–Z page and return absolute links to each park page."""
    r = requests.get(INDEX_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    # The A–Z page lists many anchors that point to /state_parks/park.html?id=...
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "state_parks/park.html?id=" in href:
            links.append(urljoin(BASE, href))
    # Deduplicate, preserve order
    seen = set()
    ordered = []
    for u in links:
        if u not in seen:
            seen.add(u)
            ordered.append(u)
    return ordered


def extract_section_text(soup: BeautifulSoup, heading_regex: str) -> Optional[BeautifulSoup]:
    """
    Find a heading whose text matches heading_regex, return the nearest sibling block (ul/ol/p/div)
    that contains the section body.
    """
    # match headings like h2/h3/h4 with text 'Park highlights' or 'Park hours'
    for tag in soup.find_all(re.compile(r"^h[1-6]$")):
        txt = clean_spaces(tag.get_text(separator=" ", strip=True)).lower()
        if re.search(heading_regex, txt, flags=re.I):
            # section content often lives in the next sibling(s)
            node = tag.find_next_sibling()
            # Skip non-element nodes until we find a list or paragraph container
            while node and node.name and node.name in ["script", "style"]:
                node = node.find_next_sibling()
            return node
    return None


def parse_highlights(section_node: BeautifulSoup) -> List[str]:
    """Extract bullet points from the highlights section."""
    items = []
    if not section_node:
        return items

    # Typical structure is <ul><li>...</li></ul>. Fall back to paragraphs if needed.
    ul = section_node if section_node.name == "ul" else section_node.find("ul")
    if ul:
        for li in ul.find_all("li"):
            text = clean_spaces(li.get_text(separator=" ", strip=True))
            if text:
                items.append(text)
        return items

    # Fallback: collect lines from paragraphs/div
    text = clean_spaces(section_node.get_text(separator=" | ", strip=True))
    if text:
        # Split on separators that look like bullets
        for part in re.split(r"\s*\|\s*|;\s*|·\s*|•\s*", text):
            part = clean_spaces(part)
            if part:
                items.append(part)
    return items


def parse_hours(section_node: BeautifulSoup) -> Optional[str]:
    """Extract a readable freeform 'Park hours' block."""
    if not section_node:
        return None
    # Grab text of the following sibling container; park pages often put both
    # 'Park hours' and 'Ranger station hours' together in one block.
    txt = section_node.get_text(separator=" ", strip=True)
    txt = html.unescape(clean_spaces(txt))
    return txt or None


def wiki_image_lookup(park_name: str) -> Optional[Dict]:
    """
    Best-effort Wikimedia image lookup.
    Strategy:
      1) Search for exact 'Park Name, Minnesota' or 'Park Name State Park' on Wikipedia.
      2) If a page found, request a pageimage thumbnail & fullurl.
    Returns dict with {image_thumb, image_source, page_title, page_url, credit} or None.
    """
    candidates = [
        f"{park_name} State Park (Minnesota)",
        f"{park_name}, Minnesota",
        f"{park_name} State Park Minnesota",
        f"{park_name} State Park",
    ]
    for query in candidates:
        params = {
            "action": "query",
            "format": "json",
            "prop": "pageimages|info",
            "inprop": "url",
            "piprop": "thumbnail|name",
            "pithumbsize": 800,
            "generator": "search",
            "gsrsearch": query,
            "gsrlimit": 1,
            "redirects": 1,
            "origin": "*",
        }
        try:
            r = requests.get(WIKI_API, params=params, headers=HEADERS, timeout=30)
            r.raise_for_status()
            data = r.json()
            if "query" not in data or "pages" not in data["query"]:
                continue
            page = list(data["query"]["pages"].values())[0]
            thumb = page.get("thumbnail", {}).get("source")
            page_url = page.get("fullurl")
            title = page.get("title")
            if not page_url:
                page_url = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}" if title else None
            if thumb:
                return {
                    "image_thumb": thumb,
                    "image_source": page_url,
                    "page_title": title,
                    "page_url": page_url,
                    "credit": "Image via Wikipedia/Wikimedia Commons (license varies by file).",
                }
        except Exception:
            continue
    return None


def normalize_join_names(name: str) -> Dict[str, str]:
    """
    Provide several normalized keys to join against the polygon layer if needed.
    """
    n = name
    n = re.sub(r"\s*\(.*?\)\s*", "", n)  # drop parentheticals
    n = n.replace("–", "-").replace("—", "-")
    n = clean_spaces(n)
    bare = (
        n.replace("State Park", "")
         .replace("State Recreation Area", "")
         .replace("State Wayside", "")
         .replace("Underground Mine", "")
         .strip(", ").strip()
    )
    return {
        "name_full": n,
        "name_bare": bare,
        "slug_full": slugify(n),
        "slug_bare": slugify(bare),
    }


def scrape_park(url: str) -> Dict:
    """
    Scrape one park page.
    """
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    # Name: first <h1> often is the park name
    h1 = soup.find("h1")
    if h1:
        name = clean_spaces(h1.get_text(separator=" ", strip=True))
    else:
        # fallback to <title>
        title = soup.title.get_text(strip=True) if soup.title else url
        name = clean_spaces(re.sub(r"\s*\|\s*Minnesota DNR.*$", "", title))

    # Highlights section
    highlights_node = extract_section_text(soup, r"\bpark\s+highlights\b")
    highlights = parse_highlights(highlights_node)

    # Hours section
    hours_node = extract_section_text(soup, r"\bpark\s+hours\b")
    hours = parse_hours(hours_node)

    # Wikimedia image (best-effort)
    img = wiki_image_lookup(name)

    # normalized keys
    norm = normalize_join_names(name)

    return {
        "park_name": name,
        "official_url": url,
        "highlights": highlights,
        "hours": hours,
        "image": img,  # may be None
        **norm,
    }


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    print("Fetching A–Z index…")
    links = get_index_links()
    print(f"Found {len(links)} park links.")

    out: List[Dict] = []
    for i, link in enumerate(links, 1):
        try:
            print(f"[{i}/{len(links)}] {link}")
            item = scrape_park(link)
            out.append(item)
        except Exception as e:
            logging.warning(f"Failed to scrape {link}: {e}")
        time.sleep(DELAY_SEC)

    # sort by name
    out.sort(key=lambda d: d.get("park_name", ""))

    with open("parks.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    # small report
    with_img = sum(1 for d in out if d.get("image"))
    with_hours = sum(1 for d in out if d.get("hours"))
    with_hls = sum(1 for d in out if d.get("highlights"))

    print("\nDone.")
    print(f"  Parks total: {len(out)}")
    print(f"  With highlights: {with_hls}")
    print(f"  With hours:     {with_hours}")
    print(f"  With images:    {with_img}")
    print("\nSaved -> parks.json")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Scholar (Agent A) corpus build — extracts per-page text from the Kierner papers.

Usage:
    python pipeline/build_corpus.py
"""

import gzip
import json
import re
import sys
from pathlib import Path

import pdfplumber

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RAW_DIR = Path(__file__).parent / "raw" / "Kierner papers"
OUTPUT = Path(__file__).parent.parent / "app" / "data" / "corpus.json.gz"


# Running headers/footers that otherwise satisfy derive_title's length/case
# check and get mistaken for the title -- journal banner URLs, "OPEN ACCESS"/
# publisher boilerplate, DOI/ISSN lines, IOP's "You may also like" widget text,
# and "<Journal Name> 68 (2017) 163-172"-style volume/issue/page banners.
_TITLE_EXCLUDE_RE = re.compile(
    r"https?://|www\.[\w.-]+\.\w+|\.(com|org|net)\b|"
    r"^(open access\b|paper\b|you may also like\b|issn\b|isbn\b|doi[:\s]|©|all rights reserved)|"
    r"\d+\s*\(\d{4}\)\s*\d",
    re.I,
)

# DOIs appear near the top/bottom of page 1 (or on a copyright line on page 2)
# as "10.<4-9 digits>/<suffix>" -- trailing punctuation gets trimmed since the
# match often runs into a sentence's closing parenthesis or period.
_DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+")

# PDF "Author" metadata is often populated by the authoring tool rather than
# the paper's actual authors -- skip anything that looks like software/
# publisher boilerplate rather than a human name list.
_BAD_AUTHOR_RE = re.compile(
    r"acrobat|distiller|latex|microsoft|word|elsevier|springer|wiley|ieee|"
    r"^unknown$|^anonymous$|^admin$|^user$",
    re.I,
)

# This corpus's filenames are curated as "<n> - <Title>.pdf" by whoever
# assembled it -- a far more reliable title source than scraping a heading off
# page 1, where fonts/layout vary across a few dozen publishers (running
# headers mistaken for titles, multi-column text, collapsed inter-word
# spacing). "_" stands in for a colon that isn't filesystem-safe on Windows.
_FILENAME_TITLE_RE = re.compile(r"^\d+\s*-\s*(.+)$")


def derive_title(pdf_path: Path, first_page_text: str) -> str:
    """The curated "<n> - <Title>.pdf" filename if present, else the first
    plausible heading line from page 1, else the raw filename."""
    m = _FILENAME_TITLE_RE.match(pdf_path.stem)
    if m:
        title = re.sub(r"_(\s)", r":\1", m.group(1))
        return re.sub(r"\s+", " ", title).strip()

    for line in first_page_text.splitlines():
        line = line.strip()
        if _TITLE_EXCLUDE_RE.search(line):
            continue
        if not (20 <= len(line) <= 200 and not line.isupper() and not re.match(r"^\d", line)):
            continue
        # pdfplumber sometimes collapses inter-word spaces on banner/header
        # lines (ScienceDirect's "Contents lists available at..." running
        # header, received/accepted-date lines, journal name banners) -- a
        # real heading has roughly a space every few words, so treat a long,
        # nearly space-free line as a mangled banner rather than a title.
        if line.count(" ") < len(line) / 15:
            continue
        return line
    return re.sub(r"[_-]+", " ", pdf_path.stem).strip()


def extract_doi(page_texts: list[str]) -> str:
    """DOIs live on page 1 or 2 (header, footer, or copyright line)."""
    for text in page_texts[:2]:
        m = _DOI_RE.search(text)
        if m:
            return m.group(0).rstrip(").,;:")
    return ""


def extract_authors(metadata: dict | None) -> str:
    """Best-effort from PDF Info metadata -- "if available", per the UI copy;
    many publisher pipelines leave this blank or fill it with tool names."""
    author = ((metadata or {}).get("Author") or "").strip()
    if not author or _BAD_AUTHOR_RE.search(author):
        return ""
    if " " not in author and ";" not in author:
        return ""  # a single bare token is usually a truncated field or journal acronym, not a name
    return re.sub(r"\s*;\s*", ", ", author)


def build():
    pdf_paths = sorted(RAW_DIR.glob("*.pdf"))
    if not pdf_paths:
        raise FileNotFoundError(f"No PDFs found in {RAW_DIR}")

    records = []
    for doc_id, pdf_path in enumerate(pdf_paths):
        with pdfplumber.open(pdf_path) as pdf:
            doc_title = None
            doc_records = []
            page_texts = []
            for page_no, page in enumerate(pdf.pages):
                text = (page.extract_text() or "").strip()
                if not text:
                    continue
                if doc_title is None:
                    doc_title = derive_title(pdf_path, text)
                page_texts.append(text)
                doc_records.append({
                    "id": f"{doc_id}-{page_no}",
                    "doc_id": doc_id,
                    "page_no": page_no,
                    "doc_title": doc_title,
                    "text": text,
                })
            doi = extract_doi(page_texts)
            authors = extract_authors(pdf.metadata)
            for r in doc_records:
                r["doc_title"] = doc_title  # backfill pages seen before title was found
                r["doi"] = doi
                r["authors"] = authors
            records.extend(doc_records)
        n_pages = len(doc_records)
        print(f"  [{doc_id + 1}/{len(pdf_paths)}] {pdf_path.name}: {n_pages} pages -> {doc_title!r} "
              f"(doi={doi or '-'}, authors={authors or '-'})")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUTPUT, "wt", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False)

    print(f"\n{len(pdf_paths)} documents, {len(records)} pages -> {OUTPUT}")


if __name__ == "__main__":
    build()

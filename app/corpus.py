"""Scholar (Agent A) retrieval: from-scratch BM25 over the Kierner papers
corpus, no embeddings/vector DB -- lexical overlap is a strong signal at this
corpus size and domain-vocabulary match (per blueprint ARCHITECTURE.md §7.2).
"""

from __future__ import annotations

import gzip
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

from . import config

TOKEN_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
    "was", "were", "be", "been", "this", "that", "with", "as", "by", "at",
    "from", "it", "its", "we", "our", "which", "these", "those", "can", "has",
    "have", "not", "but", "such", "also", "into", "than", "then", "based",
}
MAX_HITS_PER_DOC = 2
SNIPPET_PROXIMITY_RADIUS = 60  # chars


def tokenize(text: str) -> list[str]:
    """Lowercase; keeps compound terms both joined and split (e.g.
    'rule-based' matches both 'rule-based' and 'based')."""
    tokens = []
    for raw in TOKEN_RE.findall(text.lower()):
        if raw in STOPWORDS:
            continue
        tokens.append(raw)
        if "-" in raw:
            tokens.extend(p for p in raw.split("-") if p and p not in STOPWORDS)
    return tokens


@dataclass
class Page:
    id: str
    doc_id: int
    page_no: int
    doc_title: str
    text: str
    tokens: list[str]
    authors: str = ""
    doi: str = ""


class BM25Corpus:
    k1 = 1.5
    b = 0.75

    def __init__(self, pages: list[Page]):
        self.pages = {p.id: p for p in pages}
        self.doc_lengths = {p.id: len(p.tokens) for p in pages}
        self.avg_doc_length = sum(self.doc_lengths.values()) / max(len(pages), 1)

        self.doc_freq: Counter[str] = Counter()
        self.term_freq: dict[str, Counter[str]] = {}
        for page in pages:
            counts = Counter(page.tokens)
            self.term_freq[page.id] = counts
            for term in counts:
                self.doc_freq[term] += 1

        self.n_docs = len(pages)

    def _idf(self, term: str) -> float:
        df = self.doc_freq.get(term, 0)
        return math.log(1 + (self.n_docs - df + 0.5) / (df + 0.5))

    def search(self, query: str, top_k: int = 8) -> list[tuple[str, float]]:
        query_terms = tokenize(query)
        scores: Counter[str] = Counter()
        for page_id, counts in self.term_freq.items():
            doc_len = self.doc_lengths[page_id]
            score = 0.0
            for term in query_terms:
                tf = counts.get(term, 0)
                if tf == 0:
                    continue
                idf = self._idf(term)
                denom = tf + self.k1 * (1 - self.b + self.b * doc_len / self.avg_doc_length)
                score += idf * (tf * (self.k1 + 1)) / denom
            if score > 0:
                scores[page_id] = score

        # Per-source-document cap so one long paper can't dominate results.
        ranked = scores.most_common()
        per_doc: dict[int, int] = defaultdict(int)
        capped: list[tuple[str, float]] = []
        for page_id, score in ranked:
            doc_id = self.pages[page_id].doc_id
            if per_doc[doc_id] >= MAX_HITS_PER_DOC:
                continue
            per_doc[doc_id] += 1
            capped.append((page_id, score))
            if len(capped) >= top_k:
                break
        return capped

    def snippet(self, page_id: str, query: str, max_chars: int = 900) -> str:
        """Densest-window: slide across hit positions, pick the window
        maximizing hits within a fixed proximity radius."""
        page = self.pages[page_id]
        text = page.text
        query_terms = set(tokenize(query))
        if not query_terms:
            return text[:max_chars]

        positions = []
        lowered = text.lower()
        for term in query_terms:
            start = 0
            while True:
                idx = lowered.find(term, start)
                if idx == -1:
                    break
                positions.append(idx)
                start = idx + len(term)
        if not positions:
            return text[:max_chars]

        positions.sort()
        best_start, best_count = positions[0], 0
        for p in positions:
            window = [q for q in positions if p <= q <= p + SNIPPET_PROXIMITY_RADIUS]
            if len(window) > best_count:
                best_count = len(window)
                best_start = p

        start = max(0, best_start - max_chars // 3)
        end = min(len(text), start + max_chars)
        # Snap both edges to word boundaries so the excerpt doesn't end
        # mid-token (e.g. "dis" + "ease...") -- purely cosmetic, but a
        # jagged cut reads as a broken/incomplete summary to the user.
        if start > 0:
            ws = text.rfind(" ", 0, start)
            if ws != -1:
                start = ws + 1
        if end < len(text):
            we = text.rfind(" ", start, end)
            if we > start:
                end = we
        snippet = text[start:end].strip()
        return ("…" if start > 0 else "") + snippet + ("…" if end < len(text) else "")

    def matched_terms(self, page_id: str, query: str) -> list[str]:
        """Which query terms actually occur on this page, in query order --
        drives the "why this was cited" keyword highlight in the citation
        detail popover."""
        page_tokens = set(self.pages[page_id].tokens)
        seen: list[str] = []
        for term in tokenize(query):
            if term in page_tokens and term not in seen:
                seen.append(term)
        return seen

    def read_full(self, page_id: str, max_chars: int = 7000) -> str:
        return self.pages[page_id].text[:max_chars]


def load_corpus() -> BM25Corpus:
    with gzip.open(config.CORPUS_PATH, "rt", encoding="utf-8") as f:
        records = json.load(f)
    pages = [
        Page(id=r["id"], doc_id=r["doc_id"], page_no=r["page_no"],
             doc_title=r["doc_title"], text=r["text"], tokens=tokenize(r["text"]),
             authors=r.get("authors", ""), doi=r.get("doi", ""))
        for r in records
    ]
    return BM25Corpus(pages)

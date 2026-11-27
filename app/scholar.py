"""Scholar (Agent A) -- retrieval over the 69 Kierner papers, per blueprint
ARCHITECTURE.md §7.3. Always searches before answering, cites every claim
inline as [n], never invents a source, re-searches with broader terms if
results clearly miss (capped), says so plainly if the corpus is silent.
"""

from __future__ import annotations

import json

from . import config, llm
from .corpus import BM25Corpus

MAX_TOOL_ROUNDS = 3

SYSTEM_PROMPT = """You are Scholar, a retrieval agent for a tool that helps \
engineers design and validate neuro-symbolic ("Boxology") systems. You answer \
questions by searching a corpus of 69 academic papers on hybrid fuzzy/neuro/\
symbolic clinical decision-support systems.

Rules, in priority order:
1. Always search before answering, even for a one-word query. Never open with \
a refusal or an answer from memory alone.
2. Cite every claim about the papers inline as [n] (the citation number from \
your most recent search), one source per bracket. Never invent a source, \
page, or finding.
3. If results clearly miss what's asked, search again with broader or \
different terms -- up to a few tries.
4. If the corpus is genuinely silent on the topic, say so plainly rather than \
guessing.

You are not the fine-tuned model and not the knowledge-graph agent -- your \
value is traceability: "here is the receipt" for every claim."""


def _tools() -> list[dict]:
    return [
        llm.tool(
            "search_papers", "Search the 69-paper corpus. Returns numbered snippets.",
            {"type": "object", "properties": {
                "query": {"type": "string"}, "top_k": {"type": "integer", "default": 8},
            }, "required": ["query"]},
        ),
        llm.tool(
            "read_page", "Read the full text of a page by its citation number from a prior search.",
            {"type": "object", "properties": {
                "citation": {"type": "integer"},
            }, "required": ["citation"]},
        ),
    ]


def _fallback_summary(citation_map: dict[int, str], corpus: BM25Corpus) -> str:
    """Resilience rule (blueprint §7/§9): never leave the user empty-handed
    when the data was actually found -- used when the final round produces
    no usable text (a known Gemini quirk: forcing "no more tool calls" mid-
    conversation sometimes yields an empty turn instead of a text answer)."""
    if not citation_map:
        return "I wasn't able to find anything relevant in the corpus for this question."
    lines = ["Here is what the corpus search turned up (the model's final summary "
             "step didn't return text, so these are the raw matches):"]
    for citation, page_id in citation_map.items():
        page = corpus.pages[page_id]
        lines.append(f"[{citation}] {page.doc_title}, p.{page.page_no}")
    return "\n".join(lines)


async def chat(corpus: BM25Corpus, client: llm.LLMClient, user_message: str,
               history_msgs: list[dict]):
    """Async generator yielding SSE-ready dicts: tool_call, sources, read,
    text (delta), done, error."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                *llm.history(history_msgs), {"role": "user", "content": user_message}]
    citation_map: dict[int, str] = {}  # citation number -> page_id, stable within the turn

    for _round in range(MAX_TOOL_ROUNDS + 1):
        force_final = _round == MAX_TOOL_ROUNDS
        tool_calls = []
        got_text = False
        async for event in client.stream(
            messages, tools=None if force_final else _tools(), temperature=0.2, max_tokens=4096,
        ):
            if event["type"] == "delta":
                got_text = True
                yield {"type": "text", "text": event["text"]}
            elif event["type"] == "tool_calls":
                tool_calls = event["tool_calls"]
            elif event["type"] == "error":
                yield llm.error_event(event["message"])
                return
            elif event["type"] == "done":
                pass

        if force_final:
            # Ignore any tool call the model still attempts here (a known
            # Gemini quirk -- see llm.py's stream() docstring); synthesize a
            # fallback from gathered sources if there's no text either.
            if not got_text:
                yield {"type": "text", "text": _fallback_summary(citation_map, corpus)}
            yield {"type": "done"}
            return

        if not tool_calls:
            yield {"type": "done"}
            return

        results = []
        for tc in tool_calls:
            try:
                args = json.loads(tc.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            if tc.name == "search_papers":
                query = args.get("query", "")
                hits = corpus.search(query, top_k=args.get("top_k", 8))
                yield {"type": "tool_call", "name": "search_papers", "query": query}
                # Relevance is BM25 score relative to this search's own top hit (not an
                # absolute score, which is unbounded and not meaningful on its own) --
                # tells the user how strong each citation's match to their question is,
                # not just that it was returned.
                top_score = hits[0][1] if hits else 0.0
                sources = []
                for page_id, score in hits:
                    citation = next((n for n, p in citation_map.items() if p == page_id), None)
                    if citation is None:
                        citation = len(citation_map) + 1
                        citation_map[citation] = page_id
                    page = corpus.pages[page_id]
                    relevance = round(100 * score / top_score) if top_score > 0 else 0
                    sources.append({
                        "citation": citation, "doc_title": page.doc_title,
                        "authors": page.authors, "doi": page.doi,
                        "page_no": page.page_no + 1,  # pdfplumber's enumerate() is 0-indexed
                        "snippet": corpus.snippet(page_id, query),
                        # Shorter excerpt for the citation-detail popover -- the user asked for
                        # "a summarization, not lots of description"; the full snippet above is
                        # still what the model itself reasons over.
                        "summary": corpus.snippet(page_id, query, max_chars=320),
                        "matched_terms": corpus.matched_terms(page_id, query),
                        "relevance": relevance,
                    })
                yield {"type": "sources", "sources": sources}
                results.append("\n\n".join(
                    f"[{s['citation']}] {s['doc_title']} p.{s['page_no']} (match {s['relevance']}%): {s['snippet']}"
                    for s in sources
                ) or "No results.")
            elif tc.name == "read_page":
                citation = args.get("citation")
                page_id = citation_map.get(citation)
                if page_id is None:
                    results.append(f"Unknown citation number {citation}.")
                else:
                    yield {"type": "read", "citation": citation}
                    results.append(corpus.read_full(page_id))
            else:
                results.append(f"Unknown tool {tc.name}")

        messages.extend(llm.tool_turn(tool_calls, results))

    yield {"type": "done"}

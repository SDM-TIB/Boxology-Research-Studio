"""Cartographer (Agent C) hybrid retrieval + personalized PageRank, per
blueprint ARCHITECTURE.md §9.2.

Note on this particular graph: T4B's entities are anonymized diagram-node ids
(labels like "node_17639898675053"), not human-readable concept names -- unlike
the blueprint's clinical worked example, lexical matching against entity labels
will rarely fire here. The real lexical content lives in the 132 assertions'
rule text ("If type Component, then type Symbol"). Both rankings are still
implemented (fusion degrades gracefully to whichever source actually has
signal for a given query), and this keeps the component swappable if a future
KG has richer entity labels.
"""

from __future__ import annotations

import math
from collections import Counter

from .corpus import tokenize
from .kg import Graph

RRF_K = 60
PAGERANK_RESTART = 0.5
PAGERANK_ITERATIONS = 25


def _bm25_over_texts(texts: dict[str, str], query: str, top_k: int) -> list[tuple[str, float]]:
    """Minimal BM25 over an arbitrary small text collection (assertions here;
    not corpus.py's Page-shaped BM25Corpus, which carries doc/page fields that
    don't apply to KG nodes)."""
    k1, b = 1.5, 0.75
    tokenized = {node_id: tokenize(text) for node_id, text in texts.items()}
    doc_lengths = {k: len(v) for k, v in tokenized.items()}
    avg_len = sum(doc_lengths.values()) / max(len(texts), 1)
    doc_freq: Counter[str] = Counter()
    term_freq: dict[str, Counter[str]] = {}
    for node_id, tokens in tokenized.items():
        counts = Counter(tokens)
        term_freq[node_id] = counts
        for term in counts:
            doc_freq[term] += 1
    n_docs = len(texts)

    query_terms = tokenize(query)
    scores: Counter[str] = Counter()
    for node_id, counts in term_freq.items():
        doc_len = doc_lengths[node_id]
        score = 0.0
        for term in query_terms:
            tf = counts.get(term, 0)
            if tf == 0:
                continue
            df = doc_freq.get(term, 0)
            idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
            denom = tf + k1 * (1 - b + b * doc_len / avg_len)
            score += idf * (tf * (k1 + 1)) / denom
        if score > 0:
            scores[node_id] = score
    return scores.most_common(top_k)


def _lexical_entity_match(graph: Graph, query: str, top_k: int) -> list[tuple[str, float]]:
    query_terms = set(tokenize(query))
    if not query_terms:
        return []
    scores: Counter[str] = Counter()
    for entity_id, entity in graph.entities.items():
        label_terms = set(tokenize(entity.label))
        overlap = len(query_terms & label_terms)
        if overlap:
            scores[entity_id] = overlap
    return scores.most_common(top_k)


def _reciprocal_rank_fusion(rankings: list[list[tuple[str, float]]], k: int = RRF_K) -> dict[str, float]:
    fused: Counter[str] = Counter()
    for ranking in rankings:
        for rank, (node_id, _score) in enumerate(ranking):
            fused[node_id] += 1.0 / (k + rank + 1)
    return dict(fused)


def _personalized_pagerank(graph: Graph, seeds: dict[str, float]) -> dict[str, float]:
    """Power-iteration personalized PageRank. Restart distribution = seeds
    (already fused + specificity-weighted), propagation graph excludes
    "instance" edges (assertion<->entity hub edges) per §9.2 step 3."""
    total_seed_weight = sum(seeds.values()) or 1.0
    restart = {k: v / total_seed_weight for k, v in seeds.items()}

    all_nodes = set(graph.entities) | set(graph.assertions)
    scores = dict(restart)
    for node in all_nodes:
        scores.setdefault(node, 0.0)

    for _ in range(PAGERANK_ITERATIONS):
        next_scores = {node: (1 - PAGERANK_RESTART) * restart.get(node, 0.0) for node in all_nodes}
        for node in all_nodes:
            out = graph.propagation_out.get(node, [])
            if not out:
                continue
            share = scores[node] * PAGERANK_RESTART / len(out)
            for edge in out:
                next_scores[edge.to] = next_scores.get(edge.to, 0.0) + share
        scores = next_scores
    return scores


def hybrid_explore(graph: Graph, query: str, top_k: int = 6) -> dict:
    """Runs the full hybrid-retrieval + personalized-PageRank pipeline for one
    query. Returns ranked assertions (by PageRank mass, not raw lexical score)
    plus the entities directly linked to each, and a list of "hop" events
    describing what happened -- for the frontend's live-walk animation."""
    assertion_texts = {a_id: a.text for a_id, a in graph.assertions.items()}
    hops = []

    entity_hits = _lexical_entity_match(graph, query, top_k=10)
    hops.append({"stage": "match", "kind": "entity", "count": len(entity_hits)})

    assertion_hits = _bm25_over_texts(assertion_texts, query, top_k=15)
    hops.append({"stage": "match", "kind": "assertion", "count": len(assertion_hits)})

    fused = _reciprocal_rank_fusion([entity_hits, assertion_hits])
    hops.append({"stage": "seed", "count": len(fused)})

    # Weight entity seeds by inverse specificity; assertion seeds pass through.
    weighted_seeds = {}
    for node_id, score in fused.items():
        if node_id in graph.entities:
            n_touching = graph.assertion_count_per_entity.get(node_id, 1)
            weighted_seeds[node_id] = score / math.log(2 + n_touching)
        else:
            weighted_seeds[node_id] = score

    if not weighted_seeds:
        hops.append({"stage": "rank", "count": 0, "note": "no lexical match, nothing to rank"})
        return {"assertions": [], "hops": hops}

    pagerank_scores = _personalized_pagerank(graph, weighted_seeds)

    ranked_assertions = sorted(
        ((a_id, pagerank_scores.get(a_id, 0.0)) for a_id in graph.assertions),
        key=lambda x: x[1], reverse=True,
    )[:top_k]
    hops.append({"stage": "rank", "count": len(ranked_assertions)})

    results = []
    for a_id, score in ranked_assertions:
        if score <= 0:
            continue
        assertion = graph.assertions[a_id]
        linked_entities = [
            {"id": e.to, "label": graph.node_label(e.to)}
            for e in graph.out_edges.get(a_id, []) if e.role == "instance"
        ][:5]
        results.append({
            "id": a_id,
            "text": assertion.text,
            "grade": assertion.grade,
            "pca_confidence": assertion.pca_confidence,
            "pagerank_score": score,
            "linked_entities": linked_entities,
        })
    hops.append({"stage": "hop1", "count": sum(len(r["linked_entities"]) for r in results)})

    return {"assertions": results, "hops": hops}


def expand(graph: Graph, node_id: str, limit: int = 10) -> dict:
    """One more hop from a node already shown (§9.3's `expand` tool)."""
    if node_id not in graph.entities and node_id not in graph.assertions:
        return {"error": f"Unknown node id: {node_id}"}
    return {"node_id": node_id, "label": graph.node_label(node_id),
            "neighbors": graph.neighbors(node_id, limit=limit)}


def execute_query(graph: Graph, search_terms: str, grade: str | None = None,
                  min_confidence: float = 0.0, limit: int = 8) -> dict:
    """Execute the Cartographer's explicit, safe graph query plan.

    The PAL/LLM writes this structured query rather than sending executable
    database code.  We run it against the in-memory KG and always return both
    stable IDs and the human labels recovered from the source diagrams.
    """
    limit = max(1, min(int(limit or 8), 20))
    min_confidence = max(0.0, min(float(min_confidence or 0), 1.0))
    normalized_grade = (grade or "").upper()
    if normalized_grade not in {"", "ANY", "POSITIVE", "NEGATIVE"}:
        normalized_grade = ""
    outcome = hybrid_explore(graph, search_terms, top_k=20)
    rows = []
    for item in outcome["assertions"]:
        if normalized_grade not in {"", "ANY"} and item["grade"] != normalized_grade:
            continue
        if item["pca_confidence"] < min_confidence:
            continue
        rows.append({
            "assertion_id": item["id"],
            "rule": item["text"],
            "grade": item["grade"],
            "pca_confidence": item["pca_confidence"],
            "nodes": item["linked_entities"],
        })
        if len(rows) >= limit:
            break
    return {
        "query": {
            "search_terms": search_terms,
            "grade": normalized_grade or "ANY",
            "min_confidence": min_confidence,
            "limit": limit,
        },
        "rows": rows,
    }

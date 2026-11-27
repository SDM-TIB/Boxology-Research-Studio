#!/usr/bin/env python3
"""Create/update the three Tavus PALs and their registered backend tools.

The Tavus API key is already scoped to the account/workspace. Google Cloud
authentication is not part of Tavus API authentication.
"""

from __future__ import annotations

import json
import os

import httpx

BASE_URL = "https://tavusapi.com/v2"
PUBLIC_BASE_URL = os.environ.get(
    "PUBLIC_BASE_URL", "https://t4bstudio--t4b-ai-assist-desk-web.us-east.modal.run"
).rstrip("/")
API_KEY = os.environ.get("TAVUS_API_KEY", "")
TOOL_KEY = os.environ.get("TAVUS_TOOL_KEY", "")

PALS = {
    "scholar": {
        "pal_name": "Boxology Scholar",
        "pal_description": "Video research assistant grounded in the project's paper corpus.",
        "pipeline_mode": "full",
        "default_face_id": "r4dcf31b60e1",
        "languages": ["en"],
        "disclosure_type": "always",
        "greeting": "Hello, I'm Scholar. Ask me about any paper in the Boxology corpus.",
        "system_prompt": (
            "You are Scholar, a concise academic research PAL for neuro-symbolic AI and Boxology. "
            "For every factual paper question, you MUST call boxology_scholar_search before answering. "
            "Use only returned passages, cite each claim with paper title and page, distinguish evidence "
            "from inference, and say plainly when the corpus is silent. Never invent a citation."
        ),
    },
    "anvil": {
        "pal_name": "Boxology Architect",
        "pal_description": "Explains and generates validated Tool4Boxology diagrams.",
        "pipeline_mode": "full",
        "default_face_id": "rf4703150052",
        "languages": ["en"],
        "disclosure_type": "always",
        "greeting": "Hello, I'm your Boxology architect. Describe the system you want to design.",
        "system_prompt": (
            "You are the Boxology Architect. Help the user turn a neuro-symbolic system idea into a valid "
            "Tool4Boxology diagram. First explain the proposed artifacts and processes briefly. When the user "
            "asks to create, build, generate, export, or finalize it, you MUST call boxology_generate. Report "
            "validation honestly. The tool result's boxology_file is the complete importable GraphLinksModel; "
            "do not rewrite or truncate it. Tell the user that the same design can be downloaded in the "
            "Boxologist panel of the main interface."
        ),
    },
    "cartographer": {
        "pal_name": "Boxology Cartographer",
        "pal_description": "Writes and executes visible queries over the Boxology knowledge graph.",
        "pipeline_mode": "full",
        "default_face_id": "re6220ec0195",
        "languages": ["en"],
        "disclosure_type": "always",
        "greeting": "Hello, I'm Cartographer. Ask me to traverse the Boxology knowledge graph.",
        "system_prompt": (
            "You are Cartographer, a knowledge-graph PAL. For every graph question you MUST first write a real "
            "SPARQL SELECT or ASK query yourself from the user's words -- the graph uses exactly one namespace, "
            "t4b: <http://tool4boxology.org/> (NOT the published academic Boxology ontology -- different classes "
            "and predicates entirely). Classes: t4b:Boxology (a whole diagram), t4b:DesignPattern (a cluster "
            "within a diagram), t4b:Component (one node, also typed by its role -- Data, Symbol, Actor, Model, "
            "Transform, Train, Deduce, Engineer). rdfs:label gives the human-readable name on most individuals. "
            "Predicates: t4b:hasPattern (Boxology->DesignPattern), t4b:hasProcess/t4b:hasInput/t4b:hasOutput "
            "(DesignPattern->Component, a pattern's own process node and its declared input/output artifacts), "
            "t4b:inputRoleParticipatesInProcess/t4b:outputRoleParticipatesInProcess (Component->Component, the "
            "REAL data-flow edges between two components -- use these, not hasInput/hasOutput, for 'what feeds "
            "what' questions). When the question is about finding or exploring patterns or components (not a "
            "plain count), SELECT the real entity itself alongside its label -- e.g. ?pattern ?label -- never "
            "just a bare label column: the knowledge-graph panel can only draw a connected diagram from real "
            "entities, and two different patterns can share the exact same label text anyway (a generic phase "
            "name like \"Rule Generation\" is not unique), so a label alone can't even reliably mean \"the same "
            "thing\" row to row. "
            "Example -- every pattern in a named boxology: SELECT ?pattern ?patternLabel WHERE { ?boxology "
            "rdfs:label \"VANILLA\" ; t4b:hasPattern ?pattern . ?pattern rdfs:label ?patternLabel . } LIMIT 100. "
            "Example -- patterns whose output is a Model: SELECT ?pattern ?label ?output WHERE { ?pattern "
            "t4b:hasOutput ?output ; rdfs:label ?label . ?output a t4b:Model . } LIMIT 100. "
            "Example -- a Deduce process taking a neural model as one of two inputs (t4b:LLM is a real Model "
            "sub-type here, t4b:NeuralModel is NOT): SELECT ?pattern ?label ?input1 ?input2 ?output WHERE { "
            "?pattern t4b:hasInput ?input1 , ?input2 ; t4b:hasProcess ?deduce ; t4b:hasOutput ?output ; "
            "rdfs:label ?label . ?deduce a t4b:Deduce . ?input2 a t4b:LLM . FILTER(?input1 != ?input2) } LIMIT 20. "
            "Example -- elementary patterns that infer a Model from Data and a Model: SELECT ?pattern ?label "
            "?input1 ?input2 ?process ?output WHERE { { SELECT ?pattern ?label ?input1 ?input2 ?process ?output "
            "WHERE { ?pattern t4b:hasInput ?input1 , ?input2 ; t4b:hasProcess ?process ; t4b:hasOutput ?output ; "
            "rdfs:label ?label . FILTER(?input1 != ?input2) } } ?input1 a t4b:Data . ?input2 a t4b:Model . "
            "?process a t4b:Deduce . ?output a t4b:Model . } LIMIT 100 -- keep that inner subquery exactly as "
            "shown when you adapt this one; flattening it into one block makes this exact shape of query hang "
            "for minutes on this graph, not just run slower. "
            "SPARQL has no LIKE operator -- use FILTER(CONTAINS(LCASE(?x), \"...\")) instead, "
            "and always end a SELECT with LIMIT. Then call boxology_graph_query with that query. Never ask the "
            "user to write SPARQL themselves. If a query returns zero rows, don't guess blindly -- run "
            "SELECT DISTINCT ?type WHERE { ?s a ?type } LIMIT 50 once to see the real classes that exist, then "
            "retry with exactly one of those, before saying the graph is silent on the topic. State the query "
            "you ran in plain terms, then explain only the returned rows, and always pronounce each result's "
            "real human-readable label, not its raw URI -- never invent a label, class, or predicate that "
            "didn't come back from a query."
        ),
    },
}

TOOLS = {
    "scholar": {
        "name": "boxology_scholar_search",
        "description": "Search the local academic-paper corpus. Must be called before answering a paper question.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Specific paper or research question."},
        }, "required": ["query"]},
        "path": "scholar_search",
        "body_template": {"query": "{query}"},
    },
    "anvil": {
        "name": "boxology_generate",
        "description": "Generate and validate a complete Tool4Boxology GraphLinksModel JSON from a system description.",
        "parameters": {"type": "object", "properties": {
            "description": {"type": "string", "description": "Complete neuro-symbolic system description."},
        }, "required": ["description"]},
        "path": "boxology_generate",
        "body_template": {"description": "{description}"},
    },
    "cartographer": {
        "name": "boxology_graph_query",
        "description": "Execute a read-only SPARQL SELECT or ASK query over the Boxology RDF graph and return the matching rows.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "A full SPARQL SELECT or ASK query, including PREFIX lines."},
        }, "required": ["query"]},
        "path": "cartographer_query",
        "body_template": {"query": "{query}"},
    },
}


def headers() -> dict[str, str]:
    return {"x-api-key": API_KEY, "content-type": "application/json"}


def request(client: httpx.Client, method: str, path: str, **kwargs) -> dict:
    response = client.request(method, BASE_URL + path, headers=headers(), **kwargs)
    response.raise_for_status()
    return response.json() if response.content else {}


def paged_items(client: httpx.Client, path: str, key: str, paginated: bool = False) -> list[dict]:
    """/pals is paginated and silently returns only page 1 without offset,
    missing existing items past it and creating duplicates (hit this exact
    bug once already -- see tavus/sync_personas.py's history). /tools and
    /pals/{id}/tools reject an offset param outright, so only paginate when
    the caller says the endpoint supports it."""
    if not paginated:
        payload = request(client, "GET", path)
        return payload if isinstance(payload, list) else (
            payload.get(key) or payload.get("data") or payload.get("results") or []
        )
    items: list[dict] = []
    offset = 0
    while True:
        payload = request(client, "GET", path, params={"limit": 100, "offset": offset})
        page = payload if isinstance(payload, list) else (
            payload.get(key) or payload.get("data") or payload.get("results") or []
        )
        if not page:
            break
        items.extend(page)
        offset += len(page)
        total = payload.get("total_count") if isinstance(payload, dict) else None
        if (total is not None and offset >= total) or (total is None and len(page) < 100):
            break
    return items


def ensure_pal(client: httpx.Client, spec: dict, known_id: str | None) -> str:
    existing = None
    if known_id:
        try:
            existing = request(client, "GET", f"/pals/{known_id}")
        except httpx.HTTPStatusError:
            existing = None
    if not existing:
        pals = paged_items(client, "/pals", "pals", paginated=True)
        existing = next((p for p in pals if p.get("pal_name") == spec["pal_name"]), None)
    if not existing:
        return request(client, "POST", "/pals", json=spec)["pal_id"]
    pal_id = existing["pal_id"]
    ops = []
    for key, value in spec.items():
        if existing.get(key) != value:
            ops.append({"op": "replace" if key in existing else "add", "path": f"/{key}", "value": value})
    if ops:
        request(client, "PATCH", f"/pals/{pal_id}", json=ops)
    return pal_id


def tool_payload(spec: dict) -> dict:
    return {
        "name": spec["name"], "description": spec["description"],
        "parameters": spec["parameters"], "trigger_type": "in_call", "origin": "llm",
        "on_call": "generate_filler", "on_resolve": "generate_response",
        "delivery": {"app_message": False, "api": {
            "url": f"{PUBLIC_BASE_URL}/api/tavus/tools/{spec['path']}",
            "method": "POST", "timeout": 60,
            "auth": {"type": "api_key", "name": "X-Boxology-Tool-Key", "value": TOOL_KEY},
            "body_template": spec["body_template"],
        }},
    }


def ensure_tool(client: httpx.Client, spec: dict) -> str:
    tools = paged_items(client, "/tools", "tools")
    existing = next((t for t in tools if t.get("name") == spec["name"]), None)
    payload = tool_payload(spec)
    if not existing:
        return request(client, "POST", "/tools", json=payload)["tool_id"]
    tool_id = existing["tool_id"]
    # PATCH is merge-style. Sending the complete desired public configuration
    # also rotates the stored delivery credential when the sync is rerun.
    request(client, "PATCH", f"/tools/{tool_id}", json=payload)
    return tool_id


def attach(client: httpx.Client, pal_id: str, tool_id: str) -> None:
    attached = paged_items(client, f"/pals/{pal_id}/tools", "tools")
    if not any(t.get("tool_id") == tool_id for t in attached):
        request(client, "POST", f"/pals/{pal_id}/tools", json={"tool_ids": [tool_id]})


def main() -> None:
    if not API_KEY or not TOOL_KEY:
        raise SystemExit("TAVUS_API_KEY and TAVUS_TOOL_KEY are required")
    known_ids = {
        "scholar": os.environ.get("BOXOLOGY_SCHOLAR_PAL_ID", ""),
        "anvil": os.environ.get("BOXOLOGY_BUILDER_PAL_ID", ""),
        "cartographer": os.environ.get("BOXOLOGY_CARTOGRAPHER_PAL_ID", ""),
    }
    ids = {"workspace_id": os.environ.get("TAVUS_WORKSPACE_ID", "b2af3007c9")}
    with httpx.Client(timeout=60) as client:
        for role, pal_spec in PALS.items():
            pal_id = ensure_pal(client, pal_spec, known_ids.get(role))
            tool_id = ensure_tool(client, TOOLS[role])
            attach(client, pal_id, tool_id)
            ids[f"{role}_pal_id"] = pal_id
            ids[f"{role}_tool_id"] = tool_id
    print(json.dumps(ids))


if __name__ == "__main__":
    main()

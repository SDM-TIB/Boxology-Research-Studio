"""Tavus tool-call webhook handler -- calls directly into the same agent
modules the chat UI uses (no second parallel implementation), per blueprint
§12. Tavus's conversational LLM decides to call one of our three tools
mid-call and makes an HTTPS request here; we compute the result and return it
as plain text for the persona to speak.

Verbatim vs. paraphrase (blueprint §12's intentional asymmetry) is NOT
enforced here -- Tavus has no API-level switch for it (checked). It's a
system-prompt convention instead: Anvil's persona prompt instructs the avatar
to repeat the tool result verbatim; Cartographer's instructs it to paraphrase
naturally. See tavus/personas/*.json.
"""

from __future__ import annotations

import json
import hashlib
import hmac
from pathlib import Path

import httpx

from . import config

_CONTEXTS = json.loads(
    (Path(__file__).resolve().parent.parent / "tavus" / "personas" / "agent_contexts.json")
    .read_text(encoding="utf-8")
)


PAL_IDS = {
    "scholar": config.BOXOLOGY_SCHOLAR_PAL_ID,
    "anvil": config.BOXOLOGY_BUILDER_PAL_ID,
    "cartographer": config.BOXOLOGY_CARTOGRAPHER_PAL_ID,
}


async def start_call(agent: str, callback_url: str) -> dict:
    """Create a room using the selected agent's dedicated PAL."""
    if agent not in _CONTEXTS:
        return {"error": f"Unknown agent: {agent}"}
    pal_id = PAL_IDS.get(agent)
    if not pal_id:
        return {"error": "No Tavus PAL configured -- run tavus/sync_pals.py first."}

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://tavusapi.com/v2/conversations",
            headers={"x-api-key": config.TAVUS_API_KEY},
            json={
                "pal_id": pal_id,
                "conversational_context": _CONTEXTS[agent],
                "callback_url": callback_url,
                "policy": "eu",
                "properties": {
                    "languages": ["en"], "enable_closed_captions": True,
                    # Generous on purpose: these were 30s/120s, aggressive
                    # enough that a few seconds of silence while reading a
                    # result, or Daily briefly re-negotiating the
                    # connection, could end a real call early. No
                    # max_call_duration is set at all -- a call only ends
                    # when the user hits End or genuinely disconnects.
                    "participant_left_timeout": 90, "participant_absent_timeout": 300,
                },
            },
        )
        if resp.status_code >= 400:
            return {"error": f"Tavus error {resp.status_code}: {resp.text[:300]}"}
        data = resp.json()
        conversation_id = data.get("conversation_id")
        return {
            "conversation_url": data.get("conversation_url"),
            "conversation_id": conversation_id,
            # Only present when Tavus's response includes one (e.g. if
            # require_auth is set on the create-conversation call below);
            # the frontend joins fine without it too.
            "meeting_token": data.get("meeting_token"),
            "end_token": _end_token(conversation_id) if conversation_id else None,
        }


def _end_token(conversation_id: str) -> str:
    # Only the browser that created this room receives its end capability.
    return hmac.new(
        config.TAVUS_API_KEY.encode(), ("end:" + conversation_id).encode(), hashlib.sha256,
    ).hexdigest()


async def end_call(conversation_id: str, token: str) -> dict:
    if not conversation_id or not hmac.compare_digest(_end_token(conversation_id), token):
        return {"error": "Invalid call token"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"https://tavusapi.com/v2/conversations/{conversation_id}/end",
            headers={"x-api-key": config.TAVUS_API_KEY},
        )
    if response.status_code >= 400:
        return {"error": "Could not end the Tavus conversation"}
    return {"ok": True}


def _authorized(headers) -> bool:
    return bool(config.TAVUS_TOOL_KEY) and headers.get("x-boxology-tool-key") == config.TAVUS_TOOL_KEY


def _args(body: dict) -> dict:
    # Registered tools use a body_template, while HMAC/legacy deliveries may
    # wrap the same arguments. Accept both shapes.
    value = body.get("arguments", body)
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}


def _resolve_call_queue(state: dict, body: dict, headers) -> "asyncio.Queue | None":
    """Find the live-call queue to push a tool result onto.

    A tool's *delivery* request (the POST Tavus makes to run the tool and read
    its answer back to the pal) is the one call-time hook we can rely on firing
    -- the separate conversation.tool_call webhook may or may not be delivered.
    But the delivery request historically carries no conversation_id, so this
    resolves the target queue by, in order: an explicit conversation_id in the
    body/headers if Tavus ever includes one, else the single active call
    (max_containers=1 keeps one shared call_events dict; a demo almost never
    has two live calls at once). Returns None when it genuinely can't tell.
    """
    import asyncio  # noqa: F401 -- only for the type hint above
    queues = state.get("call_events", {})
    if not queues:
        return None
    cid = (body.get("conversation_id") or body.get("conversationId")
           or headers.get("x-conversation-id") or "")
    if cid and cid in queues:
        return queues[cid]
    if len(queues) == 1:
        return next(iter(queues.values()))
    return None


async def _push_live(queue, event: dict) -> None:
    # Fire-and-forget onto the per-call queue; never let a live-UI push failure
    # break the tool answer the pal is waiting on.
    if queue is None:
        return
    try:
        await queue.put(event)
    except Exception:
        pass


async def scholar_tool(body: dict, headers, state: dict) -> dict:
    if not _authorized(headers):
        return {"error": "Unauthorized"}
    query = _args(body).get("query", "")
    corpus = state["corpus"]
    hits = corpus.search(query, top_k=5)
    # Same shape (doc_title/page_no/authors/doi/matched_terms/relevance) as
    # scholar.py's text-chat "sources" event, including the pdfplumber
    # 0-index -> display-page-number +1 correction -- the call path used to
    # send a slimmer, inconsistently-named shape with an off-by-one page
    # number and no click-to-detail fields.
    top_score = hits[0][1] if hits else 0.0
    ui_sources = []
    pal_sources = []
    for pid, score in hits:
        page = corpus.pages[pid]
        relevance = round(100 * score / top_score) if top_score > 0 else 0
        page_no = page.page_no + 1
        snippet = corpus.snippet(pid, query, max_chars=500)
        ui_sources.append({
            "doc_title": page.doc_title, "authors": page.authors, "doi": page.doi,
            "page_no": page_no, "snippet": snippet,
            "summary": corpus.snippet(pid, query, max_chars=320),
            "matched_terms": corpus.matched_terms(pid, query),
            "relevance": relevance,
        })
        pal_sources.append({"title": page.doc_title, "page": page_no, "snippet": snippet})
    # Mirror the sources into the live call's Sources window. This is the
    # reliable push path (the delivery request always fires); the webhook does
    # not re-handle tool_call anymore, so there's no double render. The pal's
    # own tool response stays the slimmer pal_sources shape -- it only needs
    # to read the answer aloud, not the UI-detail fields.
    await _push_live(_resolve_call_queue(state, body, headers),
                     {"type": "sources", "query": query, "sources": ui_sources})
    return {"query": query, "sources": pal_sources, "instruction": "Answer only from these sources and cite title plus page."}


async def boxology_tool(body: dict, headers, state: dict) -> dict:
    if not _authorized(headers):
        return {"error": "Unauthorized"}
    description = _args(body).get("description", "")
    from . import anvil
    result = await anvil.generate_plan(state["reasoning_client"], description)
    if result.get("error"):
        return result
    await _push_live(_resolve_call_queue(state, body, headers), {
        "type": "plan", "valid": result["valid"], "problems": result["problems"],
        "boxology_file": result["boxology_file"], "semantic_file": result.get("semantic_file"),
    })
    return {
        "valid": result["valid"], "problems": result["problems"],
        "explanation": "A Tool4Boxology GraphLinksModel was generated. The full importable JSON is in boxology_file.",
        "boxology_file": result["boxology_file"],
    }


async def cartographer_tool(body: dict, headers, state: dict) -> dict:
    if not _authorized(headers):
        return {"error": "Unauthorized"}
    from . import sparql_store
    args = _args(body)
    query = args.get("query", "")
    executed = sparql_store.run_sparql(state["sparql_store"], query)
    queue = _resolve_call_queue(state, body, headers)
    await _push_live(queue, {"type": "query", "query": query})
    await _push_live(queue, {"type": "query_result", "vars": executed.get("vars", []),
                             "rows": executed.get("rows", []), "error": executed.get("error")})
    return executed


async def handle_webhook_event(body: dict, state: dict) -> dict:
    """Tavus's general conversation callback (wired as callback_url, distinct
    from a registered tool's own delivery.api.url). Real event envelope,
    confirmed against Tavus's docs: {event_type, conversation_id, properties,
    message_type, timestamp, ...} -- NOT the ad-hoc {tool_name, arguments}
    shape an earlier version of this handler assumed (that shape never
    matched a real Tavus payload).

    Handles the transcript (and end-of-call); tool results come in via the
    tool delivery handlers instead:
    - conversation.utterance -- turn-by-turn transcript (role=pal/user,
      properties.speech), so the call has a live text transcript next to it.
    - system.shutdown -- end the live stream.

    Events are pushed onto the per-conversation queue server.py creates in
    tavus_start_call; if nothing is subscribed (queue missing/already
    cleaned up), the event is silently dropped -- there's no UI watching it.
    """
    event_type = body.get("event_type", "")
    conversation_id = body.get("conversation_id", "")
    properties = body.get("properties") or {}
    queue = state.get("call_events", {}).get(conversation_id)
    if queue is None:
        return {"ok": True}

    if event_type == "conversation.utterance":
        speech = properties.get("speech", "")
        if speech:
            role = "assistant" if properties.get("role") == "pal" else "user"
            await queue.put({"type": "utterance", "role": role, "text": speech})
    elif event_type == "system.shutdown":
        await queue.put({"type": "call_ended"})
    # Tool results (query/query_result/plan/sources) are no longer produced
    # here: they're pushed straight from the tool *delivery* handlers
    # (scholar_tool/boxology_tool/cartographer_tool), the one call-time hook
    # guaranteed to fire. Handling them here too would double-render the
    # windows, and relying on conversation.tool_call alone left them empty
    # whenever Tavus didn't deliver that event.

    return {"ok": True}

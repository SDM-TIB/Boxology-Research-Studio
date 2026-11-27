"""FastAPI app factory + routers. One sse() helper reused by every agent's
chat route, per the blueprint's "one transport, not three" rule.
"""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import anvil, auth, cartographer, config, projects_store, scholar, sparql_store
from .corpus import BM25Corpus, load_corpus
from .kg import Graph, load_graph

_state: dict = {}
_AUTHED = [Depends(auth.require_auth)]  # gates every cost-bearing/data route below


@asynccontextmanager
async def lifespan(app: FastAPI):
    from . import llm
    _state["corpus"] = load_corpus()
    _state["graph"] = load_graph()
    _state["sparql_store"] = sparql_store.build_store()
    _state["call_events"] = {}  # conversation_id -> asyncio.Queue, live video-call events
    _state["reasoning_client"] = llm.LLMClient(
        base_url=config.LLM_BASE_URL, api_key=config.LLM_API_KEY,
        model=config.LLM_MODEL, fallback_model=config.LLM_FALLBACK_MODEL,
    )
    _state["anvil_client"] = llm.LLMClient(
        base_url=config.ANVIL_BASE_URL, api_key=config.ANVIL_API_KEY,
        model=config.ANVIL_DEFAULT_MODEL, fallback_model=None, timeout=600.0,
        cold_start_retry=True,
    )
    print(f"Loaded corpus: {len(_state['corpus'].pages)} pages")
    print(f"Loaded graph: {len(_state['graph'].entities)} entities, "
          f"{len(_state['graph'].assertions)} assertions")
    print(f"Loaded SPARQL store: {len(_state['sparql_store'])} triples")
    yield
    _state.clear()


app = FastAPI(title="Boxology Agents", lifespan=lifespan)


async def sse(generator: AsyncIterator[dict]) -> AsyncIterator[str]:
    async for event in generator:
        yield f"data: {json.dumps(event)}\n\n"


def _history_from_body(body: dict) -> list[dict]:
    return body.get("history", [])


@app.post("/api/chat/scholar", dependencies=_AUTHED)
async def chat_scholar(request: Request):
    body = await request.json()
    message = body.get("message", "")
    history = _history_from_body(body)
    gen = scholar.chat(_state["corpus"], _state["reasoning_client"], message, history)
    return StreamingResponse(sse(gen), media_type="text/event-stream",
                              headers={"Cache-Control": "no-store"})


@app.post("/api/chat/cartographer", dependencies=_AUTHED)
async def chat_cartographer(request: Request):
    body = await request.json()
    message = body.get("message", "")
    history = _history_from_body(body)
    gen = cartographer.chat(_state["graph"], _state["sparql_store"], _state["reasoning_client"],
                            message, history)
    return StreamingResponse(sse(gen), media_type="text/event-stream",
                              headers={"Cache-Control": "no-store"})


@app.post("/api/chat/anvil", dependencies=_AUTHED)
async def chat_anvil(request: Request):
    body = await request.json()
    message = body.get("message", "")
    history = _history_from_body(body)
    model = body.get("model") if body.get("model") in {"cot2", "cot3"} else None
    gen = anvil.chat(_state["anvil_client"], _state["reasoning_client"], message, history, model=model)
    return StreamingResponse(sse(gen), media_type="text/event-stream",
                              headers={"Cache-Control": "no-store"})


@app.get("/api/kg/node/{node_id:path}", dependencies=_AUTHED)
async def kg_node(node_id: str):
    from .retrieve import expand
    return JSONResponse(expand(_state["graph"], node_id))


@app.get("/api/kg/search", dependencies=_AUTHED)
async def kg_search(q: str):
    from .retrieve import hybrid_explore
    return JSONResponse(hybrid_explore(_state["graph"], q))


@app.post("/api/sparql", dependencies=_AUTHED)
async def sparql_debug(request: Request):
    """Raw query-in, {vars, rows} out -- same engine Cartographer's run_sparql
    tool uses. Handy for debugging a query directly, outside of a chat turn."""
    body = await request.json()
    return JSONResponse(sparql_store.run_sparql(_state["sparql_store"], body.get("query", "")))


@app.get("/api/sparql/node", dependencies=_AUTHED)
async def sparql_node(uri: str = "", label: str = ""):
    """One-hop node expansion. Accepts either a full URI (query param, not a
    :path route, so percent-encoded http(s) URIs never hit a path-converter
    edge case) or, for nodes that came from a literal-only SELECT ?label
    result, a `label` that is resolved to its entity URI first."""
    store = _state["sparql_store"]
    if not uri and label:
        resolved = sparql_store.resolve_label(store, label)
        if not resolved:
            return JSONResponse({"error": f"No entity found with label '{label}'."})
        return JSONResponse(sparql_store.describe_neighbors(store, resolved))
    return JSONResponse(sparql_store.describe_neighbors(store, uri))


@app.get("/api/sparql/search", dependencies=_AUTHED)
async def sparql_search(q: str = "", limit: int = 20):
    """Label substring search over the Cartographer graph -- backs the graph
    panel's search box (distinct from /api/kg/search, which searches the
    separate rules/entities Graph used by the chat agent's own retrieval)."""
    return JSONResponse({"results": sparql_store.search_entities(_state["sparql_store"], q, limit=limit)})


@app.get("/api/sparql/schema", dependencies=_AUTHED)
async def sparql_schema(limit: int = 12):
    """Top classes by instance count -- backs the panel's home/entry view."""
    return JSONResponse({"classes": sparql_store.class_counts(_state["sparql_store"], limit=limit)})


@app.get("/api/sparql/node/groups", dependencies=_AUTHED)
async def sparql_node_groups(uri: str):
    """Per-predicate/direction neighbor counts for a node -- fetched before
    an "Expand neighbors" lets the researcher pick a group rather than
    dumping every neighbor of a hub at once."""
    return JSONResponse(sparql_store.neighbor_group_counts(_state["sparql_store"], uri))


@app.get("/api/sparql/node/neighbors", dependencies=_AUTHED)
async def sparql_node_neighbors(uri: str, predicate: str, direction: str, offset: int = 0, limit: int = 25):
    """One page of a single predicate/direction's neighbors, chosen from
    /api/sparql/node/groups' counts."""
    return JSONResponse(sparql_store.neighbors_by_predicate(
        _state["sparql_store"], uri, predicate, direction, offset=offset, limit=limit,
    ))


@app.post("/api/director", dependencies=_AUTHED)
async def director_decide(request: Request):
    """Auto-arrange decision for the desk UI's open call windows -- see
    app/director.py's module docstring for the graceful-no-credentials
    fallback shape ({"available": False})."""
    from . import director
    body = await request.json()
    return JSONResponse(await director.decide(body))


@app.post("/api/boxology/rearrange", dependencies=_AUTHED)
async def boxology_rearrange(request: Request):
    """Re-run the layered auto-arrange layout (BRINK/boxology_layout.py) on a
    possibly-already-edited GraphLinksModel -- backs the in-app editor's
    "Re-arrange" button. Same function plan_to_boxology() calls at
    generation time, so layout logic lives in exactly one place."""
    from . import boxology
    body = await request.json()
    loc = boxology.rearrange(body.get("nodeDataArray") or [], body.get("linkDataArray") or [])
    return JSONResponse({"loc": loc})


@app.post("/api/tavus/webhook")
async def tavus_webhook(request: Request):
    from . import tavus_bridge
    body = await request.json()
    return JSONResponse(await tavus_bridge.handle_webhook_event(body, _state))


@app.post("/api/tavus/start_call/{agent}", dependencies=_AUTHED)
async def tavus_start_call(agent: str, request: Request):
    from . import tavus_bridge
    if agent not in tavus_bridge.PAL_IDS:
        return JSONResponse({"error": "Select Scholar, Boxologist, or Cartographer."}, status_code=400)
    callback_url = str(request.base_url).rstrip("/") + "/api/tavus/webhook"
    try:
        result = await tavus_bridge.start_call(agent, callback_url)
    except Exception:
        return JSONResponse({"error": "Could not reach the video service. Please try again."}, status_code=502)
    if result.get("conversation_id"):
        _state["call_events"][result["conversation_id"]] = asyncio.Queue()
    return JSONResponse(result, status_code=502 if result.get("error") else 200)


@app.get("/api/tavus/live/{conversation_id}", dependencies=_AUTHED)
async def tavus_live(conversation_id: str, request: Request):
    """Live transcript + (for Cartographer) graph-query events for one active
    call, pushed by tavus_bridge.handle_webhook_event as Tavus's own
    callback_url events arrive. Plain GET + EventSource on the client --
    unlike chat, this stream needs no POST body or custom header."""
    queue: asyncio.Queue | None = _state["call_events"].get(conversation_id)
    if queue is None:
        return JSONResponse({"error": "No active call with this id."}, status_code=404)

    async def gen() -> AsyncIterator[dict]:
        while True:
            if await request.is_disconnected():
                return
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                continue  # just re-check disconnect; no event to send
            yield event
            if event.get("type") == "call_ended":
                return

    return StreamingResponse(sse(gen()), media_type="text/event-stream",
                              headers={"Cache-Control": "no-store"})


@app.post("/api/tavus/end_call", dependencies=_AUTHED)
async def tavus_end_call(request: Request):
    from . import tavus_bridge
    body = await request.json()
    conversation_id, token = body.get("conversation_id", ""), body.get("end_token", "")
    if not isinstance(conversation_id, str) or not isinstance(token, str):
        return JSONResponse({"error": "Invalid call token"}, status_code=400)
    try:
        result = await tavus_bridge.end_call(conversation_id, token)
    except Exception:
        return JSONResponse({"error": "Could not reach the video service."}, status_code=502)
    queue = _state["call_events"].pop(conversation_id, None)
    if queue is not None:
        await queue.put({"type": "call_ended"})
    return JSONResponse(result, status_code=400 if result.get("error") else 200)


@app.post("/api/tavus/tools/scholar_search")
async def tavus_scholar_tool(request: Request):
    from . import tavus_bridge
    return JSONResponse(await tavus_bridge.scholar_tool(await request.json(), request.headers, _state))


@app.post("/api/tavus/tools/boxology_generate")
async def tavus_boxology_tool(request: Request):
    from . import tavus_bridge
    return JSONResponse(await tavus_bridge.boxology_tool(await request.json(), request.headers, _state))


@app.post("/api/tavus/tools/cartographer_query")
async def tavus_cartographer_tool(request: Request):
    from . import tavus_bridge
    return JSONResponse(await tavus_bridge.cartographer_tool(await request.json(), request.headers, _state))


def _public_profile(user: dict) -> dict:
    return {"username": user["username"], "name": user["name"], "role": user["role"], "avatar": user["avatar"]}


@app.post("/api/auth/login")
async def login(request: Request):
    body = await request.json()
    username = (body.get("username") or "").strip().lower()
    user = auth.check_credentials(username, body.get("password", ""))
    if not user:
        return JSONResponse({"error": "Invalid username or password"}, status_code=401)
    response = JSONResponse({"ok": True, "user": _public_profile(user | {"username": username})})
    auth.set_session_cookie(response, username=username)
    return response


@app.get("/api/auth/me")
async def auth_me(request: Request):
    """Lets the frontend rehydrate who's signed in on page load (or confirm no
    one is) without re-sending a password. Not gated by require_auth -- that
    dependency 401s on no session, which is exactly the normal/expected first
    call here, not an error to short-circuit before the handler can answer it
    with {"user": None}."""
    if not config.AUTH_ENABLED:
        return JSONResponse({"user": None, "auth_enabled": False})
    user = auth.current_user(request)
    return JSONResponse({"user": _public_profile(user) if user else None, "auth_enabled": True})


@app.post("/api/auth/logout")
async def logout():
    response = JSONResponse({"ok": True})
    auth.clear_session_cookie(response)
    return response


def _require_user(request: Request) -> str:
    """Projects are keyed by username, which only exists for a real signed-in
    session -- unlike _AUTHED (a no-op whenever config.AUTH_ENABLED is off),
    this always 401s with no session, since there would be no key to save
    under. The frontend only calls these routes when it already knows a user
    is signed in (falling back to the old browser-local store otherwise)."""
    user = auth.current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user["username"]


@app.get("/api/projects")
async def list_projects(request: Request):
    username = _require_user(request)
    return JSONResponse({"projects": projects_store.list_projects(username)})


@app.post("/api/projects")
async def save_project(request: Request):
    username = _require_user(request)
    body = await request.json()
    return JSONResponse({"project": projects_store.save_project(username, body)})


@app.delete("/api/projects/{project_id}")
async def delete_project(request: Request, project_id: str):
    username = _require_user(request)
    projects_store.delete_project(username, project_id)
    return JSONResponse({"ok": True})


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "time": time.time()}


@app.get("/api/anvil/status", dependencies=_AUTHED)
async def anvil_status():
    """Readiness of Anvil's scale-to-zero vLLM GPU container, for the sidebar
    badge so the user knows when it's warm enough to prompt.

    Deliberately does NOT follow Modal's 303 cold-start redirect. Following it
    holds the request open as a *pending input* on the serve function until the
    container finishes booting (~2-3 min) -- so a browser polling every few
    seconds piled up dozens of stuck /health requests, and the user's real chat
    queued behind them (the growing backlog that made Anvil feel slower over
    time). A quick, non-following probe returns at once instead: issuing the
    request is itself enough to signal Modal to boot, so repeated polls still
    warm the GPU without ever holding a connection.
        303/redirect -> container still cold-booting          -> starting
        200          -> engine live, adapters registered       -> ready
        5xx / timeout-> port up but adapters still loading      -> loading
    vLLM's /health lives at the service root (not under /v1)."""
    import httpx
    root = config.ANVIL_BASE_URL.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3].rstrip("/")
    headers = {"Authorization": f"Bearer {config.ANVIL_API_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=4.0, follow_redirects=False) as client:
            resp = await client.get(f"{root}/health", headers=headers)
        if resp.status_code == 200:
            return JSONResponse({"ready": True, "state": "ready"})
        if resp.status_code in (301, 302, 303, 307, 308):
            return JSONResponse({"ready": False, "state": "starting"})
        # Port up but engine still loading adapters.
        return JSONResponse({"ready": False, "state": "loading"})
    except Exception:
        # No response yet -- container still cold-booting.
        return JSONResponse({"ready": False, "state": "starting"})


@app.get("/api/usage", dependencies=_AUTHED)
async def usage():
    from . import usage as usage_module
    return JSONResponse(await usage_module.get_usage())


app.mount("/", StaticFiles(directory=str(config.APP_DIR / "static"), html=True), name="static")

"""Auto-arrange "director" for the desk UI -- a tiny decision step (not a
chat turn) that picks which call window should be front and how the open
windows should be laid out, adapted from the sibling TIB-Chat-style
project's pattern. Calls Cloudflare Workers AI's `clef-flash` model, which
returns calibrated probabilities per answer in one forward pass given a
state snapshot and a set of typed questions, rather than generating text.

No Cloudflare account is available in this environment -- CF_ACCOUNT_ID/
CF_API_TOKEN are optional, and decide() returns {"available": False} on any
missing config, connection failure, or unexpected response shape. The
frontend already falls back to a fixed default layout for exactly this
case, so this module never needs to be working for the app to function; it
should be smoke-tested once real Cloudflare credentials exist, since the
exact response field names below are a best-effort reconstruction from
documentation, not a verified live call.
"""

from __future__ import annotations

import httpx

from . import config

# One entry per window id desk.js can open; descriptions are the criteria
# text clef-flash sees for the "front" choice question.
WINDOWS = {
    "graph": "the live SPARQL knowledge-graph traversal is the most relevant thing happening",
    "diagram": "the Boxology diagram being built is the most relevant thing happening",
    "notes": "a short written summary of what was just said would help most right now",
    "inspector": "the speaker is focused on one specific node/concept worth inspecting in detail",
    "results": "the raw query result rows are the most relevant thing to show",
}

LAYOUT_CRITERIA = {
    "focus": "one window dominates the screen, the rest are a small side column",
    "split": "two windows share the screen roughly evenly",
    "grid": "all open windows get roughly equal space",
}


def _questions(open_windows: list[str]) -> dict:
    criteria = {w: WINDOWS[w] for w in open_windows if w in WINDOWS} or WINDOWS
    return {
        "front": {
            "type": "choice",
            "instructions": "Given the current phase and what is being said, which open window "
                            "best supports what is happening or being said right now?",
            "criteria": criteria,
        },
        "layout": {
            "type": "choice",
            "instructions": "How should the open windows be arranged on screen right now?",
            "criteria": LAYOUT_CRITERIA,
        },
        "show_inspector": {
            "type": "noul",
            "instructions": "Is the speaker currently talking about one specific node or "
                            "concept worth inspecting in detail?",
        },
        "show_notes": {
            "type": "noul",
            "instructions": "Would a short written summary of what was just said help right now?",
        },
    }


async def decide(state: dict) -> dict:
    """state: a loosely-typed snapshot, e.g. {phase, speaker, utterance,
    question, open_windows, front_window}. clef-flash's own `state` field
    accepts arbitrary JSON, so this is passed through close to verbatim.

    Returns {"available": False} when unconfigured/unreachable/unparseable,
    else {"available": True, "answers": {...}} where `answers` is whatever
    Cloudflare returned for each question in _questions() -- the frontend
    reads it defensively (several possible field names) since the exact
    shape hasn't been verified against a live call."""
    if not (config.CF_ACCOUNT_ID and config.CF_API_TOKEN):
        return {"available": False}

    open_windows = state.get("open_windows") or list(WINDOWS)
    body = {"state": state, "questions": _questions(open_windows)}
    url = f"https://api.cloudflare.com/client/v4/accounts/{config.CF_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash"
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            resp = await client.post(
                url, headers={"Authorization": f"Bearer {config.CF_API_TOKEN}"}, json=body,
            )
        if resp.status_code >= 400:
            return {"available": False}
        payload = resp.json()
    except Exception:
        return {"available": False}

    if not isinstance(payload, dict):
        return {"available": False}
    result = payload.get("result", payload)
    answers = result.get("answers", result) if isinstance(result, dict) else None
    if not isinstance(answers, dict):
        return {"available": False}
    return {"available": True, "answers": answers}

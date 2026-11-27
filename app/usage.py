"""Best-effort usage/cost indicators for the sidebar.

Modal has a real billing API (modal.Workspace.billing.summary()) -- current
calendar month's metered cost and credits applied. Tavus does NOT expose any
account-balance endpoint at all (confirmed directly: GET /v2/accounts and
GET /v2/account both 404), so there is no way to show a true "Tavus credits
left" figure; the Tavus number here is "minutes used across recent
conversations" -- usage so far, not a remaining balance -- labeled as such in
the UI so it isn't mistaken for one.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx

from . import config


async def modal_usage() -> dict:
    try:
        import modal

        def _fetch():
            workspace = modal.Workspace.from_context()
            summary = workspace.billing.summary()
            credits_used = abs(float(summary.adjustments.get("Credits", 0)))
            return {
                "available": True,
                "period_start": summary.start.isoformat(),
                "period_end": summary.end.isoformat(),
                "metered_cost": float(summary.metered_cost),
                "credits_used": credits_used,
                "billed_cost": float(summary.billed_cost),
            }

        # modal.Workspace's billing call is synchronous network I/O -- run
        # off the event loop rather than blocking every other request.
        return await asyncio.to_thread(_fetch)
    except Exception as exc:
        return {"available": False, "error": str(exc)}


async def tavus_usage() -> dict:
    if not config.TAVUS_API_KEY:
        return {"available": False, "error": "No Tavus API key configured."}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://tavusapi.com/v2/conversations",
                headers={"x-api-key": config.TAVUS_API_KEY},
                params={"limit": 100},
            )
        if resp.status_code >= 400:
            return {"available": False, "error": f"Tavus error {resp.status_code}"}
        data = resp.json().get("data", [])
    except Exception as exc:
        return {"available": False, "error": str(exc)}

    now = datetime.now(timezone.utc)
    total_seconds = 0.0
    for conv in data:
        try:
            created = datetime.fromisoformat(conv["created_at"].replace("Z", "+00:00"))
            ended = (
                datetime.fromisoformat(conv["updated_at"].replace("Z", "+00:00"))
                if conv.get("status") == "ended" else now
            )
            total_seconds += max(0.0, (ended - created).total_seconds())
        except (KeyError, ValueError):
            continue
    return {
        "available": True, "conversations_counted": len(data),
        "minutes_used": round(total_seconds / 60, 1),
    }


async def get_usage() -> dict:
    modal_result, tavus_result = await asyncio.gather(modal_usage(), tavus_usage())
    return {"modal": modal_result, "tavus": tavus_result}

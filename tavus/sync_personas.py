#!/usr/bin/env python3
"""Idempotent Tavus persona sync -- creates the Boxology persona once, then
only PATCHes on drift (safe to re-run after a prompt edit), per blueprint
ARCHITECTURE.md §12.

IMPORTANT: this intentionally creates a brand-new persona rather than
targeting any existing one -- a prior persona id this project was initially
given (p12037b9d389) turned out to be an unrelated, fully-built "Nathan"
customer-service-coach persona. Never point this script at that id.

Usage:
    python tavus/sync_personas.py
"""

import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config  # noqa: E402

HERE = Path(__file__).parent
BASE_URL = "https://tavusapi.com/v2"
ENV_FILE = Path(__file__).parent.parent / ".env"
PERSONA_NAME = "Boxology Agents"


def _headers():
    return {"x-api-key": config.TAVUS_API_KEY}


def find_existing_persona(client: httpx.Client) -> dict | None:
    """Check the id already saved in .env first (direct GET by id) rather
    than searching the persona list -- the account has 40+ personas and the
    list endpoint is paginated, so a saved-but-not-on-page-1 persona would
    otherwise look "not found" and get needlessly recreated."""
    if config.BOXOLOGY_PERSONA_ID:
        resp = client.get(f"{BASE_URL}/personas/{config.BOXOLOGY_PERSONA_ID}", headers=_headers())
        if resp.status_code == 200:
            return resp.json()
    return None


def save_persona_id(persona_id: str) -> None:
    if not ENV_FILE.exists():
        return
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    updated = False
    for i, line in enumerate(lines):
        if line.startswith("BOXOLOGY_PERSONA_ID="):
            lines[i] = f"BOXOLOGY_PERSONA_ID={persona_id}"
            updated = True
            break
    if not updated:
        lines.append(f"BOXOLOGY_PERSONA_ID={persona_id}")
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Saved BOXOLOGY_PERSONA_ID={persona_id} to {ENV_FILE}")


def main():
    spec = json.loads((HERE / "personas" / "base_persona.json").read_text(encoding="utf-8"))

    with httpx.Client(timeout=30) as client:
        existing = find_existing_persona(client)

        if existing is None:
            print(f"No persona named {PERSONA_NAME!r} found -- creating it.")
            resp = client.post(f"{BASE_URL}/personas", headers=_headers(), json=spec)
            resp.raise_for_status()
            persona = resp.json()
            print(f"Created persona {persona['persona_id']}")
            save_persona_id(persona["persona_id"])
            return

        persona_id = existing["persona_id"]
        drifted = (
            existing.get("system_prompt") != spec["system_prompt"]
            or existing.get("greeting") != spec["greeting"]
        )
        if not drifted:
            print(f"Persona {persona_id} already in sync -- nothing to do.")
            save_persona_id(persona_id)
            return

        print(f"Persona {persona_id} has drifted from spec -- patching.")
        patch_ops = [
            {"op": "replace", "path": "/system_prompt", "value": spec["system_prompt"]},
            {"op": "replace", "path": "/greeting", "value": spec["greeting"]},
        ]
        resp = client.patch(f"{BASE_URL}/personas/{persona_id}", headers=_headers(), json=patch_ops)
        resp.raise_for_status()
        print(f"Patched persona {persona_id}.")
        save_persona_id(persona_id)


if __name__ == "__main__":
    main()

"""Per-user saved-project storage, keyed by the logged-in username.

Backed by a Modal Dict (modal.Dict.from_name) -- a project saved from one
device/browser is then visible from any other, which plain localStorage
(the old "My projects" store, still used for anonymous/no-auth sessions)
can't do. Modal's Dict client works standalone from any authenticated
process, not just from inside a deployed Modal Function, so this is the
same store whether the app is running locally or on Modal.

Falls back to a local JSON file when the `modal` package isn't importable or
isn't authenticated (e.g. a fully offline local dev run) -- saving still
works, just without cross-device sync, instead of hard-failing every save.
"""

from __future__ import annotations

import json
import time
import uuid

from . import config

_DICT_NAME = "boxology-user-projects"
_dict = None  # lazily resolved: a real modal.Dict, or False if unavailable
_FALLBACK_PATH = config.APP_DIR / "data" / "local_projects.json"


def _get_dict():
    global _dict
    if _dict is None:
        try:
            import modal
            _dict = modal.Dict.from_name(_DICT_NAME, create_if_missing=True)
        except Exception:
            _dict = False
    return _dict


def _load_fallback() -> dict:
    if not _FALLBACK_PATH.exists():
        return {}
    try:
        return json.loads(_FALLBACK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_fallback(data: dict) -> None:
    _FALLBACK_PATH.parent.mkdir(parents=True, exist_ok=True)
    _FALLBACK_PATH.write_text(json.dumps(data), encoding="utf-8")


def _read_all(username: str) -> list[dict]:
    d = _get_dict()
    if d is not False:
        return list(d.get(username, []))
    return list(_load_fallback().get(username, []))


def _write_all(username: str, projects: list[dict]) -> None:
    d = _get_dict()
    if d is not False:
        d[username] = projects
        return
    data = _load_fallback()
    data[username] = projects
    _save_fallback(data)


def list_projects(username: str) -> list[dict]:
    return sorted(_read_all(username), key=lambda p: p.get("updatedAt", ""), reverse=True)


def save_project(username: str, project: dict) -> dict:
    """Upserts by project["id"] (minted here if absent). Returns the stored
    record (with id/createdAt/updatedAt filled in)."""
    project = dict(project)
    project["id"] = project.get("id") or uuid.uuid4().hex
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    project["updatedAt"] = now
    project.setdefault("createdAt", now)
    projects = [p for p in _read_all(username) if p["id"] != project["id"]]
    projects.append(project)
    _write_all(username, projects)
    return project


def delete_project(username: str, project_id: str) -> None:
    projects = [p for p in _read_all(username) if p["id"] != project_id]
    _write_all(username, projects)

"""Named-account cookie gate, per blueprint §5.2. Default OFF
(config.AUTH_ENABLED) -- costs nothing until a public link needs to bound
Modal GPU / Tavus-minute spend from strangers. Three accounts (config.USERS),
not one shared password -- the session token carries which one, so the
frontend can show that person's own name/photo once signed in."""

from __future__ import annotations

import hashlib
import hmac

from fastapi import HTTPException, Request

from . import config

COOKIE_NAME = "boxology_session"
SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 days


def _secret() -> bytes:
    return hmac.new(config.SESSION_SIGNING_KEY.encode(), b"session", hashlib.sha256).digest()


def make_session_token(username: str) -> str:
    mac = hmac.new(_secret(), username.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{username}.{mac}"


def verify_session_token(token: str) -> str | None:
    """Returns the username the token was issued for, or None if missing/forged."""
    if not token or "." not in token:
        return None
    username, _, mac = token.partition(".")
    expected = hmac.new(_secret(), username.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(mac, expected) or username not in config.USERS:
        return None
    return username


def check_credentials(username: str, password: str) -> dict | None:
    """Returns that user's profile dict (name/role/avatar) on success, else None."""
    user = config.USERS.get(username)
    if not user or not user["password"] or not hmac.compare_digest(password, user["password"]):
        return None
    return user


def current_user(request: Request) -> dict | None:
    username = verify_session_token(request.cookies.get(COOKIE_NAME, ""))
    return config.USERS[username] | {"username": username} if username else None


async def require_auth(request: Request) -> None:
    """FastAPI dependency -- no-op entirely when AUTH_ENABLED is false.
    Raises (not returns) so it actually blocks the route: a dependency's
    return value is otherwise silently discarded unless a handler captures
    it, which none of the gated routes below do."""
    if not config.AUTH_ENABLED:
        return
    if not verify_session_token(request.cookies.get(COOKIE_NAME, "")):
        raise HTTPException(status_code=401, detail="Not authenticated")


def set_session_cookie(response, username: str) -> None:
    response.set_cookie(
        COOKIE_NAME, make_session_token(username),
        httponly=True, samesite="strict", max_age=SESSION_TTL_SECONDS,
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(COOKIE_NAME)

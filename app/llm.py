"""Provider-agnostic streaming chat-completions client.

One implementation, reused by every agent (Scholar, Cartographer, and Anvil's
own instance pointed at the Modal endpoint) -- per the blueprint's "build once"
rule for this layer. Works against any OpenAI-compatible /chat/completions
endpoint: Google's Gemini OpenAI-compat endpoint, the Modal/vLLM endpoint, or
(if you ever swap providers) OpenAI/Anthropic-via-compat-shim directly.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx

# While a scale-to-zero Modal/vLLM container is still warming up, its HTTP port
# starts listening *before* the engine + LoRA adapters are registered. In that
# ~2-3 min window /chat/completions answers with 400 ("model `cot2` does not
# exist"), 404, or a 5xx -- none of which mean a genuinely bad request. A client
# that opts into cold_start_retry rides these out (see _stream_once) instead of
# failing the turn.
_WARMING_STATUSES = frozenset({400, 404, 409, 429, 500, 502, 503})
_WARMING_POLL_SECONDS = 3.0

# Quick same-model retries for a transient 429/500/503 (see stream()) --
# short and few on purpose: this delays every retryable failure, including a
# genuine timeout, so it stays well under what a chat UI reads as "hung".
_OVERLOAD_RETRIES = 2
_OVERLOAD_RETRY_SECONDS = 1.5


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # raw JSON string, accumulated across stream chunks
    extra: dict = field(default_factory=dict)  # opaque per-provider fields (e.g.
    # Gemini's "thought_signature") -- never inspected, only stored and replayed
    # verbatim on the next turn; Gemini rejects the follow-up call without it.


@dataclass
class StreamResult:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None


def tool(name: str, description: str, parameters: dict) -> dict:
    """Build an OpenAI-shape tool definition."""
    return {
        "type": "function",
        "function": {"name": name, "description": description, "parameters": parameters},
    }


def history(messages: list[dict], max_turns: int = 20, max_chars: int = 24000) -> list[dict]:
    """Truncate by turn count AND char budget, most recent first preserved."""
    trimmed = messages[-max_turns:]
    total = 0
    kept: list[dict] = []
    for msg in reversed(trimmed):
        size = len(json.dumps(msg))
        if total + size > max_chars and kept:
            break
        kept.append(msg)
        total += size
    return list(reversed(kept))


def tool_turn(tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
    """One assistant message carrying the tool_calls + one tool-role message
    per result, in the same order."""
    assistant_msg = {
        "role": "assistant",
        "tool_calls": [
            {"id": tc.id, "type": "function",
             "function": {"name": tc.name, "arguments": tc.arguments},
             **tc.extra}
            for tc in tool_calls
        ],
    }
    tool_msgs = [
        {"role": "tool", "tool_call_id": tc.id, "content": result}
        for tc, result in zip(tool_calls, results)
    ]
    return [assistant_msg, *tool_msgs]


def error_event(message: str) -> dict:
    """UI-safe error shape -- never leaks the API key or raw provider body."""
    return {"type": "error", "message": message}


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str,
                 fallback_model: str | None = None, timeout: float = 60.0,
                 cold_start_retry: bool = False):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.fallback_model = fallback_model
        self.timeout = timeout
        # Only the Modal/vLLM (Anvil) client sets this: its GPU container scales
        # to zero, so the first request after idle must ride out a cold start.
        # Gemini has no such window, where a 400/5xx is always a real error.
        self.cold_start_retry = cold_start_retry
        self._cold_start_attempts = 60 if cold_start_retry else 30

    async def stream(
        self, messages: list[dict], tools: list[dict] | None = None,
        tool_choice: str | None = None,
        temperature: float = 0.3, max_tokens: int = 1024,
        model: str | None = None,
    ) -> AsyncIterator[dict]:
        """Yields {"type": "delta", "text": ...} and, once at stream end,
        {"type": "tool_calls", "tool_calls": [ToolCall, ...]}, then
        {"type": "done", "finish_reason": ...}. On irrecoverable failure
        yields error_event() and stops -- the caller decides whether that's
        fatal or whether to fall back to raw results it already has.

        To force a final answer on the last allowed tool-call round, pass
        tool_choice="none" while STILL passing the same `tools` list -- do
        not omit `tools` instead. At least Gemini's OpenAI-compat endpoint
        keeps honoring tool-calling behavior from conversation history even
        when `tools` is dropped on a later turn; `tool_choice="none"` is the
        documented, provider-respected way to forbid calls for one turn.

        `model`, if given, overrides self.model for this call only (e.g.
        Anvil picking "cot2" vs "cot3" per request) -- the fallback model is
        still always self.fallback_model, never the override, since a
        per-request override has no fallback equivalent of its own."""
        primary = model or self.model
        last_error = "No model available"
        for attempt, candidate in enumerate([primary, self.fallback_model]):
            if candidate is None:
                continue
            # A 429/500/503 is usually a brief overload, not a dead model --
            # Gemini's own 503 body says so verbatim ("spikes in demand are
            # usually temporary"). A couple of quick same-model retries
            # clears most of these; only after they're exhausted does this
            # burn the one switch to the fallback model.
            for retry in range(_OVERLOAD_RETRIES + 1):
                try:
                    async for event in self._stream_once(messages, tools, tool_choice, temperature, max_tokens, candidate):
                        yield event
                    return
                except _RetryableError as exc:
                    last_error = str(exc)
                    if retry < _OVERLOAD_RETRIES:
                        await asyncio.sleep(_OVERLOAD_RETRY_SECONDS)
            if attempt == 0 and self.fallback_model:
                continue  # try the fallback model before any output has streamed
        yield error_event(last_error)

    async def _stream_once(self, messages, tools, tool_choice, temperature, max_tokens, model) -> AsyncIterator[dict]:
        body = {
            "model": model, "messages": messages, "stream": True,
            "temperature": temperature, "max_tokens": max_tokens,
        }
        if tools:
            body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice

        pending_tool_calls: dict[int, dict] = {}
        finish_reason = None

        # Modal's web_server cold-start mechanism answers the first request to
        # a sleeping container with a 303 + "retry this exact request" Location
        # URL (carrying a short-lived attempt token), not a real response. A
        # 303 is a *method-changing* redirect (POST -> GET) by HTTP spec, so
        # letting a client auto-follow it (httpx's follow_redirects=True, or
        # PowerShell's Invoke-WebRequest, which instead prompts for
        # confirmation and fails non-interactively) silently drops the POST
        # body. The correct move is to manually re-POST the *same* body to the
        # Location URL and keep doing so until a real (non-303) response
        # arrives or cold start genuinely times out. Using client.send(stream=
        # True) instead of the `async with client.stream()` context manager
        # since that form forces the response to close the moment its `with`
        # block exits -- which happens on every redirect iteration -- leaving
        # no way to keep the final, real response open afterward.
        base_target = f"{self.base_url}/chat/completions"
        url = base_target
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = None
            try:
                for _attempt in range(self._cold_start_attempts):  # cold start can take a few minutes
                    request = client.build_request("POST", url, headers=headers, json=body)
                    candidate = await client.send(request, stream=True)
                    if candidate.status_code == 303:
                        url = candidate.headers["location"]
                        await candidate.aclose()
                        continue
                    if self.cold_start_retry and candidate.status_code in _WARMING_STATUSES:
                        # Container is up and listening, but vLLM's engine/LoRA
                        # adapters aren't registered yet. Nothing has streamed, so
                        # wait briefly and re-POST a *fresh* request to the base
                        # URL (the 303 attempt token is single-use) rather than
                        # failing the turn. Gemini never takes this branch.
                        await candidate.aclose()
                        url = base_target
                        await asyncio.sleep(_WARMING_POLL_SECONDS)
                        continue
                    response = candidate
                    break
                else:
                    raise _RetryableError("Model did not become ready after cold-start retries")

                if response.status_code in (429, 500, 503):
                    raise _RetryableError(f"Upstream {response.status_code}")
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if payload == "[DONE]":
                        break
                    chunk = json.loads(payload)
                    choice = chunk["choices"][0]
                    delta = choice.get("delta", {})
                    if delta.get("content"):
                        yield {"type": "delta", "text": delta["content"]}
                    for i, tc_delta in enumerate(delta.get("tool_calls") or []):
                        idx = tc_delta.get("index", i)
                        entry = pending_tool_calls.setdefault(
                            idx, {"id": "", "name": "", "arguments": "", "extra": {}})
                        if tc_delta.get("id"):
                            entry["id"] = tc_delta["id"]
                        fn = tc_delta.get("function") or {}
                        if fn.get("name"):
                            entry["name"] += fn["name"]
                        if fn.get("arguments"):
                            entry["arguments"] += fn["arguments"]
                        if tc_delta.get("extra_content"):
                            entry["extra"]["extra_content"] = tc_delta["extra_content"]
                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code in (429, 500, 503):
                    raise _RetryableError(str(exc)) from exc
                raise
            except httpx.TimeoutException as exc:
                raise _RetryableError(f"Upstream timed out: {exc}") from exc
            finally:
                if response is not None:
                    await response.aclose()

        if pending_tool_calls:
            yield {
                "type": "tool_calls",
                "tool_calls": [
                    ToolCall(id=v["id"], name=v["name"], arguments=v["arguments"], extra=v["extra"])
                    for v in pending_tool_calls.values()
                ],
            }
        yield {"type": "done", "finish_reason": finish_reason}


class _RetryableError(Exception):
    pass

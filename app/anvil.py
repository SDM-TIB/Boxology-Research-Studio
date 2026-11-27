"""Anvil (Agent B) -- thin proxy to the Modal-hosted vLLM endpoint serving
Qwen2.5-3B-Instruct + the published T4B LoRA adapter, for free-form design
conversation. Deliberately no tools, no retrieval -- answers from its trained
weights alone, per blueprint §8b, in contrast to Scholar (cites papers) and
Cartographer (walks the graph live). vLLM's own serving command has no
--enable-auto-tool-choice flag (checked: passing `tools` to it 400s), so this
isn't just a framing choice, it's also the only client here that can't do
tool-calling at the transport level.

One text box, not two: chat() still gets the design to a downloadable file
without a separate "generate diagram" form, but Anvil itself never decides to
call the tool. A second, separate call to the reasoning client (Gemini,
_state["reasoning_client"]) -- the same client Scholar/Cartographer already
use for reliable tool-calling -- looks at the exchange that just happened and
decides whether to call generate_boxology. Anvil's own reply streams first
and is never blocked on this; the plan event (if any) follows it. generate_plan()
is also reused as-is by tavus_bridge.boxology_tool() for the voice PAL path.
"""

from __future__ import annotations

import json
import re

from . import boxology, llm

SYSTEM_PROMPT = """You are Anvil, shown to the user as "Boxologist" -- a fine-tuned model for a tool \
that helps engineers design and validate neuro-symbolic ("Boxology") systems. You were fine-tuned on \
chain-of-thought examples mined from a real Boxology knowledge graph (the same graph Cartographer \
reasons over live). You discuss designs from your trained weights alone -- no tools, no retrieval, no \
live lookup. Have a normal design conversation: ask what the user wants to build, propose concrete \
Boxology components (artifacts, processes, models) and how they connect, and refine based on \
feedback. If the user asks to generate, export, finalize, or download the design, tell them it is \
being produced now rather than describing it in words -- a complete file is generated separately \
right after your reply and shown to them directly, so never claim you cannot produce one. If you are \
unsure about a modeling choice, say so rather than inventing a rule you don't have -- you have no way \
to verify anything beyond the validator's own output."""

GENERATION_ROUTER_PROMPT = """You decide whether a Boxology system-design conversation has just \
reached the point where the design should be rendered into a file. You are not part of the \
conversation; you only ever call one tool or do nothing. Call generate_boxology ONLY if the user's \
latest message confirms the design, or explicitly asks to generate, export, finalize, or download it. \
If they are still exploring, asking questions, or refining details, do not call anything."""


def _tools() -> list[dict]:
    return [
        llm.tool(
            "generate_boxology",
            "Generate and validate the complete Tool4Boxology diagram file for the system just discussed.",
            {"type": "object", "properties": {
                "description": {"type": "string", "description": (
                    "A complete, self-contained description of the final system -- its inputs, "
                    "models/processes, outputs, and how they connect -- synthesized from the whole "
                    "conversation. Write it fresh; do not just repeat the user's last message."
                )},
            }, "required": ["description"]},
        ),
    ]


def _cut_at_last_sentence(text: str) -> str:
    """Never show/speak a truncated mid-word answer (Tavus one-shot call mode)."""
    matches = list(re.finditer(r"[.!?](?:\s|$)", text))
    if not matches:
        return text
    return text[:matches[-1].end()].strip()


async def chat(client: llm.LLMClient, plan_client: llm.LLMClient, user_message: str,
               history_msgs: list[dict], one_shot: bool = False, model: str | None = None):
    """Async generator yielding {"type": "text"|"tool_call"|"plan", ...} then
    "done"/"error". one_shot=True (Tavus one-shot call mode) also skips the
    generation-router pass and cuts the final text at the last complete
    sentence. `model` picks which LoRA variant answers ("cot2"/"cot3") --
    only affects this conversational reply; generate_plan() below always
    uses plan_client (Gemini), never the fine-tuned model, regardless."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                *llm.history(history_msgs), {"role": "user", "content": user_message}]
    full_text = ""
    async for event in client.stream(messages, temperature=0.0, model=model):
        if event["type"] == "delta":
            full_text += event["text"]
            if not one_shot:
                yield {"type": "text", "text": event["text"]}
        elif event["type"] == "error":
            yield llm.error_event(event["message"])
            return

    if one_shot:
        yield {"type": "text", "text": _cut_at_last_sentence(full_text)}
        yield {"type": "done"}
        return

    # Must end on a user turn -- Gemini rejects a request ending on an
    # assistant turn ("Requests ending with a model turn are not supported"),
    # so the just-streamed reply is folded into one final user-role message
    # instead of appended as its own assistant turn.
    router_messages = [
        {"role": "system", "content": GENERATION_ROUTER_PROMPT},
        *llm.history(history_msgs),
        {"role": "user", "content": (
            f"{user_message}\n\n---\nAnvil's reply: {full_text}\n\n"
            "Given the full conversation and this latest exchange, should the system now be "
            "generated as a file? Call generate_boxology if yes; otherwise do not call anything."
        )},
    ]
    tool_calls = []
    async for event in plan_client.stream(router_messages, tools=_tools(), tool_choice="auto", temperature=0.0):
        if event["type"] == "tool_calls":
            tool_calls = event["tool_calls"]
        elif event["type"] == "error":
            break  # the router failing must not take down a reply that already streamed fine

    for tc in tool_calls:
        if tc.name != "generate_boxology":
            continue
        try:
            args = json.loads(tc.arguments or "{}")
        except json.JSONDecodeError:
            args = {}
        yield {"type": "tool_call", "name": "generate_boxology"}
        result = await generate_plan(plan_client, args.get("description") or user_message)
        if result.get("error"):
            yield {"type": "text", "text": f"\n\n(Could not generate the file: {result['error']})"}
        else:
            yield {
                "type": "plan", "valid": result["valid"], "problems": result["problems"],
                "boxology_file": result["boxology_file"], "semantic_file": result["semantic_file"],
            }
        break  # at most one file per turn

    yield {"type": "done"}


async def generate_plan(client: llm.LLMClient, description: str) -> dict:
    """Description -> validated plan -> rendered .boxology + semantic JSON.
    Reuses BRINK's exact plan/validate/render pipeline (app/boxology.py)."""
    messages = boxology.build_messages(
        boxology.PLAN_SYSTEM_PROMPT, boxology.GENERATE_INSTRUCTION + description,
    )
    plan = None
    problems = ["No plan was generated."]
    text = ""
    # Validation-guided retries turn the model's compact architecture plan
    # into a reliably importable Tool4Boxology GraphLinksModel.
    for attempt in range(3):
        text = ""
        async for event in client.stream(messages, temperature=0.0, max_tokens=1800):
            if event["type"] == "delta":
                text += event["text"]
            elif event["type"] == "error":
                return {"error": event["message"]}
        plan = boxology.extract_plan(text)
        if plan is not None:
            problems = boxology.validate_plan(plan)
            if not problems:
                break
        issue_text = "; ".join(problems) if plan is not None else "No JSON plan could be parsed."
        messages.extend([
            {"role": "assistant", "content": text},
            {"role": "user", "content": (
                "Repair the plan and return the complete strict JSON plan only. "
                f"Validator issues: {issue_text}"
            )},
        ])
    if plan is None:
        return {"error": "Could not find a valid plan JSON in the model output.", "raw": text}
    boxology_file = boxology.plan_to_boxology(plan)
    semantic_file = boxology.plan_to_semantic_json(plan)
    return {
        "plan": plan, "problems": problems, "valid": not problems,
        "boxology_file": boxology_file, "semantic_file": semantic_file,
    }

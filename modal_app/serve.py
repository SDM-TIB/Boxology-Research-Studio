"""Anvil (Agent B) serving on Modal: vLLM multi-LoRA GPU serving function
(Llama-3.2-1B-Instruct base + the CoT2/CoT3 rule-grounded adapters, selected
per request) plus the main web app, per blueprint ARCHITECTURE.md §8b.

Deploy:
    modal deploy modal_app/serve.py

The deploy prints a public https://....modal.run URL -- that is Anvil's
OpenAI-compatible endpoint (ANVIL_BASE_URL in the main app's .env). Clients
select an adapter via the normal "model" field: "cot2" (default, higher
accuracy/recall) or "cot3" (higher precision, lower coverage); the bare base
model is also queryable as "anvil-base".
"""

import os
import subprocess
import time
from pathlib import Path

import modal

REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # .../T4B-LLM
AGENTS_ROOT = Path(__file__).resolve().parent.parent        # .../boxology-agents
ADAPTERS_ROOT = REPO_ROOT / "T4B_cloudrift"

BASE_MODEL = "meta-llama/Llama-3.2-1B-Instruct"
# r=16 for both adapters (confirmed via each adapter_config.json) -- must
# match --max-lora-rank below.
LORA_RANK = 16
ADAPTERS = {
    "cot2": ADAPTERS_ROOT / "finetuned_LLaMA_3.2_1B_with_rules_CoT2",
    "cot3": ADAPTERS_ROOT / "finetuned_LLaMA_3.2_1B_with_rules_CoT3",
}
# Only the PEFT adapter files are needed to serve -- each source directory
# also has a checkpoint-200/ subfolder (duplicate weights + optimizer state
# for resuming training) that would roughly double image size for nothing at
# inference time, so this bundles the two serving files individually rather
# than the whole directory.
ADAPTER_FILES = ("adapter_config.json", "adapter_model.safetensors")
ADAPTERS_ROOT_CONTAINER = "/models/adapters"

app = modal.App("t4b-ai-assist-desk")

serve_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("vllm==0.31.0")  # pinned to the confirmed-working version (was unpinned; /version reports 0.31.0)
    # The minimal debian_slim image has no nvcc -- FlashInfer's sampler
    # JIT-compiles a CUDA kernel on first real inference and fails with
    # "Could not find nvcc" without it. Disable it; vLLM falls back to its
    # native (pre-built, no-JIT) sampler. Fine at this model size/traffic.
    .env({"VLLM_USE_FLASHINFER_SAMPLER": "0"})
)
for _name, _path in ADAPTERS.items():
    for _filename in ADAPTER_FILES:
        serve_image = serve_image.add_local_file(
            str(_path / _filename), f"{ADAPTERS_ROOT_CONTAINER}/{_name}/{_filename}", copy=True,
        )

# meta-llama/Llama-3.2-1B-Instruct is a gated HF repo (unlike Qwen2.5-3B,
# which wasn't -- the old merge-based setup needed no HF auth at all); vLLM
# needs a token with access to it to pull the base model at container start.
# Create once: `modal secret create huggingface-token HF_TOKEN=<token>`.
hf_secret = modal.Secret.from_name("huggingface-token", required_keys=["HF_TOKEN"])
anvil_api_key_secret = modal.Secret.from_name("anvil-api-key", required_keys=["ANVIL_API_KEY"])


@app.function(
    image=serve_image,
    gpu="A10G",  # was L4; switched after L4 containers stopped scheduling in us-east
    scaledown_window=1800,  # scale to zero 30 min after the last request -- cold boot is
    # ~2-3 min (base model + both LoRA adapters), so this trades idle GPU cost for fewer
    # cold starts during a working session.
    secrets=[hf_secret, anvil_api_key_secret],
    timeout=900,
    min_containers=0,
)
@modal.web_server(port=8000, startup_timeout=600)
def serve():
    """Starts vLLM's OpenAI-compatible API server as a background process
    with both LoRA adapters loaded for dynamic per-request selection -- no
    merge-to-volume step needed, vLLM applies a LoRA adapter at inference
    time from the small adapter files bundled onto this image. Clients pick
    one via the normal "model" field: "cot2" | "cot3" | "anvil-base" (the
    bare, un-adapted base model).

    --enforce-eager skips CUDA graph capture: slightly lower steady-state
    throughput, much faster cold start -- the right trade for a 1B model on
    scale-to-zero serving with sporadic demo traffic, not a high-throughput
    production endpoint."""
    api_key = os.environ["ANVIL_API_KEY"]
    subprocess.Popen([
        "python", "-m", "vllm.entrypoints.openai.api_server",
        "--model", BASE_MODEL,
        "--served-model-name", "anvil-base",
        "--enable-lora",
        "--lora-modules",
        f"cot2={ADAPTERS_ROOT_CONTAINER}/cot2", f"cot3={ADAPTERS_ROOT_CONTAINER}/cot3",
        "--max-lora-rank", str(LORA_RANK),
        "--max-loras", "2",
        "--api-key", api_key,
        "--host", "0.0.0.0",
        "--port", "8000",
        "--enforce-eager",
        "--max-model-len", "4096",
        "--gpu-memory-utilization", "0.90",
    ])
    # The web_server decorator starts probing the port immediately; give vLLM
    # a moment before the first health check so it isn't marked unhealthy
    # before it's listening.
    time.sleep(5)


# ---------------------------------------------------------------------------
# Main web app (Scholar + Cartographer + Anvil-proxy + Tavus webhook + static
# frontend) -- deployed in this SAME Modal App as Anvil's GPU function, per
# the hosting decision (one platform, one bill).
# ---------------------------------------------------------------------------

# A machine-specific extra-examples folder -- only present on some dev
# checkouts. app/kg.py and app/sparql_store.py already treat it as optional
# (both check .exists() before globbing), so bundle it only when it's
# actually there instead of hard-failing the image build when it's absent.
EXAMPLES_DIR = REPO_ROOT.parent.parent / "NeSy KG Files" / "NeSy KG-T4B" / "Save" / "new"

webapp_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi", "httpx", "python-multipart", "rdflib", "modal")
    # app/boxology.py reaches files one level outside boxology-agents/ via
    # sys.path -- llm_config.py (the Boxology grammar/prompt source) and
    # BRINK/kg_concepts.py + boxology_layout.py (the plan/validate/render/
    # auto-arrange pipeline it re-exports). Bundle them at the same relative
    # layout the sys.path trick expects. Versioned destination avoids Modal
    # reusing an older local-directory layer when only files inside the
    # directory changed.
    .add_local_dir(str(AGENTS_ROOT / "app"), "/opt/boxology-pal-v2/boxology_app", copy=True)
    .add_local_dir(str(AGENTS_ROOT / "tavus"), "/opt/boxology-pal-v2/tavus", copy=True)
    .add_local_file(str(REPO_ROOT / "NeSy-CoT" / "KG" / "T4B" / "T4B.nt"),
                    "/opt/boxology-pal-v2/T4B.nt", copy=True)
    .env({"KG_NT_PATH": "/opt/boxology-pal-v2/T4B.nt",
          "BOXOLOGY_BUILD_VERSION": "pal-v2"})
    .add_local_file(str(REPO_ROOT / "llm_config.py"), "/root/llm_config.py", copy=True)
    # app/boxology.py imports kg_concepts as a top-level module.  The Modal
    # function adds /root to sys.path, so place both files directly there --
    # boxology_layout.py must sit next to kg_concepts.py since the latter
    # imports it as a plain same-directory import.
    .add_local_file(str(REPO_ROOT / "BRINK" / "kg_concepts.py"), "/root/kg_concepts.py", copy=True)
    .add_local_file(str(REPO_ROOT / "BRINK" / "boxology_layout.py"), "/root/boxology_layout.py", copy=True)
)
if EXAMPLES_DIR.exists():
    webapp_image = (
        webapp_image
        .add_local_dir(str(EXAMPLES_DIR), "/opt/boxology-pal-v2/examples", copy=True)
        .env({"BOXOLOGY_EXAMPLES_DIR": "/opt/boxology-pal-v2/examples"})
    )

webapp_secrets = modal.Secret.from_name(
    "boxology-app-secrets",
    required_keys=["GEMINI_API_KEY", "TAVUS_API_KEY", "TAVUS_TOOL_KEY",
                   "BOXOLOGY_SCHOLAR_PAL_ID", "BOXOLOGY_BUILDER_PAL_ID",
                   "BOXOLOGY_CARTOGRAPHER_PAL_ID", "ANVIL_BASE_URL", "ANVIL_API_KEY"],
)
# Separate secret (not folded into boxology-app-secrets) so enabling the
# now-5-person login never risks touching the existing, already-depended-on
# one. `modal secret create boxology-auth AUTH_ENABLED=true USER_VIDAL_PASSWORD=... \
#  USER_DISHA_PASSWORD=... USER_MAHSA_PASSWORD=... USER_YASHRAJ_PASSWORD=... \
#  USER_ENRIQUE_PASSWORD=...`
auth_secret = modal.Secret.from_name(
    "boxology-auth",
    required_keys=["AUTH_ENABLED", "USER_VIDAL_PASSWORD", "USER_DISHA_PASSWORD", "USER_MAHSA_PASSWORD",
                   "USER_YASHRAJ_PASSWORD", "USER_ENRIQUE_PASSWORD"],
)
# boxology-app-secrets' own ANVIL_BASE_URL still points at t4bstudio's serve
# function (a different, older Modal workspace) -- confirmed: that URL 404s,
# this workspace's own serve URL (below) returns a clean 200. Overriding via
# a separate secret, listed after webapp_secrets so it wins on this one key,
# rather than touching the multi-key secret and risking its other 7 values.
anvil_url_secret = modal.Secret.from_name("T4B_secret", required_keys=["ANVIL_BASE_URL"])


@app.function(
    image=webapp_image, secrets=[webapp_secrets, auth_secret, anvil_url_secret], min_containers=0, scaledown_window=300,
    # _state (corpus/graph/sparql_store/call_events) is a plain in-process
    # dict, by design (blueprint §5.1: single stateful instance, no DB) --
    # without this cap, Modal can route a call's start_call/webhook/live-SSE
    # requests to different container instances, each with its own empty
    # _state["call_events"], silently dropping Tavus webhook events (the
    # live transcript/diagram never arriving during a real call was exactly
    # this: start_call created the queue in one container, the webhook POST
    # landed on another).
    max_containers=1,
    # /api/tavus/live/{id} holds one HTTP request open for an entire call --
    # potentially many minutes. Without @modal.concurrent below, Modal treats
    # each request as one "input" and processes them ONE AT A TIME per
    # container by default; paired with max_containers=1 above, a single
    # live-SSE connection would then block the ENTIRE app (confirmed live:
    # a stray open SSE connection caused subsequent requests, including
    # /healthz, to hang or 502 until Modal's 300s default input timeout
    # killed it). timeout= also raised well past the 300s default so a real,
    # longer call's SSE connection isn't force-killed mid-call.
    timeout=3600,
)
@modal.concurrent(max_inputs=32)
@modal.asgi_app()
def web():
    import sys
    sys.path.insert(0, "/opt/boxology-pal-v2")
    sys.path.insert(1, "/root")
    from boxology_app.server import app as fastapi_app
    return fastapi_app

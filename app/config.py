"""Every environment variable the app reads, in one place.

.env (gitignored) is loaded first; real process environment variables always
win over it, so a deployed host's env vars override local defaults without
editing this file.
"""

import os
from pathlib import Path

APP_DIR = Path(__file__).parent
REPO_ROOT = APP_DIR.parent.parent  # .../T4B-LLM


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()


_load_dotenv(APP_DIR.parent / ".env")


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


# --- Scholar / Cartographer reasoning LLM -----------------------------------
# Google's OpenAI-compatible endpoint (not the native Gemini API shape in
# llm_config.PROVIDERS["gemini"]["endpoint"]) -- this lets app/llm.py's SSE
# parser be written once, against the OpenAI chat-completions shape, and work
# unmodified against any provider.
LLM_BASE_URL = _env("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
LLM_MODEL = _env("LLM_MODEL", "gemini-3.5-flash-lite")
LLM_FALLBACK_MODEL = _env("LLM_FALLBACK_MODEL", "gemini-flash-lite-latest")
LLM_API_KEY = _env("GEMINI_API_KEY")

# --- Anvil (Agent B) — Modal-hosted vLLM endpoint ---------------------------
ANVIL_BASE_URL = _env("ANVIL_BASE_URL")
ANVIL_API_KEY = _env("ANVIL_API_KEY")

# --- Tavus video layer -------------------------------------------------------
TAVUS_API_KEY = _env("TAVUS_API_KEY")
TAVUS_WORKSPACE_ID = _env("TAVUS_WORKSPACE_ID", "b2af3007c9")
TAVUS_TOOL_KEY = _env("TAVUS_TOOL_KEY")
BOXOLOGY_SCHOLAR_PAL_ID = _env("BOXOLOGY_SCHOLAR_PAL_ID")
BOXOLOGY_BUILDER_PAL_ID = _env("BOXOLOGY_BUILDER_PAL_ID")
BOXOLOGY_CARTOGRAPHER_PAL_ID = _env("BOXOLOGY_CARTOGRAPHER_PAL_ID")

# --- Auto-arrange "director" (Cloudflare Workers AI clef-flash) -------------
# Optional: the desk UI's window/layout auto-arrange degrades gracefully to a
# fixed default (focus layout, active agent's primary window front) when these
# are unset -- no Cloudflare account is required for the app to work.
CF_ACCOUNT_ID = _env("CF_ACCOUNT_ID")
CF_API_TOKEN = _env("CF_API_TOKEN")

# --- Anvil (Agent B) default LoRA variant ------------------------------------
ANVIL_DEFAULT_MODEL = _env("ANVIL_DEFAULT_MODEL", "cot2")

# --- Auth (default OFF) ------------------------------------------------------
# Named accounts, not one shared password -- each team member's own login,
# session, and profile (shown in the sidebar once signed in). Password is
# empty (login always fails) for anyone whose env var isn't set.
AUTH_ENABLED = _env("AUTH_ENABLED", "false").lower() == "true"
SESSION_SIGNING_KEY = _env("SESSION_SIGNING_KEY", "dev-only-insecure-key-change-me")
USERS = {
    "vidal": {
        "password": _env("USER_VIDAL_PASSWORD"),
        "name": "Maria-Esther Vidal", "role": "Professor",
        "avatar": "/images/people/Maria-Esther_Vidal.png",
    },
    "disha": {
        "password": _env("USER_DISHA_PASSWORD"),
        "name": "Disha Purohit", "role": "Researcher",
        "avatar": "/images/people/Disha_Purohit.jpg",
    },
    "mahsa": {
        "password": _env("USER_MAHSA_PASSWORD"),
        "name": "Mahsa Forghani", "role": "Developer",
        "avatar": "/images/people/Mahsa_Forghani.png",
    },
    "yashraj": {
        "password": _env("USER_YASHRAJ_PASSWORD"),
        "name": "Yashraj Chudasama", "role": "Researcher",
        "avatar": "/images/people/Yashrajsinh_Chudasama.png",
    },
    "enrique": {
        "password": _env("USER_ENRIQUE_PASSWORD"),
        "name": "Enrique Iglesias", "role": "Researcher",
        "avatar": "/images/people/Enrique_Iglesias.png",
    },
}

# --- Data artifacts -----------------------------------------------------------
CORPUS_PATH = APP_DIR / "data" / "corpus.json.gz"
KG_GRAPH_PATH = APP_DIR / "data" / "kg_graph.json.gz"
KG_NT_PATH = Path(_env("KG_NT_PATH", str(REPO_ROOT / "NeSy-CoT" / "KG" / "T4B" / "T4B.nt")))
BOXOLOGY_EXAMPLES_DIR = Path(_env(
    "BOXOLOGY_EXAMPLES_DIR",
    str(REPO_ROOT.parent.parent / "NeSy KG Files" / "NeSy KG-T4B" / "Save" / "new"),
))

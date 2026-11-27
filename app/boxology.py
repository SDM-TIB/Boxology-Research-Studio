"""Re-exports BRINK/kg_concepts.py's plan/validate/render functions -- the
Boxology grammar has exactly one source of truth (llm_config.py at the repo
root), and kg_concepts.py is its one existing consumer. Import, don't copy.
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # .../T4B-LLM
_BRINK_DIR = _REPO_ROOT / "BRINK"
if str(_BRINK_DIR) not in sys.path:
    sys.path.insert(0, str(_BRINK_DIR))

import kg_concepts  # noqa: E402
import llm_config  # noqa: E402

build_messages = kg_concepts.build_messages
extract_plan = kg_concepts.extract_plan
validate_plan = kg_concepts.validate_plan
plan_to_boxology = kg_concepts.plan_to_boxology
plan_to_semantic_json = kg_concepts.plan_to_semantic_json
rearrange = kg_concepts.boxology_layout.rearrange
ADVICE_SYSTEM_PROMPT = kg_concepts.ADVICE_SYSTEM_PROMPT
PLAN_SYSTEM_PROMPT = kg_concepts.PLAN_SYSTEM_PROMPT or llm_config.get_planning_prompt()
GENERATE_INSTRUCTION = getattr(kg_concepts, "GENERATE_INSTRUCTION", "Design a system for: ")

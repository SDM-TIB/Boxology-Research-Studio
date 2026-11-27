## Research workflow

![Boxology Studio research workflow](images/Boxology%20Studio%20Research%20Workflow.png)

# Boxology Research Studio

A web app that helps engineers design and validate **neuro-symbolic ("Boxology") systems** —
diagrams that combine fuzzy/neuro/symbolic components for clinical decision support. It puts three
different agents side by side, each grounded in knowledge a different way, plus a diagram editor and
optional video-avatar calls.

## The three agents

| Agent | Shown as | How it's grounded | What it's good for |
|---|---|---|---|
| **Scholar** (Agent A) | Scholar | RAG over 69 academic papers (BM25 search, cites every claim as `[n]`) | "What does the literature say about X?" |
| **Anvil** (Agent B) | Boxologist | A small LLM (Llama-3.2-1B) fine-tuned on chain-of-thought reasoning mined from the knowledge graph, served on Modal with two selectable LoRA adapters (`cot2`, `cot3`) | Free-form design discussion from trained weights alone, no live lookup |
| **Cartographer** (Agent C) | Cartographer | Live SPARQL queries over a real RDF knowledge graph of Boxology diagrams | "Show me / query the actual graph" |

A fourth piece, the **diagram editor** (`app/boxology.py`), turns any agent's design into a
GoJS-style Boxology diagram (auto-laid-out, re-arrangeable, downloadable).

Optionally, each agent can also be talked to as a video avatar via **Tavus** (`app/tavus_bridge.py`),
with the same tool calls as the text chat underneath.

## Project layout

```
app/              FastAPI backend + static frontend
  server.py       All HTTP routes
  scholar.py      Agent A (retrieval)
  anvil.py        Agent B (fine-tuned LLM proxy)
  cartographer.py Agent C (SPARQL reasoning)
  boxology.py     Diagram plan -> GoJS model (imports BRINK/kg_concepts.py)
  auth.py         Optional named-account login
  projects_store.py  Per-user saved projects (Modal Dict, with local JSON fallback)
  tavus_bridge.py Video-avatar webhook + tool-call bridge
  director.py     Optional desk-UI window auto-arrange (Cloudflare Workers AI)
  static/         Frontend (HTML/CSS/vanilla JS)
pipeline/         One-off scripts that build the data artifacts app/ loads
  build_corpus.py     PDFs -> app/data/corpus.json.gz (Scholar's corpus)
  build_kg_graph.py   NeSy-CoT outputs -> app/data/kg_graph.json.gz (Cartographer's graph)
tavus/            Scripts to create/update the Tavus personas and PALs
modal_app/serve.py  Deploys the GPU LoRA server + this whole web app on Modal
tests/            Playwright-based frontend smoke tests
```

## Setup

```bash
cd boxology-agents
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
```

Create a `.env` file (gitignored) in this folder with the variables listed below.

### Environment variables

| Variable | Needed for |
|---|---|
| `GEMINI_API_KEY` | Scholar/Cartographer's reasoning LLM (tool-calling) |
| `ANVIL_BASE_URL`, `ANVIL_API_KEY` | Anvil's Modal-hosted vLLM endpoint |
| `TAVUS_API_KEY`, `TAVUS_WORKSPACE_ID`, `TAVUS_TOOL_KEY` | Video-avatar calls |
| `BOXOLOGY_SCHOLAR_PAL_ID`, `BOXOLOGY_BUILDER_PAL_ID`, `BOXOLOGY_CARTOGRAPHER_PAL_ID` | Which Tavus PAL backs each agent's video call |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Optional — desk UI auto-arrange. App works fine without these |
| `AUTH_ENABLED` + `USER_<NAME>_PASSWORD` | Optional — turn on named-account login (off by default) |

None of these are required just to explore the code; only to run agents that call out to a real
service. See `app/config.py` for every variable and its default.

## Data artifacts the app needs

The backend loads two generated files at startup — `app/data/corpus.json.gz` and
`app/data/kg_graph.json.gz` — which are gitignored because they're built, not hand-written:

```bash
python pipeline/build_corpus.py      # needs pipeline/raw/Kierner papers/*.pdf
python pipeline/build_kg_graph.py    # needs the NeSy-CoT outputs one level up
```

## Run it

```bash
uvicorn app.server:app --reload
```

Then open http://127.0.0.1:8000.

## Deploy

The whole app (web server + Anvil's GPU-backed LoRA server) deploys to [Modal](https://modal.com) as
one app:

```bash
modal deploy modal_app/serve.py
```

## Tests

Frontend smoke tests use Playwright and run against the static files directly (no live backend
needed — API calls are mocked):

```bash
cd tests
node frontend_smoke.cjs
```

## More context

`../blueprint/ARCHITECTURE.md` and `../blueprint/BUILD_PLAYBOOK.md` describe the reference
architecture this app was built from, if you want the full design rationale behind any component.

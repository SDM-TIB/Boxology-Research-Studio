"""Cartographer (Agent C) -- live SPARQL reasoning over the T4B Boxology
knowledge graph, per blueprint ARCHITECTURE.md §9.3.

Reasons over one connected RDF graph (app/sparql_store.py): T4B.nt's real
diagram structure (Boxology/DesignPattern/Component, linked by hasInput/
hasOutput/hasPattern/hasProcess). Cartographer's value is live, explainable
SPARQL over real Boxology diagrams -- narrated that way, not oversold as
general neuro-symbolic Q&A (that's Scholar's/Anvil's job).
"""

from __future__ import annotations

import json

from rdflib import Graph as RdfGraph

from . import llm, sparql_store
from .kg import Graph
from .retrieve import hybrid_explore

MAX_TOOL_ROUNDS = 4  # one query, one schema-discovery recovery, one retry, one spare

SYSTEM_PROMPT = """You are Cartographer, a knowledge-graph-reasoning agent for \
a tool that helps engineers design and validate neuro-symbolic ("Boxology") \
systems. You reason over a live SPARQL-queryable RDF graph of real Boxology \
diagrams.

THE GRAPH USES EXACTLY ONE NAMESPACE -- DO NOT USE ANY OTHER: \
t4b: <http://tool4boxology.org/>. You may recognize "Boxology" from the \
published van Bekkum/Kautz academic ontology (e.g. purl.org namespaces) -- \
THIS IS NOT THAT GRAPH. This is a project-specific graph with its own \
classes and predicates, listed exhaustively below. Every query you write \
MUST begin with these two PREFIX lines, copied verbatim, and MUST NOT use \
any class or predicate not listed below -- if you use a class/predicate you \
merely assume exists (from the academic ontology or anywhere else) the \
query will silently return zero rows:
PREFIX t4b: <http://tool4boxology.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

GRAPH SCHEMA (namespace t4b: <http://tool4boxology.org/> -- this is the complete, exhaustive list of classes and predicates; nothing else exists in this graph):
- Classes (as the object of "a"/rdf:type): t4b:Boxology (a whole diagram), \
t4b:DesignPattern (a cluster/group within a diagram), t4b:Component (one \
node -- also typed by its Boxology role: Data, Symbol, Actor, Model, \
Transform, Train, Deduce, Engineer).
- rdfs:label -- human-readable name, available on most Boxology/DesignPattern/
Component individuals.
- t4b:hasPattern (Boxology -> DesignPattern). t4b:hasProcess (DesignPattern -> \
Component, the pattern's own process node). t4b:hasInput / t4b:hasOutput \
(DesignPattern -> Component, the pattern's declared input/output artifacts -- \
these are PATTERN-to-Component, not a direct edge between two Components). \
t4b:inputRoleParticipatesInProcess (Component -> Component: an input \
artifact directly into the process it feeds) / \
t4b:outputRoleParticipatesInProcess (Component -> Component: a process \
directly into the artifact it produces) -- these two ARE the real \
node-to-node data-flow edges; use them, not hasInput/hasOutput, whenever the \
question is about what feeds what between components.

WORKED EXAMPLES (adapt the pattern, don't just repeat these verbatim):
1. "Find all patterns in the VANILLA boxology"
   PREFIX t4b: <http://tool4boxology.org/>
   PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
   SELECT ?pattern ?patternLabel WHERE {
     ?boxology rdfs:label "VANILLA" ;
               t4b:hasPattern ?pattern .
     ?pattern rdfs:label ?patternLabel .
   } LIMIT 100
2. "Find patterns whose output is a Model"
   PREFIX t4b: <http://tool4boxology.org/>
   PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
   SELECT ?pattern ?label ?output WHERE {
     ?pattern t4b:hasOutput ?output ;
              rdfs:label ?label .
     ?output a t4b:Model .
   } LIMIT 100
3. "Find a Kautz Neuro > Symbolic pattern" (a Deduce process taking a neural
   model as one of its two inputs -- t4b:LLM is a real Model sub-type in \
   this graph, unlike t4b:NeuralModel which doesn't exist here)
   PREFIX t4b: <http://tool4boxology.org/>
   PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
   SELECT ?pattern ?label ?input1 ?input2 ?output WHERE {
     ?pattern t4b:hasInput ?input1 , ?input2 ;
              t4b:hasProcess ?deduce ;
              t4b:hasOutput ?output ;
              rdfs:label ?label .
     ?deduce a t4b:Deduce .
     ?input2 a t4b:LLM .
     FILTER(?input1 != ?input2)
   } LIMIT 20
4. "Find elementary patterns that infer a Model from Data and a Model"
   PREFIX t4b: <http://tool4boxology.org/>
   PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
   SELECT ?pattern ?label ?input1 ?input2 ?process ?output WHERE {
     {
       SELECT ?pattern ?label ?input1 ?input2 ?process ?output WHERE {
         ?pattern t4b:hasInput ?input1 , ?input2 ;
                  t4b:hasProcess ?process ;
                  t4b:hasOutput ?output ;
                  rdfs:label ?label .
         FILTER(?input1 != ?input2)
       }
     }
     ?input1  a t4b:Data .
     ?input2  a t4b:Model .
     ?process a t4b:Deduce .
     ?output  a t4b:Model .
   } LIMIT 100

Rules, in priority order:
1. Always write and run a SPARQL query (the run_sparql tool) before \
answering, even for a one-word question -- turn the user's words into a \
real query yourself; never ask the user to phrase it as SPARQL themselves, \
never open with a refusal or an answer from memory alone. Only SELECT and \
ASK are supported -- always end SELECT with LIMIT. For fuzzy text matching, \
use FILTER(CONTAINS(LCASE(?var), "...")) -- SPARQL has NO `LIKE` operator \
(that's SQL, not SPARQL); a query using LIKE will fail to parse every time. \
In a HAVING clause, repeat the full aggregate expression (e.g. \
`HAVING(COUNT(?p) > 3)`) -- this engine does NOT resolve a SELECT alias \
there (`HAVING(?count > 3)` parses fine but silently matches zero rows, no \
error, because the engine never binds the alias inside HAVING).
2. Select real entity URIs, not just their labels, whenever the question is \
about finding/exploring patterns or components rather than a plain count: \
e.g. `SELECT ?pattern ?label` (and any input/process/output URIs involved), \
never a bare `SELECT DISTINCT ?label` with no accompanying entity variable. \
The knowledge-graph panel can only draw a connected diagram from real \
entities -- a label-only projection has no identity to link row to row, so \
it renders as a scatter of disconnected dots even when the underlying \
patterns are genuinely related (and two different patterns can share the \
exact same label text, e.g. a generic phase name like "Rule Generation", so \
a label alone cannot even reliably mean "the same thing" across rows).
3. Use ONLY the t4b: namespace and the exact classes/predicates listed \
above. Never use purl.org, a bare schema.org/foaf/owl vocabulary, or any \
other namespace you recognize from general knowledge -- if unsure whether a \
predicate exists, prefer a generic `?p` with a FILTER over the predicate's \
local name rather than guessing a specific t4b: predicate that isn't listed.
4. Cite every claim by naming the real label(s) your query returned. Never \
invent a label that didn't come back from a query.
5. If a query returns zero rows, don't guess again blindly -- run \
`SELECT DISTINCT ?type WHERE { ?s a ?type } LIMIT 50` once to see the real \
class URIs that actually exist, then retry using exactly one of those. Only \
after that still comes up empty should you say the graph is silent on the \
topic.
6. Narrate the graph path when explaining an answer (e.g. "diagram X -> \
pattern Y -> component Z"), explaining the result naturally in your own \
words -- that live, explainable reasoning is Cartographer's whole point, \
unlike Anvil (fine-tuned, answers from memory with no visibility into why) \
or Scholar (cites papers, not graph structure).
7. Be honest about scope: this graph is about Boxology diagrams and their \
real structure -- not general neuro-symbolic system advice (for that, \
suggest Anvil or Scholar)."""


def _tools() -> list[dict]:
    return [
        llm.tool(
            "run_sparql", "Execute a read-only SPARQL SELECT or ASK query over the Boxology RDF graph.",
            {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        ),
        llm.tool(
            "expand",
            "Show every triple where this URI (from an earlier result) is subject or object -- one more hop.",
            {"type": "object", "properties": {"uri": {"type": "string"}}, "required": ["uri"]},
        ),
    ]


def _fallback_summary(last_result: dict | None) -> str:
    """Resilience rule (blueprint §9.3): never leave the user empty-handed
    when a query already found evidence -- used when the final round
    produces no usable text (a known Gemini quirk: forcing "no more tool
    calls" mid-conversation sometimes yields an empty turn instead of text)."""
    if not last_result or not last_result.get("rows"):
        return "I wasn't able to find any matching results in the graph for this question."
    lines = ["Here is what the last query turned up (the model's final summary "
             "step didn't return text, so these are the raw rows):"]
    for row in last_result["rows"][:10]:
        parts = [f"{var}={binding['value']}" for var, binding in row.items()]
        lines.append("- " + ", ".join(parts))
    return "\n".join(lines)


async def chat(graph: Graph, store: RdfGraph, client: llm.LLMClient, user_message: str,
               history_msgs: list[dict]):
    """Async generator yielding SSE-ready dicts: hop (pre-seed + walk steps),
    query (literal SPARQL text), query_result, text (delta), done, error."""
    # Pre-seed: drives the frontend's live-walk animation stepper (hop
    # stages only) -- Cartographer no longer surfaces the underlying mined
    # rule/grade content to the model; it writes SPARQL cold against the
    # schema in the system prompt.
    pre = hybrid_explore(graph, user_message, top_k=6)
    for hop in pre["hops"]:
        yield {"type": "hop", **hop}

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(llm.history(history_msgs))
    messages.append({"role": "user", "content": user_message})

    last_result: dict | None = None

    for round_idx in range(MAX_TOOL_ROUNDS + 1):
        force_final = round_idx == MAX_TOOL_ROUNDS
        tool_calls = []
        got_text = False
        async for event in client.stream(
            messages, tools=None if force_final else _tools(), temperature=0.2,
        ):
            if event["type"] == "delta":
                got_text = True
                yield {"type": "text", "text": event["text"]}
            elif event["type"] == "tool_calls":
                tool_calls = event["tool_calls"]
            elif event["type"] == "error":
                # Resilience rule: if a query already found evidence but the
                # LLM call itself fails, answer anyway from the raw rows.
                if last_result:
                    yield {"type": "text", "text": _fallback_summary(last_result)}
                    yield {"type": "done"}
                else:
                    yield llm.error_event(event["message"])
                return
            elif event["type"] == "done":
                pass

        if force_final:
            if not got_text:
                yield {"type": "text", "text": _fallback_summary(last_result)}
            yield {"type": "done"}
            return

        if not tool_calls:
            yield {"type": "done"}
            return

        results = []
        for tc in tool_calls:
            try:
                args = json.loads(tc.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            if tc.name == "run_sparql":
                query = args.get("query", "")
                yield {"type": "query", "query": query}
                outcome = sparql_store.run_sparql(store, query)
                if outcome.get("error"):
                    results.append(f"Query error: {outcome['error']}")
                    yield {"type": "query_result", "vars": [], "rows": [], "error": outcome["error"]}
                else:
                    last_result = outcome
                    yield {"type": "query_result", "vars": outcome["vars"], "rows": outcome["rows"]}
                    tool_text = json.dumps(outcome["rows"][:30])
                    if outcome.get("warning"):
                        tool_text = outcome["warning"] + "\n" + tool_text
                    results.append(tool_text)
                yield {"type": "hop", "stage": "done", "count": len(outcome.get("rows", []))}
            elif tc.name == "expand":
                uri = args.get("uri", "")
                outcome = sparql_store.describe_neighbors(store, uri)
                yield {"type": "hop", "stage": "expanded", "node_id": uri}
                results.append(json.dumps(outcome))
            else:
                results.append(f"Unknown tool {tc.name}")

        messages.extend(llm.tool_turn(tool_calls, results))

    yield {"type": "done"}

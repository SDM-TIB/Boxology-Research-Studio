"""In-process SPARQL store for Cartographer (Agent C).

An rdflib graph built once at startup from T4B.nt's real diagram structure
(t4b:Boxology / t4b:DesignPattern / t4b:Component, connected by hasInput /
hasOutput / hasPattern / hasProcess) with the 132 mined typing rules (today's
kg_graph.json.gz) layered on top as t4b:Rule individuals that point back at
the *same* Component URIs via t4b:appliesTo -- one connected graph, not two.
Component ids round-trip exactly between the two sources (confirmed against
pipeline/build_kg_graph.py's slugify()): kg_graph.json.gz's "c:node_X" is
always <http://tool4boxology.org/Component/node_X>.

No external triple store: this graph is ~50k triples, small enough for
rdflib's pure in-process SPARQL engine to query directly -- the sibling
project's architecture (a separate QLever server on its own VM) is sized for
a graph an order of magnitude larger with an existing always-on GCP
deployment; neither applies here, so this stays a single Python process with
no extra infrastructure to run or deploy.

rdflib's query() only implements the SPARQL Query grammar (no SPARQL Update),
so this is read-only by construction, not by a keyword blocklist -- verified
directly: `graph.query("INSERT DATA {...}")` raises ParseException before
touching the graph.
"""

from __future__ import annotations

import gzip
import json
import re

from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF, RDFS

from . import config

T4B = Namespace("http://tool4boxology.org/")

# The only namespaces any triple in this graph actually uses. A query
# referencing anything else (directly, or via a PREFIX declaration) is almost
# certainly a model hallucinating a real-world ontology it recognizes the
# word "Boxology" from (e.g. a published academic purl.org namespace) instead
# of this project's own schema -- see _foreign_namespace()'s caller.
_KNOWN_NAMESPACE_PREFIXES = (
    "http://tool4boxology.org/",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/2001/xmlschema#",
)


def _foreign_namespace(query: str) -> str | None:
    """Best-effort scan for a PREFIX declaration or inline <...> IRI that
    isn't one of this graph's known namespaces."""
    for match in re.finditer(r"PREFIX\s+\w*:\s*<([^>]+)>", query, re.IGNORECASE):
        base = match.group(1).lower()
        if not any(base.startswith(p) for p in _KNOWN_NAMESPACE_PREFIXES):
            return match.group(1)
    for match in re.finditer(r"<(https?://[^\s<>]+)>", query):
        iri = match.group(1)
        if not any(iri.lower().startswith(p) for p in _KNOWN_NAMESPACE_PREFIXES):
            return iri
    return None


def _component_uri(entity_id: str) -> URIRef:
    return T4B[f"Component/{entity_id[2:]}"]  # "c:node_X" -> Component/node_X


def _rule_uri(rule_id: str) -> URIRef:
    return T4B[f"Rule/{rule_id[2:]}"]  # "r:rule_12" -> Rule/rule_12 (minted; T4B.nt has no rules)


def _load_rules_and_entities(g: Graph) -> None:
    """Layer the 132 mined typing rules (kg_graph.json.gz) onto the Component
    URIs T4B.nt already defines."""
    if not config.KG_GRAPH_PATH.exists():
        return
    with gzip.open(config.KG_GRAPH_PATH, "rt", encoding="utf-8") as f:
        data = json.load(f)

    for entity in data["entities"]:
        g.set((_component_uri(entity["id"]), T4B.shaclValid, Literal(entity["shacl_valid"])))

    for rule in data["assertions"]:
        uri = _rule_uri(rule["id"])
        g.add((uri, RDF.type, T4B.Rule))
        g.set((uri, RDFS.label, Literal(f"Rule {rule['rule_number']}")))
        g.set((uri, T4B.body, Literal(rule["body"])))
        g.set((uri, T4B.head, Literal(rule["head"])))
        g.set((uri, T4B.pcaConfidence, Literal(rule["pca_confidence"])))
        g.set((uri, T4B.grade, Literal(rule["grade"])))

    for edge in data["edges"]:
        if edge["role"] != "instance":
            continue  # entity<->entity edges (hasInput/hasOutput/...) are already in T4B.nt itself
        g.add((_rule_uri(edge["from"]), T4B.appliesTo, _component_uri(edge["to"])))


def _overlay_examples(g: Graph) -> None:
    """T4B.nt's own label coverage is partial (some Components only ever got
    a `type` triple). Mirrors app/kg.py's load_graph() overlay -- same source
    files, same nicer labels -- so SPARQL results agree with the rest of the
    app. Also registers each example file as its own queryable t4b:Boxology
    individual (distinct namespace from T4B.nt's own Boxology UUIDs, which
    come from a different/larger source corpus)."""
    if not config.BOXOLOGY_EXAMPLES_DIR.exists():
        return
    for path in config.BOXOLOGY_EXAMPLES_DIR.glob("*.json"):
        try:
            source = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        model_data = source.get("modelData") or {}
        box_id, box_label = model_data.get("boxologyId"), model_data.get("boxologyLabel")
        if box_id and box_label:
            example_uri = T4B[f"Example/{box_id}"]
            g.set((example_uri, RDF.type, T4B.Boxology))
            g.set((example_uri, RDFS.label, Literal(box_label)))
        for node in source.get("nodeDataArray", []):
            key, label = node.get("key"), node.get("label")
            if key and label and not node.get("isGroup"):
                g.set((T4B[f"Component/{key}"], RDFS.label, Literal(label)))


#  Some source diagrams exported these two role-type URIs lowercase
# (t4b:transform / t4b:actor) while every other role (Data, Symbol, Model,
# Train, Deduce, Engineer) and the agent's own system prompt only ever use
# the capitalized form. Left as-is, a query against t4b:Transform --
# the only spelling Cartographer is told about -- silently misses every
# instance that happened to be exported lowercase (confirmed: 107 of 173
# Transform-typed components in T4B.nt are the lowercase variant).
_ROLE_CASING_FIXES = {T4B.transform: T4B.Transform, T4B.actor: T4B.Actor}


def _normalize_role_casing(g: Graph) -> None:
    for wrong, right in _ROLE_CASING_FIXES.items():
        for s in list(g.subjects(RDF.type, wrong)):
            g.remove((s, RDF.type, wrong))
            g.add((s, RDF.type, right))


def build_store() -> Graph:
    g = Graph()
    g.bind("t4b", T4B)
    if config.KG_NT_PATH.exists():
        g.parse(str(config.KG_NT_PATH), format="nt")
    _normalize_role_casing(g)
    _load_rules_and_entities(g)
    _overlay_examples(g)
    return g


def run_sparql(graph: Graph, query: str, row_limit: int = 200) -> dict:
    """Execute a read-only SPARQL SELECT/ASK query. Returns the W3C SPARQL
    1.1 Query Results JSON shape ({"vars": [...], "rows": [{"var": {"type",
    "value"}}]}) via rdflib's own serializer -- no hand-rolled row shaping."""
    query = (query or "").strip()
    if not query:
        return {"error": "Empty query."}
    try:
        result = graph.query(query)
    except Exception as exc:  # rdflib raises several distinct parser/eval exception types
        return {"error": str(exc)}
    if result.type == "ASK":
        return {"vars": [], "rows": [], "boolean": bool(result.askAnswer)}
    if result.type != "SELECT":
        return {"error": f"Only SELECT or ASK queries are supported (got {result.type})."}
    payload = json.loads(result.serialize(format="json"))
    rows = payload["results"]["bindings"][:row_limit]
    out = {"vars": payload["head"]["vars"], "rows": rows}
    if not rows:
        foreign = _foreign_namespace(query)
        if foreign:
            out["warning"] = (
                f"Zero rows, and this query references <{foreign}>, which is not a "
                "namespace used anywhere in this graph. This graph uses ONLY "
                "http://tool4boxology.org/ (t4b:) plus standard rdf:/rdfs: -- not any "
                "published academic Boxology ontology. Rewrite the query using only "
                "t4b: classes/predicates, or run `SELECT DISTINCT ?type WHERE "
                "{ ?s a ?type } LIMIT 50` first to see the real ones."
            )
    return out


def _local_name(uri: URIRef) -> str:
    text = str(uri)
    return text.rsplit("/", 1)[-1].rsplit("#", 1)[-1]


def _classify_uri(uri: str) -> str:
    """Mirrors the frontend's classifyUri() (app.js) so search/entry results
    use the same rule/boxology/pattern/component kind the graph canvas does."""
    if "/Rule/" in uri:
        return "rule"
    if "/Boxology/" in uri or "/Example/" in uri:
        return "boxology"
    if "/DesignPattern/" in uri:
        return "pattern"
    return "component"


def search_entities(graph: Graph, text: str, limit: int = 20) -> list[dict]:
    """Case-insensitive substring match over every rdfs:label literal --
    backs the graph panel's search box. A plain Python scan rather than a
    generated SPARQL CONTAINS query: the store is small enough (~50k triples)
    that this is simpler and has no query-injection surface to worry about."""
    needle = (text or "").strip().lower()
    if not needle:
        return []
    seen: set[str] = set()
    out = []
    for s, label in graph.subject_objects(RDFS.label):
        if not isinstance(s, URIRef):
            continue
        label_text = str(label)
        if needle not in label_text.lower():
            continue
        uri = str(s)
        if uri in seen:
            continue
        seen.add(uri)
        out.append({"id": uri, "label": label_text, "kind": _classify_uri(uri)})
        if len(out) >= limit:
            break
    return out


def class_counts(graph: Graph, limit: int = 12) -> list[dict]:
    """Instance counts per rdf:type -- backs the panel's home/entry view (a
    bubble per top class to start from) instead of an empty canvas."""
    counts: dict[URIRef, int] = {}
    for _s, o in graph.subject_objects(RDF.type):
        counts[o] = counts.get(o, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:limit]
    out = []
    for type_uri, count in ranked:
        label = graph.value(type_uri, RDFS.label)
        out.append({
            "type": str(type_uri),
            "label": str(label) if label else _local_name(type_uri),
            "count": count,
        })
    return out


def resolve_label(graph: Graph, label: str) -> str | None:
    """Find the entity URI whose rdfs:label is `label`.

    A SELECT ?label query (e.g. "list every component name") hands the frontend
    only literal labels, so a clicked node has no URI to expand. This maps a
    label back to its real entity so those nodes become expandable graph
    entities instead of dead-end literals. Exact plain-literal match first,
    then a str() scan to tolerate language/datatype variants.
    """
    label = (label or "").strip()
    if not label:
        return None
    for s in graph.subjects(RDFS.label, Literal(label)):
        if isinstance(s, URIRef):
            return str(s)
    for s, o in graph.subject_objects(RDFS.label):
        if isinstance(s, URIRef) and str(o).strip() == label:
            return str(s)
    return None


def describe_neighbors(graph: Graph, uri: str, limit: int = 15) -> dict:
    """One-hop expansion for a URI already shown in the graph panel -- backs
    the `expand` tool and the editor's node-click detail view.

    Resolves each neighbor's own rdfs:label too (not just the queried node's),
    so the graph panel can show "Fuzzy Rule Base" instead of a raw instance id
    like "group_1761643679506" -- neighbors_by_predicate() already did this;
    this was the one expansion path that didn't, falling back to the URI's
    local name for every neighbor regardless of whether a real label existed."""
    try:
        node = URIRef(uri)
    except Exception:
        return {"error": "Invalid URI."}
    outgoing = []
    for p, o in list(graph.predicate_objects(node))[:limit]:
        entry = {"predicate": str(p), "object": str(o), "object_is_uri": isinstance(o, URIRef)}
        if isinstance(o, URIRef):
            object_label = graph.value(o, RDFS.label)
            if object_label:
                entry["object_label"] = str(object_label)
        outgoing.append(entry)
    incoming = []
    for s, p in list(graph.subject_predicates(node))[:limit]:
        entry = {"subject": str(s), "predicate": str(p)}
        subject_label = graph.value(s, RDFS.label)
        if subject_label:
            entry["subject_label"] = str(subject_label)
        incoming.append(entry)
    if not outgoing and not incoming:
        return {"error": f"No triples found for {uri}"}
    label = graph.value(node, RDFS.label)
    return {
        "uri": str(node), "label": str(label) if label else _local_name(node),
        "outgoing": outgoing, "incoming": incoming,
    }


def neighbor_group_counts(graph: Graph, uri: str) -> dict:
    """Per-predicate/direction neighbor counts for `uri`, unbounded by
    describe_neighbors()'s own limit=15 -- lets the detail panel show an
    accurate "hasInput (12)" total for a hub before fetching any actual
    neighbor rows, per the explorer's grouped-expand UX."""
    try:
        node = URIRef(uri)
    except Exception:
        return {"error": "Invalid URI."}
    groups: dict[tuple[str, str], int] = {}
    for p, o in graph.predicate_objects(node):
        if not isinstance(o, URIRef):
            continue  # literals are properties, not graph neighbors
        groups[(str(p), "out")] = groups.get((str(p), "out"), 0) + 1
    for s, p in graph.subject_predicates(node):
        groups[(str(p), "in")] = groups.get((str(p), "in"), 0) + 1
    out = [
        {"predicate": p, "label": _local_name(URIRef(p)), "direction": d, "count": n}
        for (p, d), n in groups.items()
    ]
    out.sort(key=lambda g: -g["count"])
    return {"uri": str(node), "groups": out}


def neighbors_by_predicate(graph: Graph, uri: str, predicate: str, direction: str,
                            offset: int = 0, limit: int = 25) -> dict:
    """One page of a single predicate/direction's neighbors -- fetched after
    the researcher picks a group from neighbor_group_counts(), so a hub with
    hundreds of neighbors can be paged 25 at a time instead of hitting
    describe_neighbors()'s blanket limit=15 across every predicate at once."""
    if direction not in ("in", "out"):
        return {"error": "direction must be 'in' or 'out'."}
    try:
        node = URIRef(uri)
        pred = URIRef(predicate)
    except Exception:
        return {"error": "Invalid URI or predicate."}
    if direction == "out":
        matches = [o for o in graph.objects(node, pred) if isinstance(o, URIRef)]
    else:
        matches = [s for s in graph.subjects(pred, node) if isinstance(s, URIRef)]
    page = matches[offset:offset + limit]
    items = []
    for entity in page:
        label = graph.value(entity, RDFS.label)
        items.append({
            "id": str(entity), "label": str(label) if label else _local_name(entity),
            "kind": _classify_uri(str(entity)),
        })
    return {"items": items, "total": len(matches), "offset": offset, "limit": limit}

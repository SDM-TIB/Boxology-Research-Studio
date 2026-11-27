"""Cartographer (Agent C) graph load -- reads the artifact pipeline/build_kg_graph.py
produced into plain Python dicts at process start (small enough -- ~1,100
entities, 132 assertions -- that no graph DB is needed, per blueprint §9.1)."""

from __future__ import annotations

import gzip
import json
from collections import defaultdict
from dataclasses import dataclass

from . import config


@dataclass
class Entity:
    id: str
    label: str
    shacl_valid: str  # VALID / INVALID


@dataclass
class Assertion:
    id: str
    rule_number: int
    body: str
    head: str
    pca_confidence: float
    grade: str  # POSITIVE / NEGATIVE
    positive_examples: int | None

    @property
    def text(self) -> str:
        return f"If {self.body}, then {self.head}."


@dataclass
class Edge:
    frm: str
    to: str
    role: str


class Graph:
    def __init__(self, entities: list[Entity], assertions: list[Assertion], edges: list[Edge]):
        self.entities = {e.id: e for e in entities}
        self.assertions = {a.id: a for a in assertions}
        self.edges = edges

        self.out_edges: dict[str, list[Edge]] = defaultdict(list)
        self.in_edges: dict[str, list[Edge]] = defaultdict(list)
        # Edges excluding the rule->entity "instance" family -- used for
        # personalized PageRank propagation, per blueprint §9.2 step 3 (a
        # document/assertion hub touching hundreds of entities shouldn't pull
        # unrelated graph parts artificially close).
        self.propagation_out: dict[str, list[Edge]] = defaultdict(list)
        self.propagation_in: dict[str, list[Edge]] = defaultdict(list)

        for edge in edges:
            self.out_edges[edge.frm].append(edge)
            self.in_edges[edge.to].append(edge)
            if edge.role != "instance":
                self.propagation_out[edge.frm].append(edge)
                self.propagation_in[edge.to].append(edge)

        # How many assertions touch each entity -- used to weight PageRank
        # seeds by inverse specificity (a generic high-degree entity can't
        # drown out a specific one just by raw similarity).
        self.assertion_count_per_entity: dict[str, int] = defaultdict(int)
        for edge in edges:
            if edge.role == "instance":
                self.assertion_count_per_entity[edge.to] += 1

    def node_label(self, node_id: str) -> str:
        if node_id in self.entities:
            return self.entities[node_id].label
        if node_id in self.assertions:
            return self.assertions[node_id].text
        return node_id

    def neighbors(self, node_id: str, limit: int = 15) -> list[dict]:
        out = [{"id": e.to, "role": e.role, "label": self.node_label(e.to)}
               for e in self.out_edges.get(node_id, [])[:limit]]
        inn = [{"id": e.frm, "role": e.role, "label": self.node_label(e.frm)}
               for e in self.in_edges.get(node_id, [])[:limit]]
        return out + inn


def load_graph() -> Graph:
    with gzip.open(config.KG_GRAPH_PATH, "rt", encoding="utf-8") as f:
        data = json.load(f)
    # Recover the human labels from the original Tool4Boxology exports.  The
    # mined KG retained node keys but its first artifact used those keys as
    # labels, which made results look like ``node_176...`` in the UI.
    labels: dict[str, str] = {}
    if config.BOXOLOGY_EXAMPLES_DIR.exists():
        for path in config.BOXOLOGY_EXAMPLES_DIR.glob("*.json"):
            try:
                source = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            for node in source.get("nodeDataArray", []):
                key = node.get("key")
                label = node.get("label")
                if key and label and not node.get("isGroup"):
                    labels[f"c:{key}"] = label
    entities = [Entity(id=e["id"], label=labels.get(e["id"], e["label"]),
                       shacl_valid=e["shacl_valid"])
                for e in data["entities"]]
    assertions = [
        Assertion(id=a["id"], rule_number=a["rule_number"], body=a["body"],
                  head=a["head"], pca_confidence=a["pca_confidence"],
                  grade=a["grade"], positive_examples=a.get("positive_examples"))
        for a in data["assertions"]
    ]
    edges = [Edge(frm=e["from"], to=e["to"], role=e["role"]) for e in data["edges"]]
    return Graph(entities, assertions, edges)

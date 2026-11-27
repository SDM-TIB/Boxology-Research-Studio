#!/usr/bin/env python3
"""Cartographer (Agent C) graph build — turns the already-built T4B knowledge
graph + mined rules + SHACL-tagged instances into the serving artifact Agent C
reasons over.

Deliberately reuses artifacts already produced by NeSy-CoT rather than
re-deriving them:
  - NeSy-CoT/rules/T4B.csv            the 132 mined rules (Body/Head/PCA confidence)
  - NeSy-CoT/CoT/CoT3_T4B/rule_*.txt  each rule's real KG instances, already
                                      tagged [VALID]/[INVALID] from the SHACL
                                      validation report -- do not redo that join
  - NeSy-CoT/KG/T4B/T4B.nt            direct entity-to-entity triples

Node scheme (adapted from blueprint ARCHITECTURE.md section 9.1):
  r:<slug>  assertion -- one of the 132 rules, grade = PCA confidence (POSITIVE/
            NEGATIVE at 0.5) -- this is a per-rule property, constant across
            all of a rule's instances
  c:<slug>  entity -- any distinct entity referenced by a rule's real instances
            (prune anything with no surviving reference)
  No g: source-document tier -- the KG has no separate corpus (that's Scholar's
  job over the Kierner papers, a different corpus entirely).

Usage:
    python pipeline/build_kg_graph.py
"""

import csv
import gzip
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NESY_COT = Path(__file__).parent.parent.parent / "NeSy-CoT"
RULES_CSV = NESY_COT / "rules" / "T4B.csv"
COT3_DIR = NESY_COT / "CoT" / "CoT3_T4B"
KG_NT = NESY_COT / "KG" / "T4B" / "T4B.nt"
OUTPUT = Path(__file__).parent.parent / "app" / "data" / "kg_graph.json.gz"

PCA_THRESHOLD = 0.5
# node_<digits> optionally followed by " n<digits>" (CoT text renders
# "node_X_n2" as "node X n2" -- underscores become spaces, see format_entity()
# in NL-instances-CoT3.py)
ENTITY_RE = re.compile(r"node \d+(?:\s+n\d+)?")
VALIDITY_RE = re.compile(r"\[(VALID|INVALID)\]")
NT_PREDICATES = {
    "type", "label", "hasInput", "hasOutput", "hasPattern", "hasProcess",
    "inputRoleParticipatesInProcess", "outputRoleParticipatesInProcess",
}


def slugify(text: str) -> str:
    return re.sub(r"\s+", "_", text.strip().lower())


def load_rules() -> list[dict]:
    with open(RULES_CSV, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    rules = []
    for i, row in enumerate(rows, start=1):
        pca = float(row["PCA Confidence"])
        rules.append({
            "id": f"r:rule_{i}",
            "rule_number": i,
            "body": row["Body"].strip(),
            "head": row["Head"].strip(),
            "pca_confidence": pca,
            "grade": "POSITIVE" if pca >= PCA_THRESHOLD else "NEGATIVE",
            "positive_examples": int(float(row["Positive Examples"])) if row.get("Positive Examples") else None,
        })
    return rules


def parse_cot3_instances(rule_number: int) -> tuple[set[str], set[str]]:
    """Returns (all entity ids referenced, entity ids appearing on an
    [INVALID]-tagged instance line) for one rule's CoT3 file."""
    path = COT3_DIR / f"rule_{rule_number}.txt"
    if not path.exists():
        return set(), set()
    text = path.read_text(encoding="utf-8")
    match = re.search(
        r"Real Instances from Knowledge Graph.*?:\n\n(.+?)(?=\n\nRule Statistics:)",
        text, re.DOTALL,
    )
    if not match:
        return set(), set()

    entities, invalid_entities = set(), set()
    for line in match.group(1).strip().split("\n"):
        line = line.strip()
        if not line or "No matching instances" in line:
            continue
        found = {slugify(e) for e in ENTITY_RE.findall(line)}
        entities |= found
        validity = VALIDITY_RE.search(line)
        if validity and validity.group(1) == "INVALID":
            invalid_entities |= found
    return entities, invalid_entities


def load_nt_edges(known_entities: set[str]) -> list[dict]:
    """Direct entity-to-entity triples from T4B.nt, restricted to entities
    that already survived (appeared in some rule's real instances) -- keeps
    the graph from including isolated/irrelevant nodes."""
    edges = []
    with open(KG_NT, encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split(" ", 2)
            if len(parts) < 3:
                continue
            subj_uri, pred_uri, obj = parts[0], parts[1], parts[2]
            pred = pred_uri.strip("<>").rsplit("#", 1)[-1].rsplit("/", 1)[-1]
            if pred not in NT_PREDICATES or pred in ("type", "label"):
                continue  # type/label describe the node itself, not an edge between two entities
            subj_id = slugify(subj_uri.strip("<>").rsplit("/", 1)[-1].replace("node_", "node "))
            if subj_id not in known_entities:
                continue
            obj = obj.rstrip(" .\n")
            if obj.startswith("<") and "node_" in obj:
                obj_id = slugify(obj.strip("<>").rsplit("/", 1)[-1].replace("node_", "node "))
                if obj_id in known_entities:
                    edges.append({"from": f"c:{subj_id}", "to": f"c:{obj_id}", "role": pred})
    return edges


def build():
    rules = load_rules()
    print(f"Loaded {len(rules)} rules from {RULES_CSV}")

    all_entities = set()
    invalid_entities = set()
    rule_entity_edges = []
    for rule in rules:
        entities, invalid = parse_cot3_instances(rule["rule_number"])
        all_entities |= entities
        invalid_entities |= invalid
        for entity in entities:
            rule_entity_edges.append({"from": rule["id"], "to": f"c:{entity}", "role": "instance"})

    print(f"Entities referenced across all rule instances: {len(all_entities)}")
    print(f"Entities appearing on at least one [INVALID] line: {len(invalid_entities)}")

    entity_edges = load_nt_edges(all_entities)
    print(f"Direct entity-to-entity edges from T4B.nt: {len(entity_edges)}")

    entities = [
        {"id": f"c:{e}", "label": e.replace("node ", "node_"), "shacl_valid": "INVALID" if e in invalid_entities else "VALID"}
        for e in sorted(all_entities)
    ]
    assertions = sorted(rules, key=lambda r: r["rule_number"])
    edges = sorted(rule_entity_edges, key=lambda e: (e["from"], e["to"])) + \
             sorted(entity_edges, key=lambda e: (e["from"], e["to"]))

    graph = {"entities": entities, "assertions": assertions, "edges": edges}

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUTPUT, "wt", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False)

    print(f"\n{len(entities)} entities, {len(assertions)} assertions, {len(edges)} edges -> {OUTPUT}")
    if len(assertions) != 132:
        print(f"WARNING: expected 132 rules, got {len(assertions)} -- check rules/T4B.csv")


if __name__ == "__main__":
    build()

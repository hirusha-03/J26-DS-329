# -*- coding: utf-8 -*-
import re
import json
import pandas as pd
from pathlib import Path

BASE = Path(r"E:/Research/J26-DS-329/backend/ml/advisory")
MASTER_CSV = BASE / "data" / "queries" / "queries_master.csv"
CHUNKS_JSON = BASE / "index" / "chunks.json"
RETRIEVAL_TEST_CSV = BASE / "outputs" / "retrieval_test.csv"
OUT_DIR = BASE / "experiments" / "embedder_comparison"


OLD_SECTION_RE = re.compile(
    r"section[s]?\s+([0-9]+(?:\.[0-9]+)?(?:\s*,\s*[0-9]+(?:\.[0-9]+)?)*)", re.I
)
SECTION_RE = re.compile(
    r"section[s]?\s+([0-9]+(?:\.[0-9]+){0,2}(?:\s*,\s*[0-9]+(?:\.[0-9]+){0,2})*)", re.I
)

def extract_sections(type_reason: str, pattern=SECTION_RE):
    m = pattern.search(type_reason)
    if not m:
        return []
    return [s.strip() for s in m.group(1).split(",")]

master = pd.read_csv(MASTER_CSV, dtype=str, keep_default_na=False, encoding="utf-8-sig")
chunks = json.load(open(CHUNKS_JSON, "r", encoding="utf-8"))

# section_number -> concatenated text (a section can span multiple chunks)
section_text = {}
for c in chunks:
    sec = c["section_number"]
    section_text.setdefault(sec, "")
    section_text[sec] += " " + c["text"]

answerable = master[master["intended_type"] == "answerable"].copy()
print("answerable rows:", len(answerable))

rows = []
differs = []
for _, row in answerable.iterrows():
    qid = row["query_id"]
    topic = row["topic"]
    q = row["sinhala_query"]
    reason = row["type_reason"]
    secs = extract_sections(reason)

    old_secs = extract_sections(reason, OLD_SECTION_RE)
    if old_secs != secs:
        differs.append((qid, old_secs, secs))

    if not secs:
        rows.append({
            "query_id": qid, "topic": topic, "sinhala_query": q,
            "gold_section": "", "status": "EXCLUDE",
            "reason": "No section number could be parsed from type_reason."
        })
        continue

    missing = [s for s in secs if s not in section_text]
    if missing:
        rows.append({
            "query_id": qid, "topic": topic, "sinhala_query": q,
            "gold_section": ";".join(secs), "status": "EXCLUDE",
            "reason": f"Section(s) not found in chunks.json: {missing}"
        })
        continue

    
    combined_text = " ".join(section_text[s] for s in secs).strip()
    if len(combined_text) < 20:
        rows.append({
            "query_id": qid, "topic": topic, "sinhala_query": q,
            "gold_section": ";".join(secs), "status": "EXCLUDE",
            "reason": "Section text is empty or too short to contain an answer."
        })
        continue

    rows.append({
        "query_id": qid, "topic": topic, "sinhala_query": q,
        "gold_section": ";".join(secs), "status": "OK",
        "reason": ""
    })

has_exclude = any(r["status"] == "EXCLUDE" for r in rows)
if has_exclude:
    out_cols = ["query_id", "topic", "sinhala_query", "gold_section", "status", "reason"]
else:
    # No EXCLUDE rows: omit the reason column entirely rather than writing an
    # all-empty column.
    out_cols = ["query_id", "topic", "sinhala_query", "gold_section", "status"]
    for r in rows:
        r.pop("reason", None)

out_df = pd.DataFrame(rows, columns=out_cols)
out_df.to_csv(OUT_DIR / "gold_sections.csv", index=False, encoding="utf-8-sig")

print("total rows:", len(out_df))
print("OK:", (out_df["status"] == "OK").sum())
print("EXCLUDE:", (out_df["status"] == "EXCLUDE").sum())
exclude_cols = ["query_id", "gold_section", "reason"] if "reason" in out_df.columns else ["query_id", "gold_section"]
print(out_df[out_df["status"] == "EXCLUDE"][exclude_cols].to_string())
print("\nOK rows per topic:")
print(out_df[out_df["status"] == "OK"]["topic"].value_counts())

print(f"\nQueries where old (2-level) vs new (3-level) parsing differ: {len(differs)}")
for qid, old, new in differs:
    print(f"  {qid}: old={old} -> new={new}")

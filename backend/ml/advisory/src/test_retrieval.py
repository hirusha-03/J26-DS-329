"""Run test queries, save Top-3 results to outputs/retrieval_test.csv for manual checking before freezing."""

import re

import pandas as pd

import config
from retrieve import retrieve

SECTION_RE = re.compile(
    r"section[s]?\s+([0-9]+(?:\.[0-9]+)?(?:\s*,\s*[0-9]+(?:\.[0-9]+)?)*)", re.I
)


def extract_sections(type_reason: str):
    m = SECTION_RE.search(type_reason)
    if not m:
        return []
    return [s.strip() for s in m.group(1).split(",")]


def sample_queries(df: pd.DataFrame) -> pd.DataFrame:
    answerable = df[df.intended_type == "answerable"]
    partial = df[df.intended_type == "partial"]
    not_covered = df[df.intended_type == "not_covered"]

    picked_answerable = answerable.groupby("topic", group_keys=False).sample(
        n=1, random_state=42
    )
    if len(picked_answerable) < 12:
        remaining = answerable.drop(picked_answerable.index)
        extra = remaining.sample(n=12 - len(picked_answerable), random_state=42)
        picked_answerable = pd.concat([picked_answerable, extra])
    elif len(picked_answerable) > 12:
        picked_answerable = picked_answerable.sample(n=12, random_state=42)

    picked_partial = partial.sample(n=4, random_state=42)
    picked_not_covered = not_covered.sample(n=4, random_state=42)

    return pd.concat([picked_answerable, picked_partial, picked_not_covered])


def main():
    df = pd.read_csv(config.QUERIES_MASTER_CSV)
    sampled = sample_queries(df)

    rows = []
    for _, row in sampled.iterrows():
        results = retrieve(row["sinhala_query"], config.TOP_K)
        record = {
            "query_id": row["query_id"],
            "sinhala_query": row["sinhala_query"],
            "topic": row["topic"],
            "intended_type": row["intended_type"],
            "type_reason": row["type_reason"],
        }

        top3_sections = []
        for i in range(3):
            if i < len(results):
                r = results[i]
                record[f"rank{i+1}_section_number"] = r["section_number"]
                record[f"rank{i+1}_section_title"] = r["section_title"]
                record[f"rank{i+1}_score"] = r["score"]
                record[f"rank{i+1}_text"] = r["text"]
                top3_sections.append(r["section_number"])
            else:
                record[f"rank{i+1}_section_number"] = ""
                record[f"rank{i+1}_section_title"] = ""
                record[f"rank{i+1}_score"] = ""
                record[f"rank{i+1}_text"] = ""

        if row["intended_type"] == "answerable":
            expected_sections = extract_sections(row["type_reason"])
            merged_sections = set()
            for sec_field in top3_sections:
                merged_sections.update(sec_field.split(";"))
            hit = any(sec in merged_sections for sec in expected_sections)
            record["section_hit"] = hit
        else:
            record["section_hit"] = ""

        rows.append(record)

    out_df = pd.DataFrame(rows)
    config.OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_df.to_csv(config.RETRIEVAL_TEST_CSV, index=False, encoding="utf-8-sig")

    answerable_df = out_df[out_df.intended_type == "answerable"]
    hit_count = answerable_df["section_hit"].sum()
    print(f"section_hit: {hit_count} out of {len(answerable_df)} answerable queries")

    print("\nMean Top-1 score by intended_type:")
    for t in ["answerable", "partial", "not_covered"]:
        sub = out_df[out_df.intended_type == t]
        if len(sub):
            print(f"  {t}: {sub['rank1_score'].mean():.4f}")


if __name__ == "__main__":
    main()

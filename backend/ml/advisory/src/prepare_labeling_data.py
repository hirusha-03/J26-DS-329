"""Run all queries, write passage_1-3 into data/queries/labeling_sheet.csv, save scores separately to outputs/retrieval_scores.csv (scores never go to the labeler)."""

import shutil

import pandas as pd

import config
from retrieve import retrieve

LABELING_SHEET_BACKUP_CSV = config.QUERIES_DIR / "labeling_sheet_backup.csv"
RETRIEVAL_SCORES_CSV = config.OUTPUTS_DIR / "retrieval_scores.csv"


def strip_bullets(text: str) -> str:
    lines = []
    for raw_line in text.split("\n"):
        line = raw_line
        while "•" in line:
            before, _, after = line.partition("•")
            before = before.rstrip()
            after = after.strip()
            if before:
                lines.append(before)
            line = after
        if line:
            lines.append(line)
    return "\n".join(lines)


def main():
    shutil.copyfile(config.LABELING_SHEET_CSV, LABELING_SHEET_BACKUP_CSV)

    sheet_df = pd.read_csv(config.LABELING_SHEET_CSV, encoding="utf-8-sig")
    for col in ["passage_1", "passage_2", "passage_3", "label"]:
        sheet_df[col] = sheet_df[col].astype(object)

    score_rows = []
    for i, row in sheet_df.iterrows():
        results = retrieve(row["sinhala_query"], config.TOP_K)
        score_row = {"query_id": row["query_id"]}
        for rank in range(1, 4):
            if rank <= len(results):
                r = results[rank - 1]
                sheet_df.at[i, f"passage_{rank}"] = strip_bullets(r["text"])
                score_row[f"rank{rank}_chunk_id"] = r["chunk_id"]
                score_row[f"rank{rank}_section_number"] = r["section_number"]
                score_row[f"rank{rank}_score"] = r["score"]
            else:
                sheet_df.at[i, f"passage_{rank}"] = ""
                score_row[f"rank{rank}_chunk_id"] = ""
                score_row[f"rank{rank}_section_number"] = ""
                score_row[f"rank{rank}_score"] = ""
        score_rows.append(score_row)

    sheet_df["label"] = ""
    sheet_df = sheet_df[["query_id", "sinhala_query", "passage_1", "passage_2", "passage_3", "label"]]
    sheet_df.to_csv(config.LABELING_SHEET_CSV, index=False, encoding="utf-8-sig")

    scores_df = pd.DataFrame(score_rows)
    config.OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    scores_df.to_csv(RETRIEVAL_SCORES_CSV, index=False, encoding="utf-8-sig")

    run_checks(sheet_df, scores_df)


def run_checks(sheet_df: pd.DataFrame, scores_df: pd.DataFrame):
    import json

    with open(config.INDEX_CONFIG_JSON_PATH, "r", encoding="utf-8") as f:
        index_config = json.load(f)
    print(f'"frozen": {str(index_config["frozen"]).lower()} in index/config.json -> '
          f'{"PASS" if index_config["frozen"] is True else "FAIL"}')

    print(f"labeling_sheet.csv rows: {len(sheet_df)} -> {'PASS' if len(sheet_df) == 200 else 'FAIL'}")
    print(f"retrieval_scores.csv rows: {len(scores_df)} -> {'PASS' if len(scores_df) == 200 else 'FAIL'}")

    master_df = pd.read_csv(config.QUERIES_MASTER_CSV, encoding="utf-8-sig")
    ids_match = list(sheet_df["query_id"]) == list(master_df["query_id"])
    queries_match = list(sheet_df["sinhala_query"]) == list(master_df["sinhala_query"])
    print(f"query_id identical to queries_master.csv -> {'PASS' if ids_match else 'FAIL'}")
    print(f"sinhala_query identical to queries_master.csv -> {'PASS' if queries_match else 'FAIL'}")

    passage_cols = ["passage_1", "passage_2", "passage_3"]
    empty_passages = sheet_df[passage_cols].isna() | (sheet_df[passage_cols] == "")
    no_empty_passages = not empty_passages.any().any()
    print(f"no empty passage cells -> {'PASS' if no_empty_passages else 'FAIL'}")

    label_empty = sheet_df["label"].isna() | (sheet_df["label"] == "")
    print(f"label column completely empty -> {'PASS' if label_empty.all() else 'FAIL'}")

    with open(config.LABELING_SHEET_CSV, "r", encoding="utf-8-sig") as f:
        csv_text = f.read()

    no_bullets = "•" not in csv_text
    print(f'no "•" characters in labeling_sheet.csv -> {"PASS" if no_bullets else "FAIL"}')

    score_leaked = False
    for col in ["rank1_score", "rank2_score", "rank3_score"]:
        for val in scores_df[col]:
            if val == "" or val is None:
                continue
            if str(val) in csv_text or f"{float(val):.4f}" in csv_text or f"{float(val):.6f}" in csv_text:
                score_leaked = True
                break
        if score_leaked:
            break
    print(f"no score values anywhere in labeling_sheet.csv -> {'PASS' if not score_leaked else 'FAIL'}")


if __name__ == "__main__":
    main()

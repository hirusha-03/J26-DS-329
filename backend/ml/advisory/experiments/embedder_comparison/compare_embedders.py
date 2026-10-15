# -*- coding: utf-8 -*-
"""Cross-lingual embedder comparison for retriever selection.

Read-only w.r.t. index/, data/, outputs/, src/ and all frozen retrieval
settings. All models' FAISS indexes are built in-memory only (never saved
under index/). Uses gold_sections.csv (status == OK rows) as ground truth,
and matches retrieved chunk section_numbers to gold sections using the same
rule as src/test_retrieval.py (exact section_number string match).

Run: python experiments/embedder_comparison/compare_embedders.py
"""
import json
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
import faiss
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from sentence_transformers import SentenceTransformer
from sklearn.model_selection import train_test_split

BASE = Path(r"E:/Research/J26-DS-329/backend/ml/advisory")
CHUNKS_JSON = BASE / "index" / "chunks.json"
GOLD_CSV = BASE / "experiments" / "embedder_comparison" / "gold_sections.csv"
OUT_DIR = BASE / "experiments" / "embedder_comparison"
TOP_K = 3
SEED = 42
N_BOOT = 1000

MODELS = {
    "bge-m3": {
        "name": "BAAI/bge-m3",
        "max_seq_length": 512,
        "query_prefix": "",
        "passage_prefix": "",
    },
    "multilingual-e5-large": {
        "name": "intfloat/multilingual-e5-large",
        "max_seq_length": None,
        "query_prefix": "query: ",
        "passage_prefix": "passage: ",
    },
    "LaBSE": {
        "name": "sentence-transformers/LaBSE",
        "max_seq_length": None,
        "query_prefix": "",
        "passage_prefix": "",
    },
    "paraphrase-multilingual-MiniLM-L12-v2": {
        "name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        "max_seq_length": None,
        "query_prefix": "",
        "passage_prefix": "",
    },
}


def load_chunks():
    with open(CHUNKS_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def load_gold():
    df = pd.read_csv(GOLD_CSV, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    ok = df[df["status"] == "OK"].copy()
    print(f"gold_sections.csv OK rows used: {len(ok)}")
    ok["gold_section_list"] = ok["gold_section"].apply(lambda s: [x.strip() for x in s.split(";") if x.strip()])
    return ok.reset_index(drop=True)


def build_model_index(model_key, cfg, chunks):
    model = SentenceTransformer(cfg["name"])
    if cfg["max_seq_length"] is not None:
        model.max_seq_length = cfg["max_seq_length"]

    passages = [cfg["passage_prefix"] + c["text"] for c in chunks]
    chunk_sections = [c["section_number"] for c in chunks]

    emb = model.encode(passages, normalize_embeddings=True, show_progress_bar=False)
    emb = np.asarray(emb, dtype="float32")

    index = faiss.IndexFlatIP(emb.shape[1])
    index.add(emb)
    return model, index, chunk_sections


def retrieve_top3(model, index, chunk_sections, query, cfg):
    q = cfg["query_prefix"] + query
    t0 = time.perf_counter()
    emb = model.encode([q], normalize_embeddings=True, show_progress_bar=False)
    dt = time.perf_counter() - t0
    emb = np.asarray(emb, dtype="float32")
    scores, idxs = index.search(emb, TOP_K)
    sections = []
    for idx in idxs[0]:
        if idx < 0:
            continue
        sections.append(chunk_sections[idx])
    return sections, dt


def eval_query(top3_sections, gold_list):
    gold_set = set(gold_list)
    top3_set = set(top3_sections)
    found = gold_set & top3_set
    recall = len(found) / len(gold_set) if gold_set else 0.0
    hit3 = 1 if found else 0
    hit1 = 1 if top3_sections and top3_sections[0] in gold_set else 0
    mrr = 0.0
    for rank, sec in enumerate(top3_sections, start=1):
        if sec in gold_set:
            mrr = 1.0 / rank
            break
    full_recall = 1 if gold_set and gold_set.issubset(top3_set) else 0
    return recall, hit3, hit1, mrr, full_recall


def bootstrap_ci(values, n_boot=N_BOOT, seed=SEED):
    rng = np.random.RandomState(seed)
    values = np.asarray(values, dtype=float)
    n = len(values)
    boot_means = np.empty(n_boot)
    for i in range(n_boot):
        sample = rng.choice(values, size=n, replace=True)
        boot_means[i] = sample.mean()
    lo, hi = np.percentile(boot_means, [2.5, 97.5])
    return lo, hi


def mcnemar_test(a_correct, b_correct):
    """Paired McNemar test (binary full-recall indicator), exact binomial version
    for small discordant counts, normal approx otherwise."""
    a = np.asarray(a_correct)
    b = np.asarray(b_correct)
    n01 = int(((a == 0) & (b == 1)).sum())  # b right, a wrong
    n10 = int(((a == 1) & (b == 0)).sum())  # a right, b wrong
    n = n01 + n10
    if n == 0:
        return float("nan"), 1.0, n01, n10
    from scipy import stats
    if n < 25:
        # exact binomial two-sided test
        p = stats.binomtest(min(n01, n10), n, 0.5, alternative="two-sided").pvalue
        chi2 = float("nan")
    else:
        chi2 = (abs(n01 - n10) - 1) ** 2 / n
        p = 1 - stats.chi2.cdf(chi2, df=1)
    return chi2, p, n01, n10


def main():
    chunks = load_chunks()
    gold = load_gold()

    train_idx, test_idx = train_test_split(
        gold.index, test_size=0.5, random_state=SEED, stratify=gold["topic"]
    )
    gold["split"] = ""
    gold.loc[train_idx, "split"] = "selection"
    gold.loc[test_idx, "split"] = "confirmation"
    print(f"selection rows: {len(train_idx)}, confirmation rows: {len(test_idx)}")

    per_query_rows = {qid: {"query_id": qid, "topic": row["topic"], "gold_section": row["gold_section"], "split": row["split"]}
                       for qid, row in zip(gold["query_id"], gold.to_dict("records"))}

    results = []  # per model per query dicts
    enc_times = {}

    for model_key, cfg in MODELS.items():
        print(f"\n=== {model_key} ({cfg['name']}) ===")
        model, index, chunk_sections = build_model_index(model_key, cfg, chunks)

        times = []
        for _, row in gold.iterrows():
            qid = row["query_id"]
            top3, dt = retrieve_top3(model, index, chunk_sections, row["sinhala_query"], cfg)
            times.append(dt)
            recall, hit3, hit1, mrr, full_recall = eval_query(top3, row["gold_section_list"])
            results.append({
                "model": model_key, "query_id": qid, "topic": row["topic"], "split": row["split"],
                "gold_section": row["gold_section"], "top3_sections": ";".join(top3),
                "recall_at3": recall, "hit_at3": hit3, "hit_at1": hit1, "mrr_at3": mrr,
                "full_recall": full_recall,
            })
            per_query_rows[qid][f"{model_key}_top3"] = ";".join(top3)
            per_query_rows[qid][f"{model_key}_recall_at3"] = recall

        enc_times[model_key] = float(np.mean(times))
        del model, index
        import gc
        gc.collect()

    res_df = pd.DataFrame(results)

    # ---- results_summary.csv: one row per model per split ----
    summary_rows = []
    for model_key in MODELS:
        for split_name in ["selection", "confirmation", "all"]:
            if split_name == "all":
                sub = res_df[res_df["model"] == model_key]
            else:
                sub = res_df[(res_df["model"] == model_key) & (res_df["split"] == split_name)]
            recall_vals = sub["recall_at3"].values
            lo, hi = bootstrap_ci(recall_vals)
            summary_rows.append({
                "model": model_key,
                "split": split_name,
                "n_queries": len(sub),
                "recall_at3_mean": sub["recall_at3"].mean(),
                "recall_at3_ci_lo": lo,
                "recall_at3_ci_hi": hi,
                "hit_at3": sub["hit_at3"].mean(),
                "hit_at1": sub["hit_at1"].mean(),
                "mrr_at3": sub["mrr_at3"].mean(),
                "avg_encode_time_sec": enc_times[model_key],
            })
    summary_df = pd.DataFrame(summary_rows)
    summary_df = summary_df.astype(str)
    summary_df.to_csv(OUT_DIR / "results_summary.csv", index=False, encoding="utf-8-sig")

    # ---- McNemar: BGE-M3 vs each other model, per split and all ----
    mcnemar_rows = []
    for split_name in ["selection", "confirmation", "all"]:
        if split_name == "all":
            base = res_df[res_df["model"] == "bge-m3"].set_index("query_id")
        else:
            base = res_df[(res_df["model"] == "bge-m3") & (res_df["split"] == split_name)].set_index("query_id")
        for model_key in MODELS:
            if model_key == "bge-m3":
                continue
            if split_name == "all":
                other = res_df[res_df["model"] == model_key].set_index("query_id")
            else:
                other = res_df[(res_df["model"] == model_key) & (res_df["split"] == split_name)].set_index("query_id")
            common = base.index.intersection(other.index)
            a = base.loc[common, "full_recall"].values
            b = other.loc[common, "full_recall"].values
            chi2, p, n01, n10 = mcnemar_test(a, b)
            mcnemar_rows.append({
                "split": split_name, "model_a": "bge-m3", "model_b": model_key,
                "n_a_right_b_wrong": n10, "n_b_right_a_wrong": n01,
                "statistic": chi2, "p_value": p,
            })
    mcnemar_df = pd.DataFrame(mcnemar_rows).astype(str)
    mcnemar_df.to_csv(OUT_DIR / "mcnemar_results.csv", index=False, encoding="utf-8-sig")

    # ---- per_query_results.csv ----
    per_query_df = pd.DataFrame(list(per_query_rows.values()))
    cols = ["query_id", "topic", "split", "gold_section"]
    for model_key in MODELS:
        cols += [f"{model_key}_top3", f"{model_key}_recall_at3"]
    per_query_df = per_query_df[cols].astype(str)
    per_query_df.to_csv(OUT_DIR / "per_query_results.csv", index=False, encoding="utf-8-sig")

    # ---- recall_at3_by_model.png ----
    all_summary = summary_df[summary_df["split"] == "all"].copy()
    all_summary["recall_at3_mean"] = all_summary["recall_at3_mean"].astype(float)
    all_summary["recall_at3_ci_lo"] = all_summary["recall_at3_ci_lo"].astype(float)
    all_summary["recall_at3_ci_hi"] = all_summary["recall_at3_ci_hi"].astype(float)
    means = all_summary["recall_at3_mean"].values
    lo_err = means - all_summary["recall_at3_ci_lo"].values
    hi_err = all_summary["recall_at3_ci_hi"].values - means

    fig, ax = plt.subplots(figsize=(8, 5))
    x = np.arange(len(all_summary))
    ax.bar(x, means, yerr=[lo_err, hi_err], capsize=5, color="#4C72B0")
    ax.set_xticks(x)
    ax.set_xticklabels(all_summary["model"].tolist(), rotation=20, ha="right")
    ax.set_ylabel("Recall@3")
    ax.set_title("Recall@3 by embedding model (all 160 OK queries, 95% bootstrap CI)")
    ax.set_ylim(0, 1)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "recall_at3_by_model.png", dpi=150)
    plt.close(fig)

    # ---- print summary table ----
    print("\n=== results_summary ===")
    print(summary_df.to_string(index=False))

    print("\n=== McNemar (BGE-M3 vs others, full-recall indicator) ===")
    print(mcnemar_df.to_string(index=False))

    print("\n=== Recall@3 per topic per model (all queries) ===")
    topic_table = res_df.pivot_table(index="topic", columns="model", values="recall_at3", aggfunc="mean")
    print(topic_table.to_string())

    # ---- selection vs confirmation best-model check ----
    sel_summary = summary_df[summary_df["split"] == "selection"].copy()
    sel_summary["recall_at3_mean"] = sel_summary["recall_at3_mean"].astype(float)
    best_on_selection = sel_summary.loc[sel_summary["recall_at3_mean"].idxmax(), "model"]

    conf_summary = summary_df[summary_df["split"] == "confirmation"].copy()
    conf_summary["recall_at3_mean"] = conf_summary["recall_at3_mean"].astype(float)
    best_on_confirmation = conf_summary.loc[conf_summary["recall_at3_mean"].idxmax(), "model"]

    print(f"\nBest model on SELECTION half: {best_on_selection}")
    print(f"Best model on CONFIRMATION half: {best_on_confirmation}")
    print(f"Also best on confirmation: {best_on_selection == best_on_confirmation}")

    return summary_df, mcnemar_df, res_df, best_on_selection, best_on_confirmation


if __name__ == "__main__":
    main()

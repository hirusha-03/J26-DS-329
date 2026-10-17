"""Behavioral analysis of the M3+Q sufficiency model: evidence-removal and
counterfactual perturbation tests, plus an error-analysis breakdown. Uses
ONLY the cached BGE-M3 vectors in outputs/cache/ (no model loading, no
downloads). Reuses the Block-Q helper functions from src/features.py.
Outputs go to outputs/analysis/; nothing under data/, the index, features.csv,
the saved model, or outputs/results/ is modified."""

import json
import pickle
import sys

import joblib
import matplotlib
import numpy as np
import pandas as pd
from scipy.stats import wilcoxon

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import config
from features import classify_qword, has_number, is_yes_no_query
from train_eval import make_lr_pipeline

ANALYSIS_DIR = config.OUTPUTS_DIR / "analysis"
CACHE_DIR = config.OUTPUTS_DIR / "cache"
MODELS_DIR = config.OUTPUTS_DIR / "models"
RESULTS_DIR = config.OUTPUTS_DIR / "results"
FEATURES_CSV = config.OUTPUTS_DIR / "features.csv"
RETRIEVAL_SCORES_CSV = config.OUTPUTS_DIR / "retrieval_scores.csv"
GOLD_SECTIONS_CSV = config.BASE_DIR / "experiments" / "embedder_comparison" / "gold_sections.csv"
LABEL_RATIONALE_CSV = config.DATA_DIR / "labels" / "label_rationale.csv"
LABELS_CSV = config.DATA_DIR / "labels" / "labeling_sheet_labeled.csv"

SEED = 42


def rd_csv(path, **kw):
    return pd.read_csv(path, dtype=str, keep_default_na=False, **kw)


# --------------------------------------------------------------------------
# Cache / chunk loading (no model)
# --------------------------------------------------------------------------
def load_cache():
    data = {"query_dense": np.load(CACHE_DIR / "query_dense.npy"),
            "chunk_dense": np.load(CACHE_DIR / "chunk_dense.npy")}
    with open(CACHE_DIR / "query_tok_vecs.pkl", "rb") as f:
        data["query_tok_vecs"] = pickle.load(f)
    with open(CACHE_DIR / "query_sparse.pkl", "rb") as f:
        data["query_sparse"] = pickle.load(f)
    with open(CACHE_DIR / "chunk_tok_vecs.pkl", "rb") as f:
        data["chunk_tok_vecs"] = pickle.load(f)
    return data


def load_chunks():
    chunks = json.load(open(config.CHUNKS_JSON_PATH, encoding="utf-8"))
    chunk_id_to_idx = {c["chunk_id"]: i for i, c in enumerate(chunks)}
    chunk_section = {c["chunk_id"]: c["section_number"] for c in chunks}
    chunk_ids_ordered = [c["chunk_id"] for c in chunks]
    return chunks, chunk_id_to_idx, chunk_section, chunk_ids_ordered


# --------------------------------------------------------------------------
# Feature computation for an arbitrary Top-3 (mirrors src/features.py's
# per-query block exactly; only the Block-Q classification helpers are
# imported rather than reimplemented, since features.py does not factor the
# numeric A/T/S/R block into a standalone function).
# --------------------------------------------------------------------------
def compute_features(qidx, text, passage_cids, cache, chunks, chunk_id_to_idx, chunk_section,
                      precomputed_scores=None):
    """precomputed_scores: optional {chunk_id: score} for chunks that are part
    of a query's ORIGINAL stored Top-3 (from retrieval_scores.csv) -- Block A
    uses the stored FAISS score there (matching features.py exactly) rather
    than recomputing via the cache, which differs at the ~1e-7 level due to
    float32 precision and would occasionally cross a 6-decimal rounding
    boundary. For any chunk not in precomputed_scores (e.g. a perturbed
    Top-3 in Tests A/B), the score is computed from the cached dense vectors."""
    passage_idx = [chunk_id_to_idx[c] for c in passage_cids]

    s = []
    for cid, cidx in zip(passage_cids, passage_idx):
        if precomputed_scores is not None and cid in precomputed_scores:
            s.append(precomputed_scores[cid])
        else:
            s.append(float(cache["query_dense"][qidx] @ cache["chunk_dense"][cidx]))
    s1, s2, s3 = s
    s_mean = (s1 + s2 + s3) / 3.0
    s_std = float(np.std([s1, s2, s3]))
    gap12, gap13, gap23 = s1 - s2, s1 - s3, s2 - s3

    q_vecs = cache["query_tok_vecs"][qidx]
    q_weights = np.asarray(cache["query_sparse"][qidx], dtype="float64")
    n_tok = q_vecs.shape[0]

    if n_tok == 0:
        a_per_passage = np.zeros((0, 3), dtype="float64")
    else:
        a_per_passage = np.zeros((n_tok, 3), dtype="float64")
        for p, cidx in enumerate(passage_idx):
            c_vecs = cache["chunk_tok_vecs"][cidx]
            if c_vecs.shape[0] == 0:
                a_per_passage[:, p] = 0.0
                continue
            sims = q_vecs @ c_vecs.T
            a_per_passage[:, p] = sims.max(axis=1)

    a_i = a_per_passage.max(axis=1) if n_tok > 0 else np.array([0.0])

    if n_tok > 0:
        C_mean = float(a_i.mean())
        C_min = float(a_i.min())
        C_p25 = float(np.percentile(a_i, 25))
        per_passage_mean = a_per_passage.mean(axis=0)
        C_single = float(per_passage_mean.max())
        C_rank1 = float(a_per_passage[:, 0].mean())
    else:
        C_mean = C_min = C_p25 = C_single = C_rank1 = 0.0

    delta_C = C_mean - C_single

    if n_tok > 0 and q_weights.sum() > 0:
        C_weighted = float((q_weights * a_i).sum() / q_weights.sum())
    else:
        C_weighted = C_mean

    if n_tok > 0:
        median_w = np.median(q_weights)
        top_half_mask = q_weights >= median_w
        C_weighted_min = float(a_i[top_half_mask].min()) if top_half_mask.any() else C_min
    else:
        C_weighted_min = 0.0

    q_n_tokens = n_tok
    has_num = has_number(text)
    qword = classify_qword(text)
    yes_no = is_yes_no_query(text, qword)

    sections = [chunk_section[c] for c in passage_cids]
    n_unique_sections = len(set(sections))
    top_section_same_12 = 1 if sections[0] == sections[1] else 0
    words_p = [len(chunks[chunk_id_to_idx[c]]["text"].split()) for c in passage_cids]
    words_total = sum(words_p)

    return {
        "s1": s1, "s2": s2, "s3": s3, "s_mean": s_mean, "s_std": s_std,
        "gap12": gap12, "gap13": gap13, "gap23": gap23,
        "C_mean": C_mean, "C_min": C_min, "C_p25": C_p25,
        "C_single": C_single, "delta_C": delta_C, "C_rank1": C_rank1,
        "C_weighted": C_weighted, "C_weighted_min": C_weighted_min,
        "q_n_tokens": q_n_tokens, "has_number": has_num, "qword": qword, "is_yes_no": yes_no,
        "n_unique_sections": n_unique_sections, "top_section_same_12": top_section_same_12,
        "words_p1": words_p[0], "words_p2": words_p[1], "words_p3": words_p[2], "words_total": words_total,
    }


# --------------------------------------------------------------------------
# Step 0: sanity check
# --------------------------------------------------------------------------
def sanity_check(queries_df, scores_df, cache, chunks, chunk_id_to_idx, chunk_section):
    features_csv = rd_csv(FEATURES_CSV)
    float_cols = [
        "s1", "s2", "s3", "s_mean", "s_std", "gap12", "gap13", "gap23",
        "C_mean", "C_min", "C_p25", "C_single", "delta_C", "C_rank1", "C_weighted", "C_weighted_min",
    ]
    n_mismatch = 0
    for i, qid in enumerate(queries_df["query_id"]):
        text = queries_df.iloc[i]["sinhala_query"]
        sc_row = scores_df[scores_df["query_id"] == qid].iloc[0]
        passage_cids = [sc_row["rank1_chunk_id"], sc_row["rank2_chunk_id"], sc_row["rank3_chunk_id"]]
        precomputed_scores = {
            sc_row["rank1_chunk_id"]: float(sc_row["rank1_score"]),
            sc_row["rank2_chunk_id"]: float(sc_row["rank2_score"]),
            sc_row["rank3_chunk_id"]: float(sc_row["rank3_score"]),
        }
        recomputed = compute_features(i, text, passage_cids, cache, chunks, chunk_id_to_idx, chunk_section,
                                       precomputed_scores=precomputed_scores)
        expected = features_csv[features_csv["query_id"] == qid].iloc[0]
        for c in float_cols:
            if round(recomputed[c], 6) != round(float(expected[c]), 6):
                n_mismatch += 1
                break
    passed = n_mismatch == 0
    print(f"STEP 0 SANITY CHECK: {'PASS' if passed else 'FAIL'} ({n_mismatch} / {len(queries_df)} queries mismatched)")
    return passed


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------
def load_model_and_card():
    model = joblib.load(MODELS_DIR / "sufficiency_lr_m3q.joblib")
    with open(MODELS_DIR / "model_card.json", "r", encoding="utf-8") as f:
        card = json.load(f)
    return model, card["feature_list"], card["decision_threshold"]


def load_fold_assignments():
    return pd.read_csv(RESULTS_DIR / "fold_assignments.csv", dtype={"query_id": str})


def compute_oof_predictions(df_with_label, cols, perturbed_feats_by_name):
    """Refit M3+Q LR on each of the 50 train_eval.py folds (same
    fold_assignments.csv, same random_state=42) and predict, for each test-fold
    query, both its ORIGINAL features and any perturbed feature dicts supplied
    in perturbed_feats_by_name ({name: {query_id: feat_dict}}). Each query
    appears in exactly one fold per repeat (10 repeats), so its final P is the
    mean of up to 10 out-of-fold predictions -- never a prediction from a
    model that saw that query during training.

    Returns {name: {query_id: [prob, ...]}} including "original"."""
    fold_df = load_fold_assignments()

    acc = {"original": {qid: [] for qid in df_with_label["query_id"]}}
    for name, lookup in perturbed_feats_by_name.items():
        acc[name] = {qid: [] for qid in lookup}

    for (_, _), group in fold_df.groupby(["repeat", "fold"]):
        test_ids = set(group["query_id"])
        train_df = df_with_label[~df_with_label["query_id"].isin(test_ids)]
        test_df = df_with_label[df_with_label["query_id"].isin(test_ids)]

        pipe = make_lr_pipeline(cols)
        pipe.fit(train_df[cols], train_df["label"].values)

        proba_orig = pipe.predict_proba(test_df[cols])[:, 1]
        for qid, p in zip(test_df["query_id"], proba_orig):
            acc["original"][qid].append(float(p))

        for name, lookup in perturbed_feats_by_name.items():
            sub_qids = [qid for qid in test_df["query_id"] if qid in lookup]
            if not sub_qids:
                continue
            feat_rows = [lookup[qid] for qid in sub_qids]
            proba = pipe.predict_proba(pd.DataFrame(feat_rows)[cols])[:, 1]
            for qid, p in zip(sub_qids, proba):
                acc[name][qid].append(float(p))

    return acc


def mean_of(acc_dict, qid):
    vals = acc_dict[qid]
    return float(np.mean(vals)) if vals else float("nan")


# --------------------------------------------------------------------------
# Test A: evidence removal
# --------------------------------------------------------------------------
def run_test_a(queries_df, scores_df, cache, chunks, chunk_id_to_idx, chunk_section,
                chunk_ids_ordered, features_df, df_with_label, cols, threshold):
    gold_df = rd_csv(GOLD_SECTIONS_CSV)
    assert len(gold_df) == 160, f"expected 160 answerable queries, got {len(gold_df)}"

    print(
        "\nMatching rule: a query qualifies if any of its original Top-3 chunks has "
        "section_number == gold_section (exact string equality)."
    )

    qidx_of = {qid: i for i, qid in enumerate(queries_df["query_id"])}
    feat_before_lookup = features_df.set_index("query_id")

    # Phase 1: build the perturbed ("after") feature dict per qualifying query.
    after_feats = {}
    qual_rows = []
    for _, g in gold_df.iterrows():
        qid = g["query_id"]
        gold_section = g["gold_section"]
        i = qidx_of[qid]
        text = queries_df.iloc[i]["sinhala_query"]
        sc_row = scores_df[scores_df["query_id"] == qid].iloc[0]
        orig_top3 = [sc_row["rank1_chunk_id"], sc_row["rank2_chunk_id"], sc_row["rank3_chunk_id"]]

        has_gold = any(chunk_section[c] == gold_section for c in orig_top3)
        if not has_gold:
            continue

        kept = [c for c in orig_top3 if chunk_section[c] != gold_section]
        scores_all = cache["query_dense"][i] @ cache["chunk_dense"].T
        order_desc = np.argsort(-scores_all)
        fillers = []
        for j in order_desc:
            cid = chunk_ids_ordered[j]
            if chunk_section[cid] == gold_section or cid in kept or cid in orig_top3:
                continue
            fillers.append(cid)
            if len(kept) + len(fillers) >= 3:
                break
        new_top3 = kept + fillers
        new_top3 = sorted(new_top3, key=lambda c: -scores_all[chunk_id_to_idx[c]])

        feat_after = compute_features(i, text, new_top3, cache, chunks, chunk_id_to_idx, chunk_section)
        after_feats[qid] = feat_after
        qual_rows.append({"query_id": qid, "gold_section": gold_section,
                           "orig_top3": ",".join(orig_top3), "new_top3": ",".join(new_top3),
                           "feat_after": feat_after})

    # Phase 2: refit M3+Q LR on each of the 50 folds; predict "original" and
    # "after" for each test-fold query; average over the 10 repeats.
    oof = compute_oof_predictions(df_with_label, cols, {"A_after": after_feats})

    rows = []
    for qr in qual_rows:
        qid = qr["query_id"]
        feat_after = qr["feat_after"]
        before_row = feat_before_lookup.loc[qid]
        p_before = mean_of(oof["original"], qid)
        p_after = mean_of(oof["A_after"], qid)

        rows.append(
            {
                "query_id": qid,
                "gold_section": qr["gold_section"],
                "orig_top3": qr["orig_top3"],
                "new_top3": qr["new_top3"],
                "P_before": p_before,
                "P_after": p_after,
                "delta_P": p_after - p_before,
                "suff_before": int(p_before >= threshold),
                "suff_after": int(p_after >= threshold),
                "s1_before": float(before_row["s1"]), "s1_after": feat_after["s1"],
                "s_mean_before": float(before_row["s_mean"]), "s_mean_after": feat_after["s_mean"],
                "C_mean_before": float(before_row["C_mean"]), "C_mean_after": feat_after["C_mean"],
                "C_min_before": float(before_row["C_min"]), "C_min_after": feat_after["C_min"],
                "C_p25_before": float(before_row["C_p25"]), "C_p25_after": feat_after["C_p25"],
                "C_weighted_before": float(before_row["C_weighted"]), "C_weighted_after": feat_after["C_weighted"],
            }
        )

    df = pd.DataFrame(rows)
    print(f"{len(df)} / 160 answerable queries have a gold-section chunk in their Top-3 and qualify for Test A.")

    stat, p_value = wilcoxon(df["P_before"], df["P_after"])

    z_rows = []
    for feat in ["s1", "s_mean", "C_mean", "C_weighted", "C_p25", "C_min"]:
        std = features_df[feat].astype(float).std()
        z_change = (df[f"{feat}_after"] - df[f"{feat}_before"]) / std
        z_rows.append({"feature": feat, "mean_z_change": z_change.mean(), "std_z_change": z_change.std()})
    z_df = pd.DataFrame(z_rows)

    summary = {
        "n": len(df),
        "mean_P_before": df["P_before"].mean(),
        "mean_P_after": df["P_after"].mean(),
        "mean_delta_P": df["delta_P"].mean(),
        "pct_decreased": float((df["delta_P"] < 0).mean() * 100),
        "wilcoxon_p": p_value,
        "pct_suff_before": float(df["suff_before"].mean() * 100),
        "pct_suff_after": float(df["suff_after"].mean() * 100),
    }
    for _, zr in z_df.iterrows():
        summary[f"mean_z_change_{zr['feature']}"] = zr["mean_z_change"]
        summary[f"std_z_change_{zr['feature']}"] = zr["std_z_change"]
    summary_df = pd.DataFrame([summary])

    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(ANALYSIS_DIR / "evidence_removal.csv", index=False, encoding="utf-8-sig")
    summary_df.to_csv(ANALYSIS_DIR / "evidence_removal_summary.csv", index=False, encoding="utf-8-sig")

    plt.figure(figsize=(6, 6))
    plt.scatter(df["P_before"], df["P_after"], alpha=0.6, s=20)
    lims = [0, 1]
    plt.plot(lims, lims, "k--", linewidth=1)
    plt.xlabel("P(sufficient) before evidence removal")
    plt.ylabel("P(sufficient) after evidence removal")
    plt.title("Evidence Removal: P before vs after")
    plt.xlim(lims); plt.ylim(lims)
    plt.tight_layout()
    plt.savefig(ANALYSIS_DIR / "evidence_removal.png", dpi=150)
    plt.close()

    return df, summary_df


# --------------------------------------------------------------------------
# Test B: counterfactual evidence
# --------------------------------------------------------------------------
def run_test_b(queries_df, meta_df, scores_df, cache, chunks, chunk_id_to_idx, chunk_section,
                chunk_ids_ordered, features_df, df_with_label, cols, threshold):
    topic_of = dict(zip(meta_df["query_id"], meta_df["topic"]))
    qids = list(queries_df["query_id"])

    rng = np.random.default_rng(SEED)
    swap_partner = {}
    for qid in qids:
        own_topic = topic_of[qid]
        candidates = [q2 for q2 in qids if topic_of[q2] != own_topic]
        swap_partner[qid] = candidates[rng.integers(0, len(candidates))]

    # Phase 1: build B1 (topic swap) and B2 (own ranks 4-6) feature dicts for
    # every query.
    b1_feats, b2_feats, partner_of = {}, {}, {}
    for i, qid in enumerate(qids):
        text = queries_df.iloc[i]["sinhala_query"]

        partner_qid = swap_partner[qid]
        partner_of[qid] = partner_qid
        partner_sc = scores_df[scores_df["query_id"] == partner_qid].iloc[0]
        b1_top3 = [partner_sc["rank1_chunk_id"], partner_sc["rank2_chunk_id"], partner_sc["rank3_chunk_id"]]
        b1_feats[qid] = compute_features(i, text, b1_top3, cache, chunks, chunk_id_to_idx, chunk_section)

        scores_all = cache["query_dense"][i] @ cache["chunk_dense"].T
        order_desc = np.argsort(-scores_all)
        b2_top3 = [chunk_ids_ordered[j] for j in order_desc[3:6]]
        b2_feats[qid] = compute_features(i, text, b2_top3, cache, chunks, chunk_id_to_idx, chunk_section)

    # Phase 2: refit M3+Q LR on each of the 50 folds; predict "original", B1
    # and B2 for each test-fold query; average over the 10 repeats.
    oof = compute_oof_predictions(df_with_label, cols, {"B1": b1_feats, "B2": b2_feats})

    rows = []
    for qid in qids:
        p_before = mean_of(oof["original"], qid)
        p_b1 = mean_of(oof["B1"], qid)
        p_b2 = mean_of(oof["B2"], qid)
        rows.append(
            {
                "query_id": qid,
                "topic": topic_of[qid],
                "partner_query_id": partner_of[qid],
                "P_original": p_before,
                "P_B1_swap": p_b1,
                "P_B2_lower_ranks": p_b2,
                "suff_original": int(p_before >= threshold),
                "suff_B1": int(p_b1 >= threshold),
                "suff_B2": int(p_b2 >= threshold),
            }
        )

    df = pd.DataFrame(rows)
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(ANALYSIS_DIR / "counterfactual.csv", index=False, encoding="utf-8-sig")

    summaries = []
    for label, col in [("B1_swap", "P_B1_swap"), ("B2_lower_ranks", "P_B2_lower_ranks")]:
        stat, p_value = wilcoxon(df["P_original"], df[col])
        suff_col = "suff_B1" if label == "B1_swap" else "suff_B2"
        summaries.append(
            {
                "variant": label,
                "n": len(df),
                "mean_P_original": df["P_original"].mean(),
                "mean_P_perturbed": df[col].mean(),
                "pct_decreased": float((df[col] < df["P_original"]).mean() * 100),
                "wilcoxon_p": p_value,
                "pct_suff_before": float(df["suff_original"].mean() * 100),
                "pct_suff_after": float(df[suff_col].mean() * 100),
            }
        )
    summary_df = pd.DataFrame(summaries)
    summary_df.to_csv(ANALYSIS_DIR / "counterfactual_summary.csv", index=False, encoding="utf-8-sig")

    fig, axes = plt.subplots(1, 2, figsize=(11, 5), sharex=True, sharey=True)
    for ax, (label, col) in zip(axes, [("B1: topic swap", "P_B1_swap"), ("B2: own ranks 4-6", "P_B2_lower_ranks")]):
        ax.scatter(df["P_original"], df[col], alpha=0.5, s=15)
        ax.plot([0, 1], [0, 1], "k--", linewidth=1)
        ax.set_xlabel("P(sufficient) original")
        ax.set_ylabel("P(sufficient) perturbed")
        ax.set_title(label)
        ax.set_xlim(0, 1); ax.set_ylim(0, 1)
    plt.tight_layout()
    plt.savefig(ANALYSIS_DIR / "counterfactual.png", dpi=150)
    plt.close()

    return df, summary_df


# --------------------------------------------------------------------------
# C: error analysis
# --------------------------------------------------------------------------
def run_error_analysis(meta_df, features_df, scores_df, threshold):
    oof = pd.read_csv(RESULTS_DIR / "oof_predictions.csv")
    sub = oof[(oof.model == "M3+Q") & (oof.classifier == "LR")]
    p_avg = sub.groupby("query_id")["y_prob"].mean().rename("P")

    labels = rd_csv(LABELS_CSV)[["query_id", "label"]]
    labels["label"] = labels["label"].astype(int)
    rationale = rd_csv(LABEL_RATIONALE_CSV)[["query_id", "confidence"]]

    df = meta_df.merge(labels, on="query_id").merge(features_df[["query_id", "qword", "is_yes_no"]], on="query_id")
    df = df.merge(p_avg.reset_index(), on="query_id").merge(rationale, on="query_id", how="left")
    df["predicted_class"] = (df["P"] >= 0.5).astype(int)
    df["answered_confidently"] = (df["P"] >= threshold).astype(int)
    df["correct"] = (df["predicted_class"] == df["label"]).astype(int)

    def group_metrics(sub_df):
        n = len(sub_df)
        y = sub_df["label"].values
        pred = sub_df["predicted_class"].values
        accuracy = float((pred == y).mean())
        tp = int(((pred == 1) & (y == 1)).sum())
        fp = int(((pred == 1) & (y == 0)).sum())
        fn = int(((pred == 0) & (y == 1)).sum())
        precision_1 = tp / (tp + fp) if (tp + fp) > 0 else float("nan")
        recall_1 = tp / (tp + fn) if (tp + fn) > 0 else float("nan")
        n_answered = int(sub_df["answered_confidently"].sum())
        return {
            "n": n, "accuracy": accuracy, "precision_1": precision_1,
            "recall_1": recall_1, "n_answered_confidently": n_answered,
        }

    def breakdown(group_col):
        rows = []
        for val, sub_df in df.groupby(group_col):
            m = group_metrics(sub_df)
            m.update({"group_type": group_col, "group_value": val})
            rows.append(m)
        return pd.DataFrame(rows)

    tables = []
    tables.append(breakdown("intended_type"))

    rows = []
    for (itype, lbl), sub_df in df.groupby(["intended_type", "label"]):
        m = group_metrics(sub_df)
        m.update({"group_type": "intended_type_x_label", "group_value": f"{itype}_label{lbl}"})
        rows.append(m)
    tables.append(pd.DataFrame(rows))

    tables.append(breakdown("is_yes_no"))
    tables.append(breakdown("qword"))
    tables.append(breakdown("topic"))
    tables.append(breakdown("confidence"))

    error_by_group = pd.concat(tables, ignore_index=True)

    answerable_label0 = df[(df.intended_type == "answerable") & (df.label == 0)]
    pct_correct_insuff = float((answerable_label0["predicted_class"] == 0).mean() * 100)

    partial_nc_label1 = df[(df.intended_type.isin(["partial", "not_covered"])) & (df.label == 1)]
    pct_correct_suff = float((partial_nc_label1["predicted_class"] == 1).mean() * 100)

    special = pd.DataFrame(
        [
            {
                "group": "answerable_label0_predicted_insufficient_pct",
                "n": len(answerable_label0),
                "pct": pct_correct_insuff,
            },
            {
                "group": "partial_or_not_covered_label1_predicted_sufficient_pct",
                "n": len(partial_nc_label1),
                "pct": pct_correct_suff,
            },
        ]
    )
    error_by_group = pd.concat([error_by_group, special.rename(columns={"group": "group_value"})], ignore_index=True)

    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    error_by_group.to_csv(ANALYSIS_DIR / "error_by_group.csv", index=False, encoding="utf-8-sig")

    sec1 = scores_df.set_index("query_id")["rank1_section_number"]

    def make_example_rows(sub_df, example_type):
        out = []
        for _, r in sub_df.iterrows():
            out.append(
                {
                    "example_type": example_type,
                    "query_id": r["query_id"],
                    "sinhala_query": r["sinhala_query"],
                    "intended_type": r["intended_type"],
                    "label": int(r["label"]),
                    "P": float(r["P"]),
                    "top1_chunk_section": sec1.get(r["query_id"], None),
                }
            )
        return out

    false_suff = df[df.label == 0].sort_values("P", ascending=False).head(5)
    false_insuff = df[df.label == 1].sort_values("P", ascending=True).head(5)
    correct_catches = answerable_label0[answerable_label0.predicted_class == 0].sort_values("P", ascending=True).head(5)

    examples = (
        make_example_rows(false_suff, "most_confident_false_sufficient")
        + make_example_rows(false_insuff, "most_confident_false_insufficient")
        + make_example_rows(correct_catches, "correct_catch_answerable_label0")
    )
    examples_df = pd.DataFrame(examples)
    examples_df.to_csv(ANALYSIS_DIR / "error_examples.csv", index=False, encoding="utf-8-sig")

    return df, error_by_group, examples_df, pct_correct_insuff, pct_correct_suff, len(answerable_label0), len(partial_nc_label1)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    queries_df = rd_csv(config.QUERIES_MASTER_CSV)[["query_id", "sinhala_query"]]
    meta_df = rd_csv(config.QUERIES_MASTER_CSV)
    scores_df = rd_csv(RETRIEVAL_SCORES_CSV)
    features_df = rd_csv(FEATURES_CSV)
    for c in features_df.columns:
        if c not in ("query_id", "qword"):
            features_df[c] = features_df[c].astype(float)

    chunks, chunk_id_to_idx, chunk_section, chunk_ids_ordered = load_chunks()
    cache = load_cache()

    print("=== STEP 0: sanity check ===")
    sanity_ok = sanity_check(queries_df, scores_df, cache, chunks, chunk_id_to_idx, chunk_section)
    if not sanity_ok:
        print("STOPPING: recomputed features do not match outputs/features.csv.")
        sys.exit(1)

    _, cols, threshold = load_model_and_card()

    labels = rd_csv(LABELS_CSV)[["query_id", "label"]]
    labels["label"] = labels["label"].astype(int)
    df_with_label = features_df.merge(labels, on="query_id")

    print("\n=== TEST A: evidence removal (out-of-fold models) ===")
    a_df, a_summary = run_test_a(
        queries_df, scores_df, cache, chunks, chunk_id_to_idx, chunk_section,
        chunk_ids_ordered, features_df, df_with_label, cols, threshold,
    )

    print("\n=== TEST B: counterfactual evidence (out-of-fold models) ===")
    b_df, b_summary = run_test_b(
        queries_df, meta_df, scores_df, cache, chunks, chunk_id_to_idx, chunk_section,
        chunk_ids_ordered, features_df, df_with_label, cols, threshold,
    )

    print("\n=== C: error analysis ===")
    err_df, error_by_group, examples_df, pct_correct_insuff, pct_correct_suff, n_ans_lbl0, n_pn_lbl1 = run_error_analysis(
        meta_df, features_df, scores_df, threshold
    )

    # --------------------------------------------------------------- summary
    print("\n\n################ FINAL SUMMARY ################")

    print("\n1. Step 0 sanity check:", "PASS" if sanity_ok else "FAIL")

    print("\n2. Test A (evidence removal) summary:")
    print(a_summary.to_string(index=False))

    print("\n3. Test B summaries (B1 swap, B2 lower ranks):")
    print(b_summary.to_string(index=False))

    still_suff_b1 = b_df[b_df.suff_B1 == 1]
    print(
        f"\n  B1 breakdown: {len(still_suff_b1)} / {len(b_df)} queries remain predicted "
        f"sufficient (P >= {threshold:.4f}) after the topic swap."
    )
    if len(still_suff_b1) > 0:
        print("  by original topic:")
        print(still_suff_b1["topic"].value_counts().to_string())
        print("  query_ids:", ", ".join(still_suff_b1["query_id"].tolist()))

    print("\n4. Error analysis:")
    print("\n  intended_type x label:")
    print(
        error_by_group[error_by_group.group_type == "intended_type_x_label"][
            ["group_value", "n", "accuracy", "precision_1", "recall_1", "n_answered_confidently"]
        ].to_string(index=False)
    )
    print(f"\n  Special group - answerable & label=0 (n={n_ans_lbl0}): "
          f"{pct_correct_insuff:.1f}% correctly predicted insufficient")
    print(f"  Special group - partial/not_covered & label=1 (n={n_pn_lbl1}): "
          f"{pct_correct_suff:.1f}% correctly predicted sufficient")
    print("\n  is_yes_no vs qword:")
    print(
        error_by_group[error_by_group.group_type.isin(["is_yes_no", "qword"])][
            ["group_type", "group_value", "n", "accuracy", "precision_1", "recall_1", "n_answered_confidently"]
        ].to_string(index=False)
    )
    print("\n  label confidence HIGH vs LOW:")
    print(
        error_by_group[error_by_group.group_type == "confidence"][
            ["group_value", "n", "accuracy", "precision_1", "recall_1", "n_answered_confidently"]
        ].to_string(index=False)
    )

    print("\n5. 15 examples:")
    print(examples_df.to_string(index=False))

    files = [
        ANALYSIS_DIR / "evidence_removal.csv",
        ANALYSIS_DIR / "evidence_removal_summary.csv",
        ANALYSIS_DIR / "evidence_removal.png",
        ANALYSIS_DIR / "counterfactual.csv",
        ANALYSIS_DIR / "counterfactual_summary.csv",
        ANALYSIS_DIR / "counterfactual.png",
        ANALYSIS_DIR / "error_by_group.csv",
        ANALYSIS_DIR / "error_examples.csv",
    ]
    print("\n6. Files created:")
    for p in files:
        print(f"   {p} ({p.stat().st_size} bytes)")
    print(
        "   Confirmed: features.csv, data/, the index, the saved model "
        "(outputs/models/sufficiency_lr_m3q.joblib), and all pre-existing "
        "outputs/results/* files were not modified by this script."
    )


if __name__ == "__main__":
    main()

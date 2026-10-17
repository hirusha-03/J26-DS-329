# -*- coding: utf-8 -*-
"""Regenerate recall_at3_by_model.png from existing results_summary.csv.
Does not re-run any model or touch any other file."""
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT_DIR = Path(r"E:/Research/J26-DS-329/backend/ml/advisory/experiments/embedder_comparison")

LABELS = {
    "bge-m3": "BGE-M3",
    "multilingual-e5-large": "mE5-large",
    "LaBSE": "LaBSE",
    "paraphrase-multilingual-MiniLM-L12-v2": "MiniLM-L12",
}

df = pd.read_csv(OUT_DIR / "results_summary.csv", dtype=str, keep_default_na=False, encoding="utf-8-sig")
all_df = df[df["split"] == "all"].copy()
all_df["recall_at3_mean"] = all_df["recall_at3_mean"].astype(float)
all_df["recall_at3_ci_lo"] = all_df["recall_at3_ci_lo"].astype(float)
all_df["recall_at3_ci_hi"] = all_df["recall_at3_ci_hi"].astype(float)
all_df["label"] = all_df["model"].map(LABELS)

all_df = all_df.sort_values("recall_at3_mean", ascending=False).reset_index(drop=True)

means = all_df["recall_at3_mean"].values
lo_err = means - all_df["recall_at3_ci_lo"].values
hi_err = all_df["recall_at3_ci_hi"].values - means

colors = ["#C44E52" if m == "bge-m3" else "#4C72B0" for m in all_df["model"]]

fig, ax = plt.subplots(figsize=(8, 5))
x = np.arange(len(all_df))
bars = ax.bar(x, means, yerr=[lo_err, hi_err], capsize=5, color=colors)
ax.set_xticks(x)
ax.set_xticklabels(all_df["label"].tolist())
ax.set_ylabel("Recall@3")
ax.set_title("Recall@3 by embedding model")
ax.set_ylim(0, 1)

for i, (bar, m, hi) in enumerate(zip(bars, means, all_df["recall_at3_ci_hi"].values)):
    ax.text(bar.get_x() + bar.get_width() / 2, hi + 0.02, f"{m:.2f}", ha="center", va="bottom", fontsize=10)

fig.tight_layout()
fig.savefig(OUT_DIR / "recall_at3_by_model.png", dpi=150)
plt.close(fig)
print("saved recall_at3_by_model.png")
print(all_df[["model", "label", "recall_at3_mean"]].to_string(index=False))

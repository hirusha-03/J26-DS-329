"""Vine-grouped stratified folds for the local field data, with a leakage check.

Photos of the same vine (often the same leaf) must never be split across folds.
Usage: python -m src.m1.splits --metadata data/m1_local_2026-10-11/metadata.csv
"""
import argparse
from pathlib import Path

import pandas as pd
from sklearn.model_selection import StratifiedGroupKFold

from .labels import local_label

MODULE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUT = MODULE_DIR / "splits" / "local_vine_folds.csv"

# Unmarked groups that probably are a marked vine (see docs/COLLECTION_LOG.md); kept together to be safe.
LINKED_GROUPS = {
    "U03": "D2-V01",  # forwarded with the D2-V01 photos
    "U08": "C3-V03",  # taken right after C3-V03, same white-spot leaves
}
# Vine unknown, so no safe group exists; never put in a fold.
EXCLUDED_GROUPS = {"EXTRA"}


def leak_groups(df: pd.DataFrame) -> pd.Series:
    return df["group_id"].map(lambda g: LINKED_GROUPS.get(g, g))


def check_leakage(folds: pd.DataFrame) -> None:
    """Raise if a group spans folds or a photo appears twice."""
    used = folds[folds["fold"] >= 0]
    spread = used.groupby("leak_group")["fold"].nunique()
    leaked = spread[spread > 1]
    if not leaked.empty:
        raise ValueError(f"groups in more than one fold: {sorted(leaked.index)}")
    dupes = folds["path"][folds["path"].duplicated()]
    if not dupes.empty:
        raise ValueError(f"duplicate photos: {sorted(dupes)}")


def make_folds(meta: pd.DataFrame, n_splits: int = 5, seed: int = 42) -> pd.DataFrame:
    df = meta[["path", "group_id", "zone", "block", "supervisor_label"]].copy()
    df["leak_group"] = leak_groups(df)
    df["label"] = df["supervisor_label"].map(local_label)
    df["fold"] = -1

    usable = ~df["group_id"].isin(EXCLUDED_GROUPS)
    # Stratify on the label; until the supervisor labels arrive every row is "unlabeled".
    y = df.loc[usable, "label"].fillna("unlabeled")
    sgkf = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    idx = df.index[usable]
    for fold, (_, test) in enumerate(sgkf.split(idx, y, groups=df.loc[usable, "leak_group"])):
        df.loc[idx[test], "fold"] = fold

    out = df.drop(columns="supervisor_label")
    check_leakage(out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--metadata", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--n-splits", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    folds = make_folds(pd.read_csv(args.metadata), args.n_splits, args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    folds.to_csv(args.out, index=False)

    print(f"wrote {args.out} ({len(folds)} rows), leakage check passed")
    print(folds.groupby("fold").agg(photos=("path", "size"), groups=("leak_group", "nunique")).to_string())


if __name__ == "__main__":
    main()

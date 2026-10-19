import pandas as pd
import pytest

from src.m1.labels import (action, classes, is_unseen, local_eval_class, local_label, needs_attention,
                           source_label)
from src.m1.splits import DEFAULT_OUT, check_leakage, main, make_folds

# Dropdown in M1_label_review_round1.xlsx
SUPERVISOR_VOCAB = ["healthy", "stem_rot", "yellowing", "leaf_spot", "other", "cant_tell", "exclude"]


def fake_meta(n_vines=12, per_vine=4, labels=("healthy", "stem_rot")):
    rows = [
        {"path": f"img/V{v:02d}_{i}.jpg", "group_id": f"C1-V{v:02d}", "zone": "C", "block": 1,
         "supervisor_label": labels[v % len(labels)]}
        for v in range(n_vines) for i in range(per_vine)
    ]
    rows += [{"path": "img/U03_0.jpg", "group_id": "U03", "zone": "D", "block": 2, "supervisor_label": None},
             {"path": "img/D2_0.jpg", "group_id": "D2-V01", "zone": "D", "block": 2, "supervisor_label": None},
             {"path": "img/X_0.jpg", "group_id": "EXTRA", "zone": "", "block": "", "supervisor_label": None}]
    return pd.DataFrame(rows)


def test_folds_have_no_vine_leakage():
    folds = make_folds(fake_meta())
    assert (folds.groupby("leak_group")["fold"].nunique() == 1).all()


def test_linked_and_excluded_groups():
    folds = make_folds(fake_meta()).set_index("group_id")
    assert folds.loc["U03", "fold"] == folds.loc["D2-V01", "fold"]
    assert folds.loc["EXTRA", "fold"] == -1


def test_check_leakage_catches_split_vine():
    folds = make_folds(fake_meta())
    i = folds.index[folds["leak_group"] == "C1-V00"][0]
    folds.loc[i, "fold"] = (folds.loc[i, "fold"] + 1) % 5
    with pytest.raises(ValueError):
        check_leakage(folds)


def test_committed_splits_are_clean():
    check_leakage(pd.read_csv(DEFAULT_OUT))


def test_labels():
    assert classes() == ["healthy", "black_spot", "red_spot", "stem_rot"]
    assert source_label("rotten stem") == "stem_rot"
    assert local_label(" Healthy ") == "healthy"
    assert local_label(None) is None and local_label("cant_tell") is None and local_label("exclude") is None
    assert local_label("leaf_spot") == "leaf_spot" and local_label("other") == "other"
    assert local_label("yellowing") == "yellowing"
    with pytest.raises(KeyError):
        local_label("not_a_label")
    assert action("stem_rot") == "urgent_stem_rot" and action(None) == "expert_review"
    assert action("yellowing") == "urgent_stem_rot" and action("leaf_spot") == "treat_leaf_disease"


def test_every_supervisor_option_maps():
    for v in SUPERVISOR_VOCAB:
        local_label(v)  # KeyError if the yaml misses a dropdown option


def test_eval_groups():
    assert local_eval_class("red_spot") == local_eval_class("black_spot") == "leaf_spot"
    assert local_eval_class("stem_rot") == "stem_rot" and local_eval_class("yellowing") is None
    assert is_unseen("yellowing") and is_unseen("other") and not is_unseen("stem_rot")
    assert needs_attention("yellowing") is True and needs_attention("healthy") is False
    assert needs_attention(local_label("cant_tell")) is None


def test_stratified_on_vine_symptom():
    # vine with one yellowing photo among healthy ones still counts as a symptom vine
    meta = fake_meta(n_vines=20, labels=("healthy", "healthy", "yellowing", "leaf_spot"))
    folds = make_folds(meta)
    assert folds.loc[folds["group_id"] == "C1-V02", "symptom"].eq("symptom").all()
    used = folds[folds["fold"] >= 0].drop_duplicates("leak_group")
    per_fold = used.groupby("fold")["symptom"].apply(set)
    assert all({"symptom", "healthy"} <= s for s in per_fold)


def test_splits_are_frozen(tmp_path):
    meta, out = tmp_path / "meta.csv", tmp_path / "folds.csv"
    fake_meta().to_csv(meta, index=False)
    main(["--metadata", str(meta), "--out", str(out)])
    with pytest.raises(SystemExit):
        main(["--metadata", str(meta), "--out", str(out)])
    main(["--metadata", str(meta), "--out", str(out), "--force"])

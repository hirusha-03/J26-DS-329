import pandas as pd
import pytest

from src.m1.labels import action, classes, local_label, source_label
from src.m1.splits import DEFAULT_OUT, check_leakage, make_folds


def fake_meta(n_vines=12, per_vine=4):
    rows = [
        {"path": f"img/V{v:02d}_{i}.jpg", "group_id": f"C1-V{v:02d}", "zone": "C", "block": 1,
         "supervisor_label": ["healthy", "stem_rot"][v % 2]}
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
    assert local_label("yellowing") is None and local_label(None) is None
    with pytest.raises(KeyError):
        local_label("not_a_label")
    assert action("stem_rot") == "urgent_stem_rot" and action(None) == "expert_review"

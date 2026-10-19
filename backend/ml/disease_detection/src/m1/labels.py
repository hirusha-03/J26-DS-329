"""Label mapping for M1, read from configs/labels.yaml."""
from functools import lru_cache
from pathlib import Path

import yaml

CONFIG_PATH = Path(__file__).resolve().parents[2] / "configs" / "labels.yaml"


@lru_cache(maxsize=None)
def load_config(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def classes() -> list[str]:
    return load_config()["classes"]


def source_label(folder: str) -> str:
    """Kaggle folder name -> canonical class. Raises KeyError for an unknown folder."""
    return load_config()["source"]["folders"][folder]


def local_label(supervisor_label) -> str | None:
    """supervisor_label -> canonical class, or None if empty or outside the classes."""
    if supervisor_label is None or str(supervisor_label).strip() in ("", "nan"):
        return None
    key = str(supervisor_label).strip().lower()
    mapping = load_config()["local"]
    if key not in mapping:
        raise KeyError(f"unknown supervisor_label {supervisor_label!r}; add it to configs/labels.yaml")
    return mapping[key]


def action(label: str | None) -> str:
    actions = load_config()["action"]
    return actions.get(label, actions["unknown"]) if label else actions["unknown"]


def local_eval_class(label: str | None) -> str | None:
    """Model prediction or local label -> 3-class eval name, or None if outside the 3 classes."""
    ev = load_config()["evaluation"]
    label = ev["collapse"].get(label, label)
    return label if label in ev["local_classes"] else None


def is_unseen(label: str | None) -> bool:
    return label in load_config()["evaluation"]["unseen"]


def needs_attention(label: str | None) -> bool | None:
    """Binary target: True for any symptom (incl. unseen), False for healthy, None if unusable."""
    return None if label is None else label != "healthy"

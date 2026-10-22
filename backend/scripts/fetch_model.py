"""Download the M1 disease model named in model_card.json from its GitHub Release.

    python scripts/fetch_model.py          # run from backend/

Saves to backend/models/m1/<file> (git-ignored) and verifies the SHA-256. Does nothing if the
file is already there and correct. Stdlib only, so it also runs in the Docker build.
"""
import argparse
import hashlib
import json
import urllib.error
import urllib.request
from pathlib import Path

REPO = "hirusha-03/J26-DS-329"
BACKEND = Path(__file__).resolve().parents[1]
CARD = BACKEND / "app/services/disease/model_card.json"
DEST_DIR = BACKEND / "models/m1"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(dest_dir: Path = DEST_DIR, *, checkpoint: bool = False) -> Path:
    card = json.loads(CARD.read_text(encoding="utf-8"))
    artifact = card["explanation"]["artifact"] if checkpoint else card["artifact"]
    dest = dest_dir / artifact["file"]
    if dest.is_file() and sha256(dest) == artifact["sha256"]:
        print(f"{dest} already present and verified")
        return dest

    if not artifact.get("release_tag"):
        raise SystemExit(
            "No checkpoint release asset has been published. Supply the matching best.pt "
            "locally in models/m1/ or set M1_CHECKPOINT_PATH; the API verifies its checksum."
        )
    url = f"https://github.com/{REPO}/releases/download/{artifact['release_tag']}/{artifact['file']}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=120) as r, tmp.open("wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    except urllib.error.URLError as e:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"download failed ({e}). Check the release '{artifact['release_tag']}' exists.") from e

    got = sha256(tmp)
    if got != artifact["sha256"]:
        tmp.unlink()
        raise SystemExit(f"checksum mismatch: expected {artifact['sha256']}, got {got}")
    tmp.replace(dest)
    print(f"saved {dest}")
    return dest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", action="store_true", help="Fetch/verify the optional Grad-CAM checkpoint")
    args = parser.parse_args()
    fetch(checkpoint=args.checkpoint)

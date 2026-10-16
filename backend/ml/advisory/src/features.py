"""Feature extraction for the sufficiency-prediction component.

Computes one feature row per query (400 rows) from the query text and its
EXISTING Top-3 retrieved chunks. Retrieval is FROZEN: this script never
re-retrieves, never touches faiss.index / chunks.json / index/config.json,
and never writes anything under data/.

Reads ONLY query_id + sinhala_query from data/queries/queries_master.csv.
Never reads intended_type / topic / expected_label / any label file -
features must not depend on labels.

Must be run with the SEPARATE .venv-features interpreter (FlagEmbedding),
not the main .venv (which has sentence-transformers for retrieval only):

    .venv-features/Scripts/python.exe src/features.py
"""

import hashlib
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import config

FEATURES_ENV_NAME = "BAAI/bge-m3"
MAX_LENGTH = 512

CACHE_DIR = config.OUTPUTS_DIR / "cache"
ENV_DIR = config.OUTPUTS_DIR / "env"
FEATURES_CSV = config.OUTPUTS_DIR / "features.csv"
FEATURE_DICT_MD = config.OUTPUTS_DIR / "feature_dictionary.md"
FEATURE_BLOCKS_JSON = config.OUTPUTS_DIR / "feature_blocks.json"
TIMING_JSON = config.OUTPUTS_DIR / "timing.json"
RETRIEVAL_SCORES_CSV = config.OUTPUTS_DIR / "retrieval_scores.csv"

SPACE_MARKER = "▁"  # SentencePiece "▁"

# --- Block Q question-word matching -----------------------------------
# Matching happens on individual words of the query, after stripping
# surrounding punctuation (WORD_STRIP_CHARS) via _tokenize_words().
#
# 1. PREFIX stems (QWORD_PREFIX_STEMS): a word matches a category if it
#    STARTS WITH one of that category's stems.
# 2. EXACT words (QWORD_EXACT_WORDS): a word matches only if it equals the
#    term exactly (currently just "මන්ද" -> why).
# 3. PHRASES (QWORD_PHRASE_RULES): two consecutive words matching a rule.
#    Phrases are checked BEFORE any single-word (prefix/exact) match, so a
#    phrase match always wins regardless of category priority.
#
# Priority order for single-word matches (first category found wins):
#   who -> how_much -> which -> when -> where -> how -> why -> what
# how_much is checked before which so "කොයිතරම්" (how_much) isn't swallowed
# by which's "කොයි" prefix stem.
QWORD_PREFIX_STEMS = {
    "who": ["කවුද"],
    "how_much": ["කොච්චර", "කොපමණ", "කීය", "කොයිතරම්", "කොතරම්", "කීදෙනෙ", "කීපාර", "කීවෙනි"],
    "which": ["කොයි", "කුමන"],
    "when": ["කවදා", "කවදද"],
    "where": ["කොහෙ", "කොහේ", "කොතැන", "කොතන", "කොහාට"],
    "how": ["කොහොම", "කෙසේ"],
    "why": ["ඇයි"],
    "what": ["මොනව", "මොකක්", "මොකද", "මොක", "මොන", "කුමක්"],
}

QWORD_EXACT_WORDS = {
    "why": ["මන්ද"],
}

QWORD_PRIORITY_ORDER = ["who", "how_much", "which", "when", "where", "how", "why", "what"]


def _phrase_rule_mokada_ayi(w0, w1):
    return w0 == "මොකද" and w1 == "ඇයි"


def _phrase_rule_koyi_wage(w0, w1):
    return w0 == "කොයි" and w1 == "වගේ"


def _phrase_rule_kee_any_word(w0, w1):
    # Standalone "කී" followed by any word -> how_much
    # (e.g. කී පාරක්, කී දවසක්, කී වතාවක්).
    return w0 == "කී"


QWORD_PHRASE_RULES = [
    (_phrase_rule_mokada_ayi, "why"),
    (_phrase_rule_koyi_wage, "which"),
    (_phrase_rule_kee_any_word, "how_much"),
]

# INDEFINITE_WORDS: if a single-word prefix/exact question-word match is
# immediately followed by one of these, it is NOT a question word (e.g.
# "මොනවා හරි" = anything, "කොහේ හරි" = anywhere, "කවදා හරි" = sometime).
# That candidate match is skipped and the rest of the query keeps being
# checked. This filter applies only to the single-word QWORD_PRIORITY_ORDER
# matches below, not to the phrase rules above.
INDEFINITE_WORDS = {"හරි", "හෝ"}

# Words that are also prefix/exact matches for a category but are
# colloquially ambiguous with another meaning (e.g. standalone "මොකද" can
# mean "why" in casual speech even though it maps to "what" here). Flagged
# for manual review; does not change the assigned qword.
AMBIGUOUS_WHAT_WHY_WORDS = {"මොකද"}

WORD_STRIP_CHARS = "?!.,;:\"'’‘“”()[]{}‍"


def _tokenize_words(text):
    words = text.split()
    cleaned = [w.strip(WORD_STRIP_CHARS) for w in words]
    return [w for w in cleaned if w]


def _word_matches_category(word, label):
    for stem in QWORD_PREFIX_STEMS.get(label, []):
        if word.startswith(stem):
            return True
    for exact in QWORD_EXACT_WORDS.get(label, []):
        if word == exact:
            return True
    return False


def find_ambiguous_what_why(text):
    """Return True if the query contains the standalone word 'මොකද', which
    is colloquially ambiguous between 'what' and 'why'."""
    words = set(_tokenize_words(text))
    return bool(words & AMBIGUOUS_WHAT_WHY_WORDS)


def rd_csv(path):
    return pd.read_csv(path, dtype=str, keep_default_na=False)


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Step 0: model loading + sanity check
# ---------------------------------------------------------------------------

def load_model():
    from FlagEmbedding import BGEM3FlagModel

    model = BGEM3FlagModel(FEATURES_ENV_NAME, use_fp16=False)
    return model


def sanity_check(model, queries_df, scores_df, n=5):
    """Reproduce stored rank1 cosine score + chunk_id for n queries using
    FlagEmbedding dense vectors against the frozen chunk texts. Returns
    True/False and prints detail."""
    chunks = json.load(open(config.CHUNKS_JSON_PATH, encoding="utf-8"))
    chunk_text = {c["chunk_id"]: c["text"] for c in chunks}
    chunk_ids_ordered = [c["chunk_id"] for c in chunks]

    sample = queries_df.head(n)
    q_texts = sample["sinhala_query"].tolist()
    q_out = model.encode(q_texts, max_length=MAX_LENGTH, return_dense=True,
                          return_sparse=False, return_colbert_vecs=False)
    q_dense = np.asarray(q_out["dense_vecs"], dtype="float32")
    q_dense = q_dense / np.linalg.norm(q_dense, axis=1, keepdims=True)

    c_texts = [chunk_text[cid] for cid in chunk_ids_ordered]
    c_out = model.encode(c_texts, max_length=MAX_LENGTH, return_dense=True,
                          return_sparse=False, return_colbert_vecs=False)
    c_dense = np.asarray(c_out["dense_vecs"], dtype="float32")
    c_dense = c_dense / np.linalg.norm(c_dense, axis=1, keepdims=True)

    ok = True
    for i, qid in enumerate(sample["query_id"]):
        sims = c_dense @ q_dense[i]
        order = np.argsort(-sims)[:3]
        got_cids = [chunk_ids_ordered[j] for j in order]
        got_scores = [round(float(sims[j]), 4) for j in order]

        row = scores_df[scores_df["query_id"] == qid].iloc[0]
        exp_cids = [row["rank1_chunk_id"], row["rank2_chunk_id"], row["rank3_chunk_id"]]
        exp_scores = [round(float(row["rank1_score"]), 4), round(float(row["rank2_score"]), 4),
                      round(float(row["rank3_score"]), 4)]

        match = got_cids == exp_cids and got_scores == exp_scores
        print(f"  {qid}: got={list(zip(got_cids, got_scores))} "
              f"expected={list(zip(exp_cids, exp_scores))} -> {'OK' if match else 'MISMATCH'}")
        ok = ok and match
    return ok


# ---------------------------------------------------------------------------
# Step 1: token-vector caching
# ---------------------------------------------------------------------------

def is_kept_token(token_str, special_tokens=frozenset()):
    """Exclude special tokens, padding, punctuation-only, and the bare
    SentencePiece space marker from the query token set."""
    if token_str is None:
        return False
    if token_str in special_tokens:
        return False
    stripped = token_str.replace(SPACE_MARKER, "")
    if stripped == "":
        return False
    if re.fullmatch(r"[\W_]+", stripped, flags=re.UNICODE):
        return False
    return True


def build_or_load_cache(model, queries_df, chunks):
    chunks_sha = sha256_file(config.CHUNKS_JSON_PATH)
    meta_path = CACHE_DIR / "meta.json"
    cache_paths = {
        "query_dense": CACHE_DIR / "query_dense.npy",
        "query_tok_vecs": CACHE_DIR / "query_tok_vecs.pkl",
        "query_tok_ids": CACHE_DIR / "query_tok_ids.pkl",
        "query_sparse": CACHE_DIR / "query_sparse.pkl",
        "chunk_tok_vecs": CACHE_DIR / "chunk_tok_vecs.pkl",
        "chunk_tok_ids": CACHE_DIR / "chunk_tok_ids.pkl",
        "chunk_dense": CACHE_DIR / "chunk_dense.npy",
    }

    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if (meta.get("model") == FEATURES_ENV_NAME and meta.get("chunks_sha256") == chunks_sha
                and meta.get("n_queries") == len(queries_df) and meta.get("n_chunks") == len(chunks)
                and all(p.exists() for p in cache_paths.values())):
            print(f"Reusing cache at {CACHE_DIR} (metadata matches).")
            import pickle
            data = {}
            data["query_dense"] = np.load(cache_paths["query_dense"])
            data["chunk_dense"] = np.load(cache_paths["chunk_dense"])
            with open(cache_paths["query_tok_vecs"], "rb") as f:
                data["query_tok_vecs"] = pickle.load(f)
            with open(cache_paths["query_tok_ids"], "rb") as f:
                data["query_tok_ids"] = pickle.load(f)
            with open(cache_paths["query_sparse"], "rb") as f:
                data["query_sparse"] = pickle.load(f)
            with open(cache_paths["chunk_tok_vecs"], "rb") as f:
                data["chunk_tok_vecs"] = pickle.load(f)
            with open(cache_paths["chunk_tok_ids"], "rb") as f:
                data["chunk_tok_ids"] = pickle.load(f)
            return data, meta.get("avg_excluded_tokens_per_query")

    print("Cache miss / stale - encoding all 400 queries and 92 chunks...")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    import pickle

    tokenizer = model.tokenizer
    special_tokens = frozenset(tokenizer.all_special_tokens)

    q_texts = queries_df["sinhala_query"].tolist()
    q_out = model.encode(q_texts, max_length=MAX_LENGTH, return_dense=True,
                          return_sparse=True, return_colbert_vecs=True)

    c_texts = [c["text"] for c in chunks]
    c_out = model.encode(c_texts, max_length=MAX_LENGTH, return_dense=True,
                          return_sparse=True, return_colbert_vecs=True)

    query_tok_vecs = []   # list[np.ndarray (n_kept, 1024)] per query, L2-normalized
    query_tok_ids = []    # list[list[int]] kept token ids per query
    query_sparse = []     # list[dict[int->weight]] restricted to kept token ids

    n_excluded_total = 0
    for i, text in enumerate(q_texts):
        enc = tokenizer(text, truncation=True, max_length=MAX_LENGTH)
        # FlagEmbedding's BGEM3FlagModel.encode() drops the CLS vector from
        # colbert_vecs before returning it (see _process_colbert_vecs:
        # `colbert_vecs[:tokens_num - 1]`), so colbert_vecs[j] corresponds to
        # ids[j+1], not ids[j]. Align by dropping the leading CLS id here.
        ids = enc["input_ids"][1:]
        colbert_vecs = np.asarray(q_out["colbert_vecs"][i], dtype="float32")
        n = min(len(ids), colbert_vecs.shape[0])
        assert len(ids) == colbert_vecs.shape[0], (
            f"query {i}: token id / vector length mismatch {len(ids)} vs {colbert_vecs.shape[0]}"
        )

        lexical_weights = q_out["lexical_weights"][i]  # dict[str(token_id) -> weight]

        kept_idx = []
        for j in range(n):
            tok_str = tokenizer.convert_ids_to_tokens(ids[j])
            if is_kept_token(tok_str, special_tokens):
                kept_idx.append(j)
        n_excluded_total += (n - len(kept_idx))

        kept_vecs = colbert_vecs[kept_idx]
        norms = np.linalg.norm(kept_vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        kept_vecs = kept_vecs / norms

        kept_ids = [ids[j] for j in kept_idx]
        kept_weights = [float(lexical_weights.get(str(tid), 0.0)) for tid in kept_ids]

        query_tok_vecs.append(kept_vecs)
        query_tok_ids.append(kept_ids)
        query_sparse.append(kept_weights)

    avg_excluded = n_excluded_total / len(q_texts)
    print(f"Average excluded tokens per query: {avg_excluded:.3f}")

    chunk_tok_vecs = []
    chunk_tok_ids = []
    for i, text in enumerate(c_texts):
        enc = tokenizer(text, truncation=True, max_length=MAX_LENGTH)
        ids = enc["input_ids"][1:]  # see CLS-drop note above
        colbert_vecs = np.asarray(c_out["colbert_vecs"][i], dtype="float32")
        assert len(ids) == colbert_vecs.shape[0], (
            f"chunk {i}: token id / vector length mismatch {len(ids)} vs {colbert_vecs.shape[0]}"
        )
        norms = np.linalg.norm(colbert_vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        colbert_vecs = colbert_vecs / norms
        chunk_tok_vecs.append(colbert_vecs)
        chunk_tok_ids.append(ids)

    query_dense = np.asarray(q_out["dense_vecs"], dtype="float32")
    chunk_dense = np.asarray(c_out["dense_vecs"], dtype="float32")

    np.save(cache_paths["query_dense"], query_dense)
    np.save(cache_paths["chunk_dense"], chunk_dense)
    with open(cache_paths["query_tok_vecs"], "wb") as f:
        pickle.dump(query_tok_vecs, f)
    with open(cache_paths["query_tok_ids"], "wb") as f:
        pickle.dump(query_tok_ids, f)
    with open(cache_paths["query_sparse"], "wb") as f:
        pickle.dump(query_sparse, f)
    with open(cache_paths["chunk_tok_vecs"], "wb") as f:
        pickle.dump(chunk_tok_vecs, f)
    with open(cache_paths["chunk_tok_ids"], "wb") as f:
        pickle.dump(chunk_tok_ids, f)

    meta = {
        "model": FEATURES_ENV_NAME,
        "chunks_sha256": chunks_sha,
        "n_queries": len(queries_df),
        "n_chunks": len(chunks),
        "avg_excluded_tokens_per_query": avg_excluded,
        "max_length": MAX_LENGTH,
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    data = {
        "query_dense": query_dense,
        "chunk_dense": chunk_dense,
        "query_tok_vecs": query_tok_vecs,
        "query_tok_ids": query_tok_ids,
        "query_sparse": query_sparse,
        "chunk_tok_vecs": chunk_tok_vecs,
        "chunk_tok_ids": chunk_tok_ids,
    }
    return data, avg_excluded


# ---------------------------------------------------------------------------
# Block Q: query-form features
# ---------------------------------------------------------------------------

def classify_qword(text):
    words = _tokenize_words(text)

    # Phrases are checked before any single-word match, regardless of
    # category priority.
    for i in range(len(words) - 1):
        for cond, label in QWORD_PHRASE_RULES:
            if cond(words[i], words[i + 1]):
                return label

    for label in QWORD_PRIORITY_ORDER:
        for idx, w in enumerate(words):
            if not _word_matches_category(w, label):
                continue
            if idx + 1 < len(words) and words[idx + 1] in INDEFINITE_WORDS:
                continue
            return label
    return "none"


def is_yes_no_query(text, qword):
    if qword != "none":
        return 0
    t = text.strip()
    t = t.rstrip("?").rstrip()
    t = t.rstrip("‍").rstrip()
    return 1 if t.endswith("ද") else 0


def count_tokens_sinhala(text, tokenizer):
    enc = tokenizer(text, truncation=True, max_length=MAX_LENGTH)
    ids = enc["input_ids"]
    special_tokens = frozenset(tokenizer.all_special_tokens)
    kept = 0
    for tid in ids:
        tok_str = tokenizer.convert_ids_to_tokens(tid)
        if is_kept_token(tok_str, special_tokens):
            kept += 1
    return kept


def has_number(text):
    return 1 if re.search(r"\d", text) else 0


# ---------------------------------------------------------------------------
# Main feature computation
# ---------------------------------------------------------------------------

def main():
    t_start_total = time.time()

    queries_df = rd_csv(config.QUERIES_MASTER_CSV)[["query_id", "sinhala_query"]]
    scores_df = rd_csv(RETRIEVAL_SCORES_CSV)
    chunks = json.load(open(config.CHUNKS_JSON_PATH, encoding="utf-8"))
    chunk_id_to_idx = {c["chunk_id"]: i for i, c in enumerate(chunks)}
    chunk_section = {c["chunk_id"]: c["section_number"] for c in chunks}

    print("Loading BGEM3FlagModel (use_fp16=False, CPU) ...")
    t0 = time.time()
    model = load_model()
    load_time = time.time() - t0
    print(f"Model loaded in {load_time:.1f}s")

    print("\n=== STEP 0: sanity check (5 queries, cosine to 4dp) ===")
    sanity_ok = sanity_check(model, queries_df, scores_df, n=5)
    print(f"SANITY CHECK: {'PASS' if sanity_ok else 'FAIL'}")
    if not sanity_ok:
        print("STOPPING: dense-embedding sanity check failed.")
        return

    print("\n=== STEP 1: token-vector caching ===")
    t0 = time.time()
    cache, avg_excluded = build_or_load_cache(model, queries_df, chunks)
    encode_time = time.time() - t0
    print(f"Cache ready in {encode_time:.1f}s. Avg excluded tokens/query: {avg_excluded:.3f}")

    tokenizer = model.tokenizer

    # alignment check: token vector count == token id count, per query
    align_ok = True
    for i in range(len(queries_df)):
        if cache["query_tok_vecs"][i].shape[0] != len(cache["query_tok_ids"][i]):
            align_ok = False
    print(f"Token vector / token id alignment check: {'PASS' if align_ok else 'FAIL'}")

    print("\n=== STEP 2: computing features ===")
    t0 = time.time()

    qword_counts = {}
    yesno_counts = {0: 0, 1: 0}
    qword_examples = {}
    yesno_examples = {0: [], 1: []}

    rows = []
    example_alignments = []  # for 3 sample queries: per-token a[i] + decoded tokens

    for i, qid in enumerate(queries_df["query_id"]):
        text = queries_df.iloc[i]["sinhala_query"]
        sc_row = scores_df[scores_df["query_id"] == qid].iloc[0]

        s1 = float(sc_row["rank1_score"])
        s2 = float(sc_row["rank2_score"])
        s3 = float(sc_row["rank3_score"])
        s_mean = (s1 + s2 + s3) / 3.0
        s_std = float(np.std([s1, s2, s3]))
        gap12 = s1 - s2
        gap13 = s1 - s3
        gap23 = s2 - s3

        passage_cids = [sc_row["rank1_chunk_id"], sc_row["rank2_chunk_id"], sc_row["rank3_chunk_id"]]
        passage_idx = [chunk_id_to_idx[c] for c in passage_cids]

        q_vecs = cache["query_tok_vecs"][i]  # (n, 1024)
        q_weights = np.asarray(cache["query_sparse"][i], dtype="float64")  # (n,)
        n_tok = q_vecs.shape[0]

        if n_tok == 0:
            a_per_passage = np.zeros((0, 3), dtype="float64")
        else:
            a_per_passage = np.zeros((n_tok, 3), dtype="float64")
            for p, cidx in enumerate(passage_idx):
                c_vecs = cache["chunk_tok_vecs"][cidx]  # (m, 1024)
                if c_vecs.shape[0] == 0:
                    a_per_passage[:, p] = 0.0
                    continue
                sims = q_vecs @ c_vecs.T  # (n, m)
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

        weight_fallback = 0
        if n_tok > 0 and q_weights.sum() > 0:
            C_weighted = float((q_weights * a_i).sum() / q_weights.sum())
        else:
            C_weighted = C_mean
            weight_fallback = 1

        if n_tok > 0:
            median_w = np.median(q_weights)
            top_half_mask = q_weights >= median_w
            if top_half_mask.any():
                C_weighted_min = float(a_i[top_half_mask].min())
            else:
                C_weighted_min = C_min
        else:
            C_weighted_min = 0.0

        q_n_tokens = n_tok
        has_num = has_number(text)
        qword = classify_qword(text)
        yes_no = is_yes_no_query(text, qword)

        qword_counts[qword] = qword_counts.get(qword, 0) + 1
        if len(qword_examples.get(qword, [])) < 5:
            qword_examples.setdefault(qword, []).append((qid, text))
        yesno_counts[yes_no] += 1
        if len(yesno_examples[yes_no]) < 5:
            yesno_examples[yes_no].append((qid, text))

        sections = [chunk_section[c] for c in passage_cids]
        n_unique_sections = len(set(sections))
        top_section_same_12 = 1 if sections[0] == sections[1] else 0
        words_p = [len(chunks[chunk_id_to_idx[c]]["text"].split()) for c in passage_cids]
        words_total = sum(words_p)

        row = {
            "query_id": qid,
            # Block A
            "s1": s1, "s2": s2, "s3": s3, "s_mean": s_mean, "s_std": s_std,
            "gap12": gap12, "gap13": gap13, "gap23": gap23,
            # Block T
            "C_mean": C_mean, "C_min": C_min, "C_p25": C_p25,
            # Block S
            "C_single": C_single, "delta_C": delta_C, "C_rank1": C_rank1,
            "C_weighted": C_weighted, "C_weighted_min": C_weighted_min,
            "weight_fallback": weight_fallback,
            # Block Q
            "q_n_tokens": q_n_tokens, "has_number": has_num,
            "qword": qword, "is_yes_no": yes_no,
            # Block R
            "n_unique_sections": n_unique_sections,
            "top_section_same_12": top_section_same_12,
            "words_p1": words_p[0], "words_p2": words_p[1], "words_p3": words_p[2],
            "words_total": words_total,
        }
        rows.append(row)

        if len(example_alignments) < 3 and n_tok > 0:
            decoded = [tokenizer.convert_ids_to_tokens(t) for t in cache["query_tok_ids"][i]]
            example_alignments.append((qid, text, list(zip(decoded, [round(float(x), 4) for x in a_i]))))

    feature_time = time.time() - t0
    print(f"Feature computation done in {feature_time:.1f}s")

    features_df = pd.DataFrame(rows)

    float_cols = [c for c in features_df.columns
                  if c not in ("query_id", "qword", "weight_fallback", "has_number",
                               "is_yes_no", "q_n_tokens", "n_unique_sections",
                               "top_section_same_12", "words_p1", "words_p2", "words_p3",
                               "words_total")]
    for c in float_cols:
        features_df[c] = features_df[c].round(6)

    print("\n=== Block Q distribution ===")
    print("qword counts:", qword_counts)
    print("is_yes_no counts:", yesno_counts)
    for qw, examples in qword_examples.items():
        print(f"  qword={qw} examples:")
        for qid, text in examples:
            print(f"    {qid}: {text}")
    for yn, examples in yesno_examples.items():
        print(f"  is_yes_no={yn} examples:")
        for qid, text in examples:
            print(f"    {qid}: {text}")

    # ----------------------------------------------------------------- STEP 3
    print("\n=== STEP 3: writing outputs ===")
    features_df.to_csv(FEATURES_CSV, index=False, encoding="utf-8-sig")
    print(f"Wrote {FEATURES_CSV} ({len(features_df)} rows)")

    write_feature_dictionary()
    write_feature_blocks()

    total_time = time.time() - t_start_total
    timing = {
        "model_load_seconds": round(load_time, 3),
        "encode_and_cache_seconds": round(encode_time, 3),
        "feature_computation_seconds": round(feature_time, 3),
        "total_seconds": round(total_time, 3),
        "n_queries": len(queries_df),
        "per_query_encode_seconds": round(encode_time / len(queries_df), 5),
        "per_query_feature_seconds": round(feature_time / len(queries_df), 5),
    }
    TIMING_JSON.write_text(json.dumps(timing, indent=2), encoding="utf-8")
    print(f"Wrote {TIMING_JSON}")

    # ----------------------------------------------------------------- STEP 4
    run_checks(features_df, scores_df, sanity_ok)

    print("\n=== Example per-token alignments (3 queries) ===")
    for qid, text, pairs in example_alignments:
        print(f"\n{qid}: {text}")
        for tok, val in pairs:
            print(f"    {tok!r:20s} a[i]={val}")


def write_feature_dictionary():
    rows = [
        ("s1", "A", "retrieval_scores rank1 cosine similarity score"),
        ("s2", "A", "retrieval_scores rank2 cosine similarity score"),
        ("s3", "A", "retrieval_scores rank3 cosine similarity score"),
        ("s_mean", "A", "mean(s1,s2,s3)"),
        ("s_std", "A", "population std(s1,s2,s3)"),
        ("gap12", "A", "s1 - s2"),
        ("gap13", "A", "s1 - s3"),
        ("gap23", "A", "s2 - s3"),
        ("C_mean", "T", "mean over kept query tokens i of a[i] = max_p max_j cos(q_i, e_{p,j})"),
        ("C_min", "T", "min over kept query tokens i of a[i]"),
        ("C_p25", "T", "25th percentile over kept query tokens i of a[i]"),
        ("C_single", "S", "max over passages p of mean_i a[i,p] (best single-passage alignment)"),
        ("delta_C", "S", "C_mean - C_single (complementarity across passages)"),
        ("C_rank1", "S", "mean_i a[i,1] (alignment with top-ranked passage only)"),
        ("C_weighted", "S", "sum_i w_i*a[i] / sum_i w_i using BGE-M3 sparse lexical weights; falls back to C_mean if all weights are 0 (see weight_fallback)"),
        ("C_weighted_min", "S", "min of a[i] over tokens whose w_i is in the top half (>= median) of the query's weights"),
        ("weight_fallback", "S", "1 if all query token sparse weights were 0 and C_weighted fell back to C_mean, else 0"),
        ("q_n_tokens", "Q", "number of kept (non-special/padding/punctuation-only/space-marker) query tokens"),
        ("has_number", "Q", "1 if the query text contains an Arabic digit, else 0"),
        ("qword", "Q", "Sinhala question-word category: what/which/who/how/why/when/where/how_much/none (whole-word/phrase matched)"),
        ("is_yes_no", "Q", "1 if qword == none and the query (trailing ? and whitespace stripped) ends with 'ද', else 0"),
        ("n_unique_sections", "R", "number of distinct section_numbers among the 3 retrieved chunks"),
        ("top_section_same_12", "R", "1 if rank1 and rank2 chunks share the same section_number, else 0"),
        ("words_p1", "R", "word count of passage 1 (whitespace split on chunk text)"),
        ("words_p2", "R", "word count of passage 2"),
        ("words_p3", "R", "word count of passage 3"),
        ("words_total", "R", "words_p1 + words_p2 + words_p3"),
    ]
    lines = ["| feature | block | definition |", "|---|---|---|"]
    for name, block, defn in rows:
        lines.append(f"| {name} | {block} | {defn} |")
    FEATURE_DICT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {FEATURE_DICT_MD}")


def write_feature_blocks():
    block_A = ["s1", "s2", "s3", "s_mean", "s_std", "gap12", "gap13", "gap23"]
    block_T = ["C_mean", "C_min", "C_p25"]
    block_S = ["C_single", "delta_C", "C_rank1", "C_weighted", "C_weighted_min"]
    block_Q = ["q_n_tokens", "has_number", "qword", "is_yes_no"]
    block_R = ["n_unique_sections", "top_section_same_12", "words_p1", "words_p2", "words_p3", "words_total"]

    blocks = {
        "M0": ["s1"],
        "M1": block_A,
        "M2": block_A + block_T,
        "M3": block_A + block_T + block_S,
        "Q_only": block_Q,
        "M3+Q": block_A + block_T + block_S + block_Q,
        "M3+Q+R": block_A + block_T + block_S + block_Q + block_R,
    }
    FEATURE_BLOCKS_JSON.write_text(json.dumps(blocks, indent=2), encoding="utf-8")
    print(f"Wrote {FEATURE_BLOCKS_JSON}")


def run_checks(features_df, scores_df, sanity_ok):
    print("\n=== STEP 4: checks ===")

    expected_ids = [f"Q{i:03d}" for i in range(1, 401)]
    ids_ok = list(features_df["query_id"]) == expected_ids
    print(f"1. 400 rows, Q001-Q400, no dup, correct order: {'PASS' if ids_ok else 'FAIL'}")

    numeric_cols = features_df.select_dtypes(include=[np.number]).columns
    nan_inf = features_df[numeric_cols].isin([np.inf, -np.inf]).any().any() or features_df[numeric_cols].isna().any().any()
    print(f"2. No NaN/inf in any feature: {'PASS' if not nan_inf else 'FAIL'}")

    align_cols = ["C_mean", "C_min", "C_p25", "C_single", "C_rank1", "C_weighted", "C_weighted_min"]
    bounds_ok = True
    for c in align_cols:
        if not features_df[c].between(-1.0001, 1.0001).all():
            bounds_ok = False
    delta_ok = (features_df["delta_C"] >= -1e-6).all()
    order_ok = (features_df["C_min"] <= features_df["C_p25"] + 1e-6).all() and \
               (features_df["C_p25"] <= features_df["C_mean"] + 1e-6).all()
    print(f"3. Alignment in [-1,1], delta_C>=0, C_min<=C_p25<=C_mean: "
          f"{'PASS' if (bounds_ok and delta_ok and order_ok) else 'FAIL'} "
          f"(bounds_ok={bounds_ok}, delta_ok={delta_ok}, order_ok={order_ok})")

    merged = features_df.merge(scores_df, on="query_id", suffixes=("", "_sc"))
    s_match = (
        (merged["s1"].astype(float) - merged["rank1_score"].astype(float)).abs().lt(1e-6).all()
        and (merged["s2"].astype(float) - merged["rank2_score"].astype(float)).abs().lt(1e-6).all()
        and (merged["s3"].astype(float) - merged["rank3_score"].astype(float)).abs().lt(1e-6).all()
    )
    print(f"4. s1/s2/s3 equal retrieval_scores.csv exactly: {'PASS' if s_match else 'FAIL'}")

    print(f"5. Step 0 dense sanity check passed: {'PASS' if sanity_ok else 'FAIL'}")

    import subprocess
    try:
        git_out = subprocess.run(["git", "status", "--porcelain", "data", "index"],
                                  cwd=config.BASE_DIR, capture_output=True, text=True, timeout=30)
        git_clean = git_out.returncode == 0 and git_out.stdout.strip() == ""
        detail = git_out.stdout.strip() if git_out.stdout.strip() else "no changes"
        if "fatal" in git_out.stderr.lower() or git_out.returncode != 0:
            detail = f"git not available/not a repo here: {git_out.stderr.strip()[:200]}"
            git_clean = None
    except Exception as e:
        git_clean = None
        detail = f"git check skipped: {e}"
    print(f"6. git status clean under data/ and index/: "
          f"{'PASS' if git_clean else ('SKIPPED' if git_clean is None else 'FAIL')} ({detail})")

    print("\n--- Summary statistics (min / mean / max) ---")
    for c in numeric_cols:
        if c == "query_id":
            continue
        col = features_df[c].astype(float)
        print(f"  {c}: min={col.min():.6f} mean={col.mean():.6f} max={col.max():.6f}")


if __name__ == "__main__":
    main()

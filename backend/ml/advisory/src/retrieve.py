"""Given a query, return the Top-3 chunks with scores."""

import json
import sys

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

import config

_model = None
_index = None
_chunks = None


def _load():
    global _model, _index, _chunks
    if _model is None:
        _model = SentenceTransformer(config.EMBEDDING_MODEL)
        _model.max_seq_length = config.MAX_SEQ_LENGTH
    if _index is None:
        _index = faiss.read_index(str(config.FAISS_INDEX_PATH))
    if _chunks is None:
        with open(config.CHUNKS_JSON_PATH, "r", encoding="utf-8") as f:
            _chunks = json.load(f)
    return _model, _index, _chunks


def retrieve(query: str, k: int = config.TOP_K):
    model, index, chunks = _load()
    embedding = model.encode([query], normalize_embeddings=True)
    embedding = np.asarray(embedding, dtype="float32")
    scores, idxs = index.search(embedding, k)

    results = []
    for rank, (idx, score) in enumerate(zip(idxs[0], scores[0]), start=1):
        if idx < 0:
            continue
        chunk = chunks[idx]
        results.append(
            {
                "rank": rank,
                "chunk_id": chunk["chunk_id"],
                "section_number": chunk["section_number"],
                "section_title": chunk["section_title"],
                "score": float(score),
                "text": chunk["text"],
            }
        )
    return results


def main():
    if len(sys.argv) < 2:
        print('Usage: python src/retrieve.py "query text"')
        return
    query = sys.argv[1]
    results = retrieve(query, config.TOP_K)
    print(f"Query: {query}\n")
    for r in results:
        print(f"Rank {r['rank']} | {r['section_number']} {r['section_title']} | score={r['score']:.4f}")
        print(r["text"][:300])
        print("-" * 80)


if __name__ == "__main__":
    main()

"""All settings in one place: paths, embedding model name, max_seq_length, chunk size, overlap, top_k."""

from pathlib import Path

# backend/ml/advisory/
BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
QUERIES_DIR = DATA_DIR / "queries"

INDEX_DIR = BASE_DIR / "index"
OUTPUTS_DIR = BASE_DIR / "outputs"

QUERIES_MASTER_CSV = QUERIES_DIR / "queries_master.csv"
LABELING_SHEET_CSV = QUERIES_DIR / "labeling_sheet.csv"

FAISS_INDEX_PATH = INDEX_DIR / "faiss.index"
CHUNKS_JSON_PATH = INDEX_DIR / "chunks.json"
INDEX_CONFIG_JSON_PATH = INDEX_DIR / "config.json"

RETRIEVAL_TEST_CSV = OUTPUTS_DIR / "retrieval_test.csv"


def _find_kb_pdf() -> Path:
    pdfs = sorted(RAW_DIR.glob("*.pdf"))
    if len(pdfs) != 1:
        raise FileNotFoundError(
            f"Expected exactly one PDF in {RAW_DIR}, found {len(pdfs)}: "
            f"{[p.name for p in pdfs]}"
        )
    return pdfs[0]


KB_PDF = _find_kb_pdf()

EMBEDDING_MODEL = "BAAI/bge-m3"
MAX_SEQ_LENGTH = 512

CHUNK_SIZE_WORDS = 250
CHUNK_OVERLAP_WORDS = 50
MIN_SUBSECTION_WORDS = 0

TOP_K = 3

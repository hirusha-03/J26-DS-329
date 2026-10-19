"""Read the English guide PDF from data/raw/, clean the text, chunk it, embed with BGE-M3, save a FAISS index, chunks.json and config.json to index/."""

import json
import random
import re
from datetime import datetime, timezone

import faiss
import fitz  # pymupdf
import numpy as np
from sentence_transformers import SentenceTransformer

import config

HEADING_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+([A-Z][^\n]{2,70})$")
FIGURE_RE = re.compile(r"^Figure\s+\d+[.:]")
PAGE_NUM_RE = re.compile(r"^\d{1,4}$")
DOT_LEADER_RE = re.compile(r"\.{4,}\s*\d{1,3}$")
ACK_HEADING_WORDS = ("acknowledgement", "references")

# Figure captions (including their wrapped continuation lines) are set in a
# distinct font: italic, ~10pt, vs. 12pt body text / 14pt bold headings.
CAPTION_FONT_SIZE = 10


def _is_caption_span(span) -> bool:
    return "Italic" in span.get("font", "") and round(span.get("size", 0)) == CAPTION_FONT_SIZE


def extract_pages(pdf_path):
    """Return list of (page_number, raw_text) for each page, 1-indexed.
    Lines made up entirely of figure-caption spans (italic, ~10pt font,
    including multi-line wrapped captions) are dropped at extraction time,
    since font metadata identifies them reliably regardless of how many
    lines a caption wraps onto."""
    doc = fitz.open(pdf_path)
    pages = []
    for i, page in enumerate(doc):
        text_dict = page.get_text("dict")
        page_lines = []
        for block in text_dict["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                spans = line["spans"]
                if spans and all(_is_caption_span(s) for s in spans):
                    continue
                page_lines.append("".join(s["text"] for s in spans))
        pages.append((i + 1, "\n".join(page_lines)))
    doc.close()
    return pages


def dehyphenate(text: str) -> str:
    # a hyphen at a line end is kept as-is; only the line break is removed:
    # "September-\nOctober" -> "September-October", "30-\n35" -> "30-35".
    return re.sub(r"([A-Za-z0-9])-\n([A-Za-z0-9])", r"\1-\2", text)


def is_toc_line(line: str) -> bool:
    return bool(DOT_LEADER_RE.search(line)) or line.strip().lower() == "table of contents"


def build_line_stream(pages):
    """Produce a list of (page_number, line) tuples with page numbers, TOC,
    figure captions and the references/acknowledgements tail removed."""
    lines_out = []
    stop = False
    for page_num, raw in pages:
        if stop:
            break
        raw = dehyphenate(raw)
        for line in raw.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            if PAGE_NUM_RE.match(stripped):
                continue
            if is_toc_line(stripped):
                continue
            if FIGURE_RE.match(stripped):
                continue
            m = HEADING_RE.match(stripped)
            if m and any(w in stripped.lower() for w in ACK_HEADING_WORDS):
                stop = True
                break
            lines_out.append((page_num, stripped))
    return lines_out


def parse_sections(lines):
    """Group the line stream into a flat list of section units:
    {section_number, section_title, page_start, lines: [str, ...]}.

    A heading candidate is only accepted if its numbering continues the
    document's own numbering sequence:
      - a top-level number (e.g. "18") must be current_top + 1
      - a 2-level number (e.g. "17.1") must have top part == current_top
      - a 3-level number (e.g. "17.1.2") must have its "17.1" parent ==
        the currently active 2-level subsection
    This rejects numbered sub-step lists inside a section (e.g.
    "1. Killing the pods") that otherwise look exactly like a heading.
    """
    units = []
    current = None
    current_top = 0
    current_sub = None
    for page_num, line in lines:
        m = HEADING_RE.match(line)
        accepted = False
        if m:
            number = m.group(1)
            parts = number.split(".")
            if len(parts) == 1:
                if int(parts[0]) == current_top + 1:
                    accepted = True
                    current_top = int(parts[0])
                    current_sub = None
            elif len(parts) == 2:
                if int(parts[0]) == current_top:
                    accepted = True
                    current_sub = number
            else:
                parent = f"{parts[0]}.{parts[1]}"
                if parent == current_sub:
                    accepted = True
        if accepted:
            title = m.group(2).strip()
            current = {
                "section_number": number,
                "section_title": title,
                "page_start": page_num,
                "lines": [],
            }
            units.append(current)
        else:
            if current is None:
                # body text before the first detected heading; drop (title page etc.)
                continue
            current["lines"].append(line)
    return units


def word_count(text: str) -> int:
    return len(text.split())


def unit_text(unit) -> str:
    return re.sub(r"\s+", " ", " ".join(unit["lines"])).strip()


def is_top_level(section_number: str) -> bool:
    return "." not in section_number


def parent_of(section_number: str) -> str:
    return section_number.split(".")[0]


def merge_small_subsections(units):
    """Merge subsections with fewer than MIN_SUBSECTION_WORDS words with the
    next subsection under the same parent top-level section. Never merges
    across different top-level sections."""
    merged = []
    i = 0
    n = len(units)
    while i < n:
        group = [units[i]]
        parent = parent_of(units[i]["section_number"])
        text = unit_text(units[i])
        j = i
        while word_count(text) < config.MIN_SUBSECTION_WORDS and j + 1 < n:
            nxt = units[j + 1]
            if parent_of(nxt["section_number"]) != parent:
                break
            group.append(nxt)
            j += 1
            text = " ".join(unit_text(u) for u in group)
        merged.append(group)
        i = j + 1
    return merged


def contains_table(text: str) -> bool:
    return "District Offices and Contact Directory" in text


def windows(words, size, overlap):
    if not words:
        return []
    step = max(size - overlap, 1)
    result = []
    start = 0
    while start < len(words):
        end = min(start + size, len(words))
        result.append(words[start:end])
        if end == len(words):
            break
        start += step
    return result


def build_chunks(groups):
    chunks = []
    chunk_idx = 0
    for group in groups:
        section_numbers = ";".join(u["section_number"] for u in group)
        headings = [f"{u['section_number']} {u['section_title']}" for u in group]
        heading_prefix = " | ".join(headings)
        page_start = group[0]["page_start"]
        body = " ".join(unit_text(u) for u in group).strip()
        full_title = "; ".join(u["section_title"] for u in group)

        if contains_table(body) or word_count(body) <= config.CHUNK_SIZE_WORDS:
            pieces = [body.split()]
        else:
            pieces = windows(body.split(), config.CHUNK_SIZE_WORDS, config.CHUNK_OVERLAP_WORDS)

        for piece_words in pieces:
            piece_text = " ".join(piece_words)
            text = f"{heading_prefix}\n{piece_text}".strip()
            chunk_idx += 1
            chunks.append(
                {
                    "chunk_id": f"chunk_{chunk_idx:04d}",
                    "section_number": section_numbers,
                    "section_title": full_title,
                    "page_start": page_start,
                    "n_words": word_count(text),
                    "text": text,
                }
            )
    return chunks


def main():
    pages = extract_pages(config.KB_PDF)
    lines = build_line_stream(pages)
    units = parse_sections(lines)
    groups = merge_small_subsections(units)
    chunks = build_chunks(groups)

    model = SentenceTransformer(config.EMBEDDING_MODEL)
    model.max_seq_length = config.MAX_SEQ_LENGTH

    texts = [c["text"] for c in chunks]
    embeddings = model.encode(
        texts,
        batch_size=8,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    embeddings = np.asarray(embeddings, dtype="float32")

    dim = embeddings.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(embeddings)

    config.INDEX_DIR.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(config.FAISS_INDEX_PATH))

    with open(config.CHUNKS_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    index_config = {
        "model": config.EMBEDDING_MODEL,
        "max_seq_length": config.MAX_SEQ_LENGTH,
        "chunk_size_words": config.CHUNK_SIZE_WORDS,
        "chunk_overlap_words": config.CHUNK_OVERLAP_WORDS,
        "min_subsection_words": config.MIN_SUBSECTION_WORDS,
        "top_k": config.TOP_K,
        "n_chunks": len(chunks),
        "pdf_file": config.KB_PDF.name,
        "build_timestamp": datetime.now(timezone.utc).isoformat(),
        "frozen": False,
    }
    with open(config.INDEX_CONFIG_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(index_config, f, ensure_ascii=False, indent=2)

    n_words = [c["n_words"] for c in chunks]
    print(f"Number of chunks: {len(chunks)}")
    print(f"Average words per chunk: {sum(n_words) / len(n_words):.1f}")
    print(f"Min words per chunk: {min(n_words)}")
    print(f"Max words per chunk: {max(n_words)}")
    print("Section numbers per chunk:")
    for c in chunks:
        print(f"  {c['chunk_id']}: {c['section_number']} - {c['section_title']}")

    print("\n3 random chunks in full:")
    random.seed(42)
    sample = random.sample(chunks, min(3, len(chunks)))
    for c in sample:
        print("-" * 80)
        print(f"chunk_id: {c['chunk_id']}")
        print(f"section_number: {c['section_number']}")
        print(f"section_title: {c['section_title']}")
        print(f"page_start: {c['page_start']}")
        print(f"n_words: {c['n_words']}")
        print("text:")
        print(c["text"])


if __name__ == "__main__":
    main()

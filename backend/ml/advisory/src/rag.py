"""Query -> Top-3 passages -> (Sinhala-only) sufficiency check -> LLM answer.

Reuses, without duplicating:
  - config.py                for all paths
  - features.py               for token filtering / qword / yes-no / has_number
  - outputs/cache/*.pkl        for the frozen 92-chunk BGE-M3 colbert token vectors
  - outputs/models/*.joblib    for the trained M3+Q LR sufficiency classifier
  - outputs/models/model_card.json  for the decision threshold

Must be run with .venv-features (FlagEmbedding + openai + python-dotenv):
    .venv-features/Scripts/python.exe src/rag.py "<question>"

Set HF_HUB_OFFLINE=1 before importing FlagEmbedding/transformers so the
existing local BGE-M3 snapshot is used and nothing is downloaded.
"""

import argparse
import json
import os
import pickle
import re
import sys
import time
import urllib.request
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import joblib
import numpy as np
import pandas as pd

import config
import features as feat  # reuse is_kept_token / classify_qword / is_yes_no_query / has_number

SINHALA_RANGE = (0x0D80, 0x0DFF)

MODELS_DIR = config.OUTPUTS_DIR / "models"
MODEL_PATH = MODELS_DIR / "sufficiency_lr_m3q.joblib"
MODEL_CARD_PATH = MODELS_DIR / "model_card.json"
FEATURE_BLOCKS_JSON = config.OUTPUTS_DIR / "feature_blocks.json"
CACHE_DIR = config.OUTPUTS_DIR / "cache"
DEMO_CACHE_JSONL = config.OUTPUTS_DIR / "demo_cache.jsonl"

ENV_PATH = config.BASE_DIR.parent.parent / ".env"  # backend/.env

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

SOURCE_SI_PHRASE = "පද්ධතියේ ඇති වැනිලා වගා තොරතුරු"
SOURCE_EN_PHRASE = "the vanilla information in this system"
FORBIDDEN_PHRASES = [
    "ලබා දී ඇති තොරතුරු", "ලබාදී ඇති", "සපයා ඇති", "ලබාගත් තොරතුරු",
    "මෙම ඡේද", "ඡේදවල", "මෙහි", "සාක්ෂි", "passages", "context",
    "provided information", "provided text",
]
FALLBACK_SI_NOTE = (
    "(සටහන: LLM සේවාවට සම්බන්ධ විය නොහැකි විය. පහත පිළිතුර ලබාගත් ඉහළම අදාළ කොටසින් සකස් කර ඇත.)"
)
FALLBACK_EN_NOTE = (
    "(Note: could not reach the LLM service. The answer below is built directly from the "
    "top matching passage. Please confirm with an agricultural officer for more detail.)"
)

SMALL_TALK_SI_GREETING = (
    "ආයුබෝවන්! මම වැනිලා වගාව පිළිබඳ තොරතුරු සහ උපදෙස් ලබා දීම සඳහා නිර්මාණය කළ උපදේශන "
    "පද්ධතියකි. ඔබේ වැනිලා වගාව පිළිබඳ ප්‍රශ්නය සිංහලෙන් අසන්න."
)
SMALL_TALK_SI_THANKS = "ඔබටත් ස්තූතියි! වැනිලා වගාව පිළිබඳ වෙනත් ප්‍රශ්නයක් ඇත්නම් අසන්න."
SMALL_TALK_SI_GOODBYE = "ස්තූතියි! ඔබේ වැනිලා වගාවට සුබ පැතුම්!"
SMALL_TALK_EN_GREETING = (
    "Hello! I'm the vanilla cultivation advisory assistant. Please ask your question "
    "about vanilla cultivation."
)
SMALL_TALK_EN_THANKS = "You're welcome! Feel free to ask anything else about vanilla cultivation."
SMALL_TALK_EN_GOODBYE = "Goodbye, and best wishes for your vanilla crop!"

SMALL_TALK_SI_GREETINGS = [
    "ආයුබෝවන්", "හලෝ", "හායි", "සුබ උදෑසනක්", "සුබ දවසක්", "සුබ සන්ධ්‍යාවක්",
]
SMALL_TALK_SI_THANKS_PHRASES = ["ස්තූතියි", "ස්තුතියි", "බොහොම ස්තූතියි", "බොහොම ස්තුතියි"]
SMALL_TALK_SI_IDENTITY = ["ඔයා කවුද", "ඔබ කවුද", "ඔයාට මොනවද කරන්න පුළුවන්"]
SMALL_TALK_SI_GOODBYE_PHRASES = ["ගිහින් එන්නම්", "බායි"]

SMALL_TALK_EN_GREETINGS = ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"]
SMALL_TALK_EN_THANKS_PHRASES = ["thanks", "thank you", "thank you very much"]
SMALL_TALK_EN_IDENTITY = ["who are you", "what can you do"]
SMALL_TALK_EN_GOODBYE_PHRASES = ["bye", "goodbye"]


def detect_language(query: str) -> str:
    for ch in query:
        if SINHALA_RANGE[0] <= ord(ch) <= SINHALA_RANGE[1]:
            return "si"
    return "en"


def _normalize_small_talk(query: str) -> str:
    text = query.strip().lower()
    for ch in "?!.,":
        text = text.replace(ch, "")
    return re.sub(r"\s+", " ", text).strip()


def _small_talk_reply(query: str, language: str):
    normalized = _normalize_small_talk(query)
    if not normalized or len(normalized.split()) > 5:
        return None

    def matches(phrases):
        return any(
            normalized == p.strip().lower() or normalized.startswith(p.strip().lower())
            for p in phrases
        )

    if language == "si":
        if matches(SMALL_TALK_SI_GREETINGS) or matches(SMALL_TALK_SI_IDENTITY):
            return SMALL_TALK_SI_GREETING
        if matches(SMALL_TALK_SI_THANKS_PHRASES):
            return SMALL_TALK_SI_THANKS
        if matches(SMALL_TALK_SI_GOODBYE_PHRASES):
            return SMALL_TALK_SI_GOODBYE
    else:
        if matches(SMALL_TALK_EN_GREETINGS) or matches(SMALL_TALK_EN_IDENTITY):
            return SMALL_TALK_EN_GREETING
        if matches(SMALL_TALK_EN_THANKS_PHRASES):
            return SMALL_TALK_EN_THANKS
        if matches(SMALL_TALK_EN_GOODBYE_PHRASES):
            return SMALL_TALK_EN_GOODBYE
    return None


def _strip_greeting_or_thanks(query: str, language: str) -> str:
    """Remove a leading greeting or a trailing thanks phrase (plus any
    following/preceding comma, '!', '.' or spaces) so the rest of the
    question can go through the normal pipeline."""
    if language == "si":
        start_phrases = SMALL_TALK_SI_GREETINGS
        end_phrases = ["ස්තූතියි", "ස්තුතියි", "බොහොම ස්තූතියි"]
    else:
        start_phrases = SMALL_TALK_EN_GREETINGS
        end_phrases = ["thanks", "thank you"]

    cleaned = query.strip()

    for phrase in sorted(start_phrases, key=len, reverse=True):
        haystack = cleaned if language == "si" else cleaned.lower()
        needle = phrase if language == "si" else phrase.lower()
        if haystack.startswith(needle):
            rest = cleaned[len(phrase):]
            rest = re.sub(r"^[,!.\s]+", "", rest)
            if rest.strip():
                cleaned = rest
            break

    for phrase in sorted(end_phrases, key=len, reverse=True):
        haystack = cleaned if language == "si" else cleaned.lower()
        needle = phrase if language == "si" else phrase.lower()
        if haystack.endswith(needle):
            head = cleaned[: len(cleaned) - len(phrase)]
            head = re.sub(r"[,!.\s]+$", "", head)
            if head.strip():
                cleaned = head
            break

    return cleaned.strip()


def _load_env(path: Path) -> dict:
    """Minimal .env loader (KEY=VALUE lines) for an explicit path. Avoids
    python-dotenv's implicit cwd search; never prints values."""
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def print_available_models():
    """Step 0: list OpenRouter model IDs + pricing for Gemini Flash,
    Claude Haiku/Sonnet, and GPT mini models. No API key required."""
    req = urllib.request.Request(f"{OPENROUTER_BASE_URL}/models")
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)["data"]

    patterns = [
        ("Google Gemini Flash", re.compile(r"google/.*gemini.*flash", re.I)),
        ("Anthropic Claude Haiku/Sonnet", re.compile(r"anthropic/.*claude.*(haiku|sonnet)", re.I)),
        ("OpenAI GPT mini", re.compile(r"openai/.*gpt.*mini", re.I)),
    ]
    for label, pattern in patterns:
        print(f"\n=== {label} ===")
        matches = [m for m in data if pattern.search(m["id"])]
        for m in sorted(matches, key=lambda x: x["id"]):
            pricing = m.get("pricing", {})
            prompt_price = pricing.get("prompt", "?")
            completion_price = pricing.get("completion", "?")
            print(f"  {m['id']:<45} prompt={prompt_price}/tok  completion={completion_price}/tok")
        if not matches:
            print("  (none found)")


class AdvisoryRAG:
    def __init__(self):
        t0 = time.time()

        from FlagEmbedding import BGEM3FlagModel
        import faiss

        self.embed_model = BGEM3FlagModel(config.EMBEDDING_MODEL, use_fp16=False)
        self.tokenizer = self.embed_model.tokenizer
        self.special_tokens = frozenset(self.tokenizer.all_special_tokens)

        self.index = faiss.read_index(str(config.FAISS_INDEX_PATH))
        with open(config.CHUNKS_JSON_PATH, "r", encoding="utf-8") as f:
            self.chunks = json.load(f)

        with open(CACHE_DIR / "chunk_tok_vecs.pkl", "rb") as f:
            self.chunk_tok_vecs = pickle.load(f)

        self.sufficiency_model = joblib.load(MODEL_PATH)
        with open(MODEL_CARD_PATH, "r", encoding="utf-8") as f:
            model_card = json.load(f)
        self.threshold = float(model_card["decision_threshold"])

        with open(FEATURE_BLOCKS_JSON, "r", encoding="utf-8") as f:
            blocks = json.load(f)
        self.m3q_cols = blocks["M3+Q"]

        env = _load_env(ENV_PATH)
        api_key = env.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
        self.llm_model = env.get("ADVISORY_LLM_MODEL") or os.environ.get("ADVISORY_LLM_MODEL")
        self.llm_client = None
        if api_key:
            from openai import OpenAI

            self.llm_client = OpenAI(base_url=OPENROUTER_BASE_URL, api_key=api_key)

        self.load_time_s = time.time() - t0

    # ------------------------------------------------------------------
    # Retrieval
    # ------------------------------------------------------------------
    def _encode_query(self, query: str):
        out = self.embed_model.encode(
            [query], max_length=feat.MAX_LENGTH,
            return_dense=True, return_sparse=True, return_colbert_vecs=True,
        )
        dense = np.asarray(out["dense_vecs"], dtype="float32")
        dense = dense / np.linalg.norm(dense, axis=1, keepdims=True)

        enc = self.tokenizer(query, truncation=True, max_length=feat.MAX_LENGTH)
        ids = enc["input_ids"][1:]  # drop CLS id to align with colbert_vecs (see features.py)
        colbert_vecs = np.asarray(out["colbert_vecs"][0], dtype="float32")
        lexical_weights = out["lexical_weights"][0]

        kept_idx = [
            j for j in range(len(ids))
            if feat.is_kept_token(self.tokenizer.convert_ids_to_tokens(ids[j]), self.special_tokens)
        ]
        kept_vecs = colbert_vecs[kept_idx]
        norms = np.linalg.norm(kept_vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        kept_vecs = kept_vecs / norms
        kept_ids = [ids[j] for j in kept_idx]
        kept_weights = np.asarray(
            [float(lexical_weights.get(str(tid), 0.0)) for tid in kept_ids], dtype="float64"
        )
        return dense, kept_vecs, kept_weights

    def retrieve(self, dense, k=config.TOP_K):
        scores, idxs = self.index.search(dense, k)
        results = []
        for rank, (idx, score) in enumerate(zip(idxs[0], scores[0]), start=1):
            if idx < 0:
                continue
            chunk = self.chunks[idx]
            results.append(
                {
                    "rank": rank,
                    "chunk_idx": int(idx),
                    "chunk_id": chunk["chunk_id"],
                    "section": f"{chunk['section_number']} {chunk['section_title']}".strip(),
                    "score": float(score),
                    "text": chunk["text"],
                }
            )
        return results

    # ------------------------------------------------------------------
    # Sufficiency features (same formulas as features.py's per-query loop;
    # text-level helpers imported directly from features.py)
    # ------------------------------------------------------------------
    def _sufficiency_features(self, query: str, passages, q_vecs, q_weights):
        s1, s2, s3 = (p["score"] for p in passages)
        s_mean = (s1 + s2 + s3) / 3.0
        s_std = float(np.std([s1, s2, s3]))
        gap12, gap13, gap23 = s1 - s2, s1 - s3, s2 - s3

        n_tok = q_vecs.shape[0]
        if n_tok == 0:
            a_per_passage = np.zeros((0, 3), dtype="float64")
        else:
            a_per_passage = np.zeros((n_tok, 3), dtype="float64")
            for p, passage in enumerate(passages):
                c_vecs = self.chunk_tok_vecs[passage["chunk_idx"]]
                if c_vecs.shape[0] == 0:
                    continue
                sims = q_vecs @ c_vecs.T
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

        if n_tok > 0 and q_weights.sum() > 0:
            C_weighted = float((q_weights * a_i).sum() / q_weights.sum())
        else:
            C_weighted = C_mean

        if n_tok > 0:
            median_w = np.median(q_weights)
            top_half_mask = q_weights >= median_w
            C_weighted_min = float(a_i[top_half_mask].min()) if top_half_mask.any() else C_min
        else:
            C_weighted_min = 0.0

        qword = feat.classify_qword(query)
        row = {
            "s1": s1, "s2": s2, "s3": s3, "s_mean": s_mean, "s_std": s_std,
            "gap12": gap12, "gap13": gap13, "gap23": gap23,
            "C_mean": C_mean, "C_min": C_min, "C_p25": C_p25,
            "C_single": C_single, "delta_C": delta_C, "C_rank1": C_rank1,
            "C_weighted": C_weighted, "C_weighted_min": C_weighted_min,
            "q_n_tokens": n_tok, "has_number": feat.has_number(query),
            "qword": qword, "is_yes_no": feat.is_yes_no_query(query, qword),
        }
        # features.py rounds all float columns to 6 decimals before writing
        # features.csv, and the model was trained on those rounded values -
        # round identically here so live predictions match training exactly.
        for k in row:
            if k not in ("q_n_tokens", "has_number", "qword", "is_yes_no"):
                row[k] = round(row[k], 6)
        return row

    def predict_sufficiency(self, query, passages, q_vecs, q_weights):
        row = self._sufficiency_features(query, passages, q_vecs, q_weights)
        X = pd.DataFrame([row])[self.m3q_cols]
        p = float(self.sufficiency_model.predict_proba(X)[0, 1])
        return p, row

    # ------------------------------------------------------------------
    # LLM answer
    # ------------------------------------------------------------------
    @staticmethod
    def _format_passages(passages):
        return "\n\n".join(
            f"[{p['rank']}] ({p['section']})\n{p['text']}" for p in passages
        )

    def _build_messages(self, query, mode, passages):
        passages_text = self._format_passages(passages)
        common = (
            "Use ONLY the given passages as your source of facts. Never add outside "
            "knowledge or guess. Answer the farmer's exact question completely: give "
            "the direct answer, and add the reason or one short caution ONLY if it "
            "directly affects how the farmer acts on this specific answer. Do not add "
            "other facts about the same topic that answer a different question (for "
            "example, when asked about the best time to pollinate, do not explain "
            "which flowers to choose). Never mention that a detail is missing unless "
            "the farmer explicitly asked for that detail. A detail is missing ONLY if "
            "the farmer explicitly asked for it and it is not in the passages. Name "
            "exactly what was asked, taken from the question itself (an amount, a cost, "
            "a frequency, a time, a specific condition such as the vine's age or "
            "season). Never name a detail the farmer did not ask for (e.g. do not say "
            "an amount is missing when the farmer asked which fertilizers to use). When "
            "a detail is missing, use exactly this sentence pattern: '[the specific "
            "thing asked] පිළිබඳ තොරතුරු පද්ධතියේ සඳහන් නොවේ.' Never tell the farmer to "
            "consult, meet or ask an agriculture officer, extension officer or anyone "
            "else. Use simple, farmer-friendly language. Keep the [1], [2], [3] "
            "citations where relevant. "
            "If the question is about vanilla cultivation but does not mention the word "
            "'vanilla' (වැනිලා), begin the answer with 'වැනිලා වගාව සම්බන්ධයෙන්, '. "
            "If the question asks about a crop other than vanilla, say that this system "
            "only covers vanilla cultivation and give no advice about the other crop. "
            "Never write a sentence like 'එම නිසා මෙම ප්‍රශ්නයට පිළිතුරු දීමට තොරතුරු "
            "ප්‍රමාණවත් නොවේ'. Never use the words/phrases: ලබා දී ඇති තොරතුරු, ලබාදී ඇති, "
            "සපයා ඇති, ලබාගත් තොරතුරු, මෙම ඡේද, ඡේදවල, මෙහි, සාක්ෂි, passages, context, "
            "provided information, provided text. When you need to refer to the source "
            "of your facts, call it 'පද්ධතියේ ඇති වැනිලා වගා තොරතුරු' in Sinhala (natural "
            "inflections like 'තොරතුරු වල' / 'තොරතුරු වලට අනුව' are fine), or "
            "'the vanilla information in this system' in English. For applying "
            "fertilizer use 'යෙදිය යුතු', not 'දැමිය යුතු'. Write the answer as one "
            "flowing paragraph (use a second paragraph only if the question itself "
            "has several parts), like a natural explanation. "
            "Do NOT use bullet points, numbered lists, asterisks (*), dashes as list "
            "markers, headings, bold or any Markdown formatting. Join multiple points "
            "into sentences."
        )
        if mode == "confident":
            system = (
                common + " Answer fully and directly in Sinhala - the passages contain "
                "enough information to answer confidently, so do NOT add any closing "
                "sentence beyond the EXCEPTION below. Do NOT start the answer "
                "with, or include, 'පද්ධතියේ ඇති වැනිලා වගා තොරතුරු වලට අනුව' or any "
                "similar 'according to the system's information' phrasing - just give "
                "the answer directly. EXCEPTION: if the farmer asked for a specific "
                "detail that is genuinely not in the passages, give the rest of the "
                "answer and then end the whole answer with exactly this pattern, "
                "naming the specific thing asked: "
                "'නමුත් [the specific thing asked] පිළිබඳ තොරතුරු පද්ධතියේ සඳහන් නොවේ.'"
            )
        elif mode == "cautious":
            system = (
                common + " Answer in Sinhala, giving ONLY the parts of the answer that "
                "are clearly supported by the passages - never guess or fill gaps. "
                "Use exactly ONE of these three patterns, chosen as follows: "
                "(1) If the farmer's question is fully answered by the passages, phrase "
                "the whole answer as: 'පද්ධතියේ ඇති වැනිලා වගා තොරතුරු වලට අනුව, [full "
                "answer].' with no closing sentence. "
                "(2) Use this when part of what was asked is not covered, OR when the "
                "passages give a GENERAL answer that applies to the farmer's case (e.g. "
                "vanilla vines in general) but nothing SPECIFIC to the condition they "
                "mentioned (age, stage, season, size, etc.). Give the general/supported "
                "answer, then name only the specific missing part, phrasing the whole "
                "answer as: 'පද්ධතියේ ඇති වැනිලා වගා තොරතුරු වලට අනුව, [supported/general "
                "answer]. නමුත් [the specific thing asked] පිළිබඳ තොරතුරු පද්ධතියේ සඳහන් "
                "නොවේ.' "
                "(3) Use ONLY when nothing relevant to the question is available. Reply "
                "only with: '[the specific thing asked] පිළිබඳ තොරතුරු පද්ධතියේ සඳහන් "
                "නොවේ.' "
                "Never combine more than one of these patterns in the same answer."
            )
        else:  # english
            system = (
                common + " Answer in English, using only the passages, as one flowing "
                "paragraph of plain prose (no bullets, lists or Markdown). This overrides "
                "any earlier rule about missing details. Give whatever the passages say "
                "that answers the question, fully or partly. NEVER mention, list or hint "
                "at anything that is missing, not mentioned, not covered or not provided, "
                "even if the farmer asked for it; simply leave those parts out. Do NOT "
                "add any officer/extension-officer or verification sentence. Never guess "
                "or use outside knowledge. Only if NOTHING in the passages is relevant "
                "to the question, reply with exactly: 'This is not covered in the "
                "vanilla information in this system.' and nothing else."
            )
        user = f"Question: {query}\n\nPassages:\n{passages_text}"
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

    @staticmethod
    def _sanitize_forbidden_phrases(text, language):
        source_phrase = SOURCE_SI_PHRASE if language == "si" else SOURCE_EN_PHRASE
        for phrase in FORBIDDEN_PHRASES:
            if phrase in text:
                text = text.replace(phrase, source_phrase)
        return text

    @staticmethod
    def _clean_english_answer(text):
        fixed = "This is not covered in the vanilla information in this system."
        if text.strip() == fixed:
            return text
        missing_markers = [
            "not mentioned", "not covered", "not provided", "not stated",
            "not specified", "not included", "not available", "does not mention",
            "doesn't mention", "no information", "not in the vanilla information",
            "consult", "extension officer", "agriculture officer",
        ]
        sentences = re.split(r"(?<=[.!?])\s+", text.strip())
        kept = []
        for sentence in sentences:
            lowered = sentence.lower()
            if any(marker in lowered for marker in missing_markers):
                continue
            kept.append(sentence)
        if not kept:
            return fixed
        return " ".join(kept)

    def _fallback_answer(self, language, passages):
        top = passages[0]
        if language == "si":
            text = f"[1] ({top['section']}) ට අනුව: {top['text'][:400]}\n\n{FALLBACK_SI_NOTE}"
        else:
            text = f"According to [1] ({top['section']}): {top['text'][:400]}\n\n{FALLBACK_EN_NOTE}"
        return self._sanitize_forbidden_phrases(text, language)

    def _call_llm(self, query, mode, passages, model=None):
        if self.llm_client is None:
            raise RuntimeError("no_api_key")
        messages = self._build_messages(query, mode, passages)
        resp = self.llm_client.chat.completions.create(
            model=model or self.llm_model, messages=messages, temperature=0.2,
            max_tokens=800, extra_body={"reasoning": {"effort": "low"}},
        )
        return resp.choices[0].message.content.strip()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def answer(self, query: str, model: str = None) -> dict:
        timings = {}
        t_total0 = time.time()

        language = detect_language(query)

        small_talk_text = _small_talk_reply(query, language)
        if small_talk_text is not None:
            timings["total_ms"] = round((time.time() - t_total0) * 1000, 1)
            return {
                "query": query,
                "query_used": query,
                "language": language,
                "mode": "smalltalk",
                "p_sufficient": None,
                "threshold": self.threshold,
                "answer_text": small_talk_text,
                "llm_model": None,
                "llm_error": None,
                "passages": [],
                "timings_ms": timings,
            }

        query_used = _strip_greeting_or_thanks(query, language)
        if not query_used:
            query_used = query

        t0 = time.time()
        dense, q_vecs, q_weights = self._encode_query(query_used)
        timings["encode_ms"] = round((time.time() - t0) * 1000, 1)

        t0 = time.time()
        passages = self.retrieve(dense)
        timings["retrieve_ms"] = round((time.time() - t0) * 1000, 1)

        p_sufficient = None
        if language == "si":
            t0 = time.time()
            row = None
            t1 = time.time()
            p_sufficient, row = self.predict_sufficiency(query_used, passages, q_vecs, q_weights)
            timings["features_ms"] = round((time.time() - t0) * 1000, 1)
            timings["predict_ms"] = round((time.time() - t1) * 1000, 1)
            mode = "confident" if p_sufficient >= self.threshold else "cautious"
        else:
            timings["features_ms"] = 0.0
            timings["predict_ms"] = 0.0
            mode = "english"

        t0 = time.time()
        llm_error = None
        try:
            answer_text = self._call_llm(query_used, mode, passages, model=model)
            answer_text = self._sanitize_forbidden_phrases(answer_text, language)
            if language == "en":
                answer_text = self._clean_english_answer(answer_text)
        except Exception as e:  # network / credits / model / key errors -> fallback, never crash
            llm_error = type(e).__name__
            answer_text = self._fallback_answer(language, passages)
        timings["llm_ms"] = round((time.time() - t0) * 1000, 1)

        timings["total_ms"] = round((time.time() - t_total0) * 1000, 1)

        return {
            "query": query,
            "query_used": query_used,
            "language": language,
            "mode": mode,
            "p_sufficient": p_sufficient,
            "threshold": self.threshold,
            "answer_text": answer_text,
            "llm_model": model or self.llm_model,
            "llm_error": llm_error,
            "passages": [
                {
                    "rank": p["rank"], "chunk_id": p["chunk_id"], "section": p["section"],
                    "score": p["score"], "text": p["text"],
                }
                for p in passages
            ],
            "timings_ms": timings,
        }


def _save_demo_cache(result: dict):
    DEMO_CACHE_JSONL.parent.mkdir(parents=True, exist_ok=True)
    with open(DEMO_CACHE_JSONL, "a", encoding="utf-8") as f:
        f.write(json.dumps(result, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("query", nargs="?", help="Question text")
    parser.add_argument("--save", action="store_true", help="Append result to outputs/demo_cache.jsonl")
    parser.add_argument("--list-models", action="store_true", help="Print OpenRouter model IDs + pricing and exit")
    args = parser.parse_args()

    if args.list_models:
        print_available_models()
        return

    if not args.query:
        print('Usage: python src/rag.py "<question>" [--save]')
        return

    rag = AdvisoryRAG()
    print(f"Model load time: {rag.load_time_s:.1f}s", file=sys.stderr)

    result = rag.answer(args.query)
    if args.save:
        _save_demo_cache(result)

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

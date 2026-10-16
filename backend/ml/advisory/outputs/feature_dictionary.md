| feature | block | definition |
|---|---|---|
| s1 | A | retrieval_scores rank1 cosine similarity score |
| s2 | A | retrieval_scores rank2 cosine similarity score |
| s3 | A | retrieval_scores rank3 cosine similarity score |
| s_mean | A | mean(s1,s2,s3) |
| s_std | A | population std(s1,s2,s3) |
| gap12 | A | s1 - s2 |
| gap13 | A | s1 - s3 |
| gap23 | A | s2 - s3 |
| C_mean | T | mean over kept query tokens i of a[i] = max_p max_j cos(q_i, e_{p,j}) |
| C_min | T | min over kept query tokens i of a[i] |
| C_p25 | T | 25th percentile over kept query tokens i of a[i] |
| C_single | S | max over passages p of mean_i a[i,p] (best single-passage alignment) |
| delta_C | S | C_mean - C_single (complementarity across passages) |
| C_rank1 | S | mean_i a[i,1] (alignment with top-ranked passage only) |
| C_weighted | S | sum_i w_i*a[i] / sum_i w_i using BGE-M3 sparse lexical weights; falls back to C_mean if all weights are 0 (see weight_fallback) |
| C_weighted_min | S | min of a[i] over tokens whose w_i is in the top half (>= median) of the query's weights |
| weight_fallback | S | 1 if all query token sparse weights were 0 and C_weighted fell back to C_mean, else 0 |
| q_n_tokens | Q | number of kept (non-special/padding/punctuation-only/space-marker) query tokens |
| has_number | Q | 1 if the query text contains an Arabic digit, else 0 |
| qword | Q | Sinhala question-word category: what/how/why/when/where/how_much/none |
| is_yes_no | Q | 1 if qword == none and the query (trailing ? and whitespace stripped) ends with 'ද', else 0 |
| n_unique_sections | R | number of distinct section_numbers among the 3 retrieved chunks |
| top_section_same_12 | R | 1 if rank1 and rank2 chunks share the same section_number, else 0 |
| words_p1 | R | word count of passage 1 (whitespace split on chunk text) |
| words_p2 | R | word count of passage 2 |
| words_p3 | R | word count of passage 3 |
| words_total | R | words_p1 + words_p2 + words_p3 |

# M1 local field dataset: collection round 1

**Date captured:** 11 Oct 2026 (about 10:36 to 15:46)
**Collected by:** Nawodya. Zones C and D only.
**Processed:** 12 Oct 2026

## Contents
| Block | Marked vines (photographed) | Photos |
|---|---|---|
| C1 | V01–V08 | 31 |
| C2 | V01, V02, V05, V06, V07, V08 | 27 |
| C3 | V01, "V01b" (zip named 1-1), V03 | 18 |
| D1 | V02, V04, V06, + V08/09/10 combined | 29 |
| D2 | V01–V10 | 49 |
| Unmarked (block inferred from time) | 8 groups | 22 |
| Extras sent in chat (vine unknown) | — | 7 |
| **Total** | **31 marked vine groups** | **183** |

## Processing
- Photos arrived as WhatsApp exports. WhatsApp **removed EXIF metadata** (no capture time or GPS) and **downscaled** the images (720×1280 / 900×1600).
- Vine ID comes from the zip file name, as reported by the collector.
- WhatsApp file times (send times on 11 Oct) were used to order the photos. They were also used to infer the likely block of the unmarked photos (marked `?` in metadata).
- 6 duplicate photos were removed: the D1 "8-9-10" zip contained re-sent copies of D2-V01 and of the unmarked group U03 (matched by perceptual hash).
- Unmarked group U03 was forwarded together with the D2-V01 photos, so it may belong to D2-V01.
- `observer_note_NOT_A_LABEL` holds descriptive notes for triage only. **Ground-truth labels come only from `supervisor_label`.**

## Known limitations
1. Zones A and B are not yet collected.
2. Original full-resolution files with EXIF are still to be copied from the phone.
3. D1 vines 8, 9 and 10 were sent as one batch and still need to be split.
4. Some photos contain hands, people, or measuring tape. These should be excluded from training or kept as context only.
5. Multiple photos of the same leaf are included (e.g. C3-V03_05..09). Splits must be grouped by vine.

## Next round protocol changes
- Take a tag photo first for every vine.
- Transfer photos by USB or Google Photos, not WhatsApp.
- Take more stem and base photos, since stem rot is the main target.

## Metadata schema v2 (`metadata.csv`)
One row per photo (183 rows).

| Column | Meaning |
|---|---|
| `path` | Image path relative to the dataset root |
| `new_filename` | `YYYYMMDD_<group>_<nn>.jpg` |
| `group_id` | Photo group: vine ID (`C1-V01`), unmarked group (`U01`–`U08`) or `EXTRA` |
| `vine_id` | Vine ID if known; otherwise a free-text guess |
| `marked` | `yes` vine tag known, `no` unmarked, `?` extras |
| `zone`, `block` | Location; `?` means inferred from time |
| `observer_note_NOT_A_LABEL` | Collector's description. **Not a label.** |
| `suggested_label` | Triage suggestion only: `healthy`, `yellowing`, `leaf_spot`, `stem_rot?`, `cant_tell`, `exclude`. **Not a label.** |
| `suggestion_confidence` | `low` / `medium` / `high` for the suggestion |
| `suggestion_reason` | Why the suggestion was made |
| `supervisor_label` | **Ground truth.** Empty until the supervisor reviews it |
| `supervisor_comment` | Supervisor's free-text note |
| `whatsapp_time` | WhatsApp send time on 11 Oct (EXIF was lost) |
| `original_whatsapp_name`, `source_zip` | Provenance |
| `width`, `height` | Pixel size after WhatsApp downscaling |

v2 adds `suggested_label`, `suggestion_confidence`, `suggestion_reason` and `supervisor_comment` to v1.

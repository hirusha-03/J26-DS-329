import os
import cv2
import numpy as np
import torch
import matplotlib.pyplot as plt

from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor


# ============================================================
# WORKFLOW (read this before running)
# ============================================================
# A single point-click often only segments ONE local piece of a thin,
# winding, self-crossing vine (this is exactly what happened with your
# Mask 2 / Mask 3 test -- each caught a different portion). So instead of
# trying to get one perfect click, build the final mask up in PIECES:
#
#   1. Left-click on ONE visible segment of the vine (add more points /
#      right-click on background near it if the preview grabs too much).
#   2. Press 1 / 2 / 3 to preview SAM's three candidate masks for this
#      segment and pick the one that's actually correct.
#   3. Optionally press F to run one refinement pass (feeds the mask back
#      into SAM as a prompt for a sharper result) -- do this if the
#      preview is close but a bit rough at the edges.
#   4. Press A to ACCEPT this segment -- it gets added (unioned) into the
#      accumulated final mask, shown in green, and the current points
#      clear so you can start the next segment.
#   5. Repeat steps 1-4 for every remaining visible segment of the vine,
#      working along its length (including past occlusions/behind leaves).
#   6. Press S to save the final accumulated mask when you're done with
#      this photo.
#
# Z undoes the last accepted segment. C clears everything and starts over.
# Scroll wheel zooms in/out around the cursor -- use this to click
# precisely on thin sections instead of clicking blind at full zoom-out.


# ============================================================
# Paths
# ============================================================

IMAGE_PATH = "/mnt/f/vanilla-sam2/images/vine01.jpeg"

CHECKPOINT = "/mnt/f/vanilla-sam2/sam2/checkpoints/sam2.1_hiera_tiny.pt"

CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"

OUTPUT_PATH = "/mnt/f/vanilla-sam2/masks/vine01_final_mask.png"


# ============================================================
# Check GPU
# ============================================================

device = "cuda" if torch.cuda.is_available() else "cpu"
print("Device:", device)
if device == "cuda":
    print("GPU:", torch.cuda.get_device_name(0))


# ============================================================
# Load image
# ============================================================

image = cv2.imread(IMAGE_PATH)
if image is None:
    raise FileNotFoundError(f"Could not find image: {IMAGE_PATH}")
image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
h, w = image.shape[:2]
print("Image loaded:", image.shape)


# ============================================================
# Load SAM 2
# ============================================================

print("Loading SAM 2...")
sam2_model = build_sam2(CONFIG, CHECKPOINT, device=device)
predictor = SAM2ImagePredictor(sam2_model)
predictor.set_image(image)
print("SAM 2 loaded and image encoded.")


# ============================================================
# State
# ============================================================

positive_points = []
negative_points = []

last_masks = None
last_scores = None
last_logits = None
current_candidate_idx = 0

accumulated_mask = np.zeros((h, w), dtype=bool)
undo_stack = []  # stores previous accumulated_mask states before each accept

point_artists = []       # scatter artists for current segment's points
candidate_overlay = None  # current (uncommitted) candidate mask preview
accumulated_overlay = None  # committed mask, shown in green


TITLE_BASE = (
    "Left=vine pt | Right=background pt | 1/2/3=pick candidate | "
    "F=refine | A=accept segment | Z=undo | C=clear all | S=save\n"
)

fig, ax = plt.subplots(figsize=(12, 10))
ax.imshow(image)
ax.axis("off")


def redraw_title():
    n_segments = len(undo_stack)
    status = f"Segments accepted: {n_segments}"
    if last_scores is not None:
        status += f" | Previewing candidate {current_candidate_idx + 1}/3 (score={last_scores[current_candidate_idx]:.3f})"
    ax.set_title(TITLE_BASE + status, fontsize=9)


def redraw_overlays():
    global candidate_overlay, accumulated_overlay

    if accumulated_overlay is not None:
        accumulated_overlay.remove()
        accumulated_overlay = None
    if candidate_overlay is not None:
        candidate_overlay.remove()
        candidate_overlay = None

    if accumulated_mask.any():
        accumulated_overlay = ax.imshow(
            np.ma.masked_where(~accumulated_mask, accumulated_mask),
            cmap="Greens", alpha=0.5, vmin=0, vmax=1
        )

    if last_masks is not None:
        cand = last_masks[current_candidate_idx]
        candidate_overlay = ax.imshow(
            np.ma.masked_where(~cand, cand),
            cmap="Blues", alpha=0.45, vmin=0, vmax=1
        )

    redraw_title()
    fig.canvas.draw_idle()


def run_predict(mask_input=None):
    global last_masks, last_scores, last_logits, current_candidate_idx

    points = positive_points + negative_points
    if len(points) == 0:
        return

    point_coords = np.array(points, dtype=np.float32)
    point_labels = np.array(
        [1] * len(positive_points) + [0] * len(negative_points), dtype=np.int32
    )

    masks, scores, logits = predictor.predict(
        point_coords=point_coords,
        point_labels=point_labels,
        mask_input=mask_input,
        multimask_output=True,
    )

    # SAM2 can return masks as float arrays rather than bool (unlike SAM1),
    # which breaks bitwise ops like ~mask later on -- force bool here once,
    # so every downstream use (overlay, accept, union) is safe.
    masks = masks.astype(bool)

    last_masks, last_scores, last_logits = masks, scores, logits
    current_candidate_idx = int(np.argmax(scores))  # default to SAM's top pick
    redraw_overlays()


def clear_current_segment():
    global point_artists, last_masks, last_scores, last_logits
    positive_points.clear()
    negative_points.clear()
    for a in point_artists:
        a.remove()
    point_artists.clear()
    last_masks, last_scores, last_logits = None, None, None


def onclick(event):
    if event.xdata is None or event.ydata is None:
        return

    x, y = event.xdata, event.ydata

    if event.button == 1:
        positive_points.append([x, y])
        point_artists.append(ax.scatter(x, y, c="lime", s=70, marker="o", edgecolors="black"))
        print(f"Positive click: ({x:.0f}, {y:.0f})")
    elif event.button == 3:
        negative_points.append([x, y])
        point_artists.append(ax.scatter(x, y, c="red", s=70, marker="x"))
        print(f"Negative click: ({x:.0f}, {y:.0f})")
    else:
        return

    run_predict()


def onscroll(event):
    # Zoom in/out centered on the cursor position -- useful for precise
    # clicking on thin vine sections.
    if event.xdata is None or event.ydata is None:
        return

    cur_xlim = ax.get_xlim()
    cur_ylim = ax.get_ylim()
    scale = 0.8 if event.button == "up" else 1.25

    x, y = event.xdata, event.ydata
    new_w = (cur_xlim[1] - cur_xlim[0]) * scale
    new_h = (cur_ylim[0] - cur_ylim[1]) * scale  # y-axis inverted for images

    relx = (cur_xlim[1] - x) / (cur_xlim[1] - cur_xlim[0])
    rely = (cur_ylim[0] - y) / (cur_ylim[0] - cur_ylim[1])

    ax.set_xlim([x - (1 - relx) * new_w, x + relx * new_w])
    ax.set_ylim([y + (1 - rely) * new_h, y - rely * new_h])
    fig.canvas.draw_idle()


def onkey(event):
    global accumulated_mask, current_candidate_idx

    # ---- Preview candidate 1/2/3 ----
    if event.key in ("1", "2", "3") and last_masks is not None:
        current_candidate_idx = int(event.key) - 1
        redraw_overlays()
        print(f"Previewing candidate {current_candidate_idx + 1} "
              f"(score={last_scores[current_candidate_idx]:.3f})")

    # ---- Refine: feed current mask back into SAM as a prompt ----
    elif event.key == "f" and last_logits is not None:
        print("Refining current segment...")
        refine_input = last_logits[current_candidate_idx][None, :, :]
        run_predict(mask_input=refine_input)
        print("Refinement done -- review candidates 1/2/3 again.")

    # ---- Accept current candidate into the accumulated mask ----
    elif event.key == "a":
        if last_masks is None:
            print("Nothing to accept yet -- click on the vine first.")
            return
        undo_stack.append(accumulated_mask.copy())
        accumulated_mask = np.logical_or(accumulated_mask, last_masks[current_candidate_idx])
        clear_current_segment()
        redraw_overlays()
        print(f"Segment accepted. Total accepted segments: {len(undo_stack)}. "
              f"Click the next visible part of the vine.")

    # ---- Undo last accepted segment ----
    elif event.key == "z":
        if len(undo_stack) == 0:
            print("Nothing to undo.")
            return
        accumulated_mask = undo_stack.pop()
        redraw_overlays()
        print(f"Undid last segment. Remaining accepted segments: {len(undo_stack)}.")

    # ---- Clear everything and start over ----
    elif event.key == "c":
        accumulated_mask = np.zeros((h, w), dtype=bool)
        undo_stack.clear()
        clear_current_segment()
        redraw_overlays()
        print("Cleared everything. Starting over.")

    # ---- Save final accumulated mask ----
    elif event.key == "s":
        if not accumulated_mask.any():
            print("Accumulated mask is empty -- accept at least one segment first (press A).")
            return
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        mask_uint8 = (accumulated_mask.astype(np.uint8) * 255)
        cv2.imwrite(OUTPUT_PATH, mask_uint8)

        # Save a "jet"-style full-image preview of the final mask, matching
        # the look of your earlier candidate-mask screenshots (dark
        # blue/purple background, orange/red highlighted vine).
        preview_path = OUTPUT_PATH.replace(".png", "_preview.png")
        fig2, ax2 = plt.subplots(figsize=(10, 20))
        ax2.imshow(image)
        ax2.imshow(accumulated_mask, alpha=0.5, cmap="jet")
        ax2.set_title(f"Final accumulated mask ({len(undo_stack)} segments)")
        ax2.axis("off")
        fig2.savefig(preview_path, dpi=120, bbox_inches="tight")
        plt.close(fig2)

        print()
        print("===================================")
        print("FINAL MASK SAVED")
        print(OUTPUT_PATH)
        print(f"Preview image saved to: {preview_path}")
        print(f"Built from {len(undo_stack)} accepted segment(s).")
        print("===================================")


fig.canvas.mpl_connect("button_press_event", onclick)
fig.canvas.mpl_connect("key_press_event", onkey)
fig.canvas.mpl_connect("scroll_event", onscroll)

redraw_title()
plt.show()

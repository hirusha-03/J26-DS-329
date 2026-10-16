#!/usr/bin/env python3
"""Interactive SAM2 gap repair for a manually verified vanilla stem.

SAM2 installation must be importable from the working directory. No gaps are
silently filled: every SAM2 proposal requires explicit acceptance.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch


def args_parser():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('image', 'mask', 'report', 'checkpoint', 'config', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--margin', type=int, default=75, help='Crop padding around each gap')
    p.add_argument('--gap', type=int, default=0, help='1-based gap number; 0 means all')
    p.add_argument('--max-add-fraction', type=float, default=0.35,
                   help='Warn when proposed foreground occupies too much of crop')
    return p.parse_args()


def main():
    a = args_parser()
    image = cv2.imread(a.image, cv2.IMREAD_COLOR)
    mask = cv2.imread(a.mask, cv2.IMREAD_GRAYSCALE)
    if image is None or mask is None:
        raise SystemExit('Could not read image/mask. Check file paths.')
    if image.shape[:2] != mask.shape:
        raise SystemExit('Image and mask dimensions differ; use same-resolution files.')
    report = json.loads(Path(a.report).read_text())
    gaps = report.get('gaps', [])
    if not gaps:
        raise SystemExit('No unresolved gaps in report.')
    if a.gap and not 1 <= a.gap <= len(gaps):
        raise SystemExit('Invalid --gap number.')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    try:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
    except ImportError as exc:
        raise SystemExit('SAM2 import failed. Run from your SAM2 environment/repository.') from exc

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('Loading SAM2 on', device)
    model = build_sam2(a.config, a.checkpoint, device=device)
    predictor = SAM2ImagePredictor(model)
    merged = (mask > 127).astype(np.uint8) * 255
    log = []
    gap_indices = [a.gap - 1] if a.gap else list(range(len(gaps)))
    window = 'SAM2 gap repair | L:+ R:- P:predict A:accept S:skip U:undo C:clear Q:quit'

    for idx in gap_indices:
        g = gaps[idx]
        x1, y1 = map(int, g['from_xy'])
        x2, y2 = map(int, g['to_xy'])
        H, W = merged.shape
        x0 = max(0, min(x1, x2) - a.margin)
        y0 = max(0, min(y1, y2) - a.margin)
        x3 = min(W, max(x1, x2) + a.margin + 1)
        y3 = min(H, max(y1, y2) + a.margin + 1)
        crop = image[y0:y3, x0:x3].copy()
        crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        predictor.set_image(crop_rgb)
        points = [[x1-x0, y1-y0], [x2-x0, y2-y0]]
        labels = [1, 1]
        proposed = None
        action = None
        warning = ''

        def draw():
            view = crop.copy()
            existing = merged[y0:y3, x0:x3] > 0
            view[existing] = (view[existing] * 0.70 + np.array([0, 125, 0]) * 0.30).astype(np.uint8)
            if proposed is not None:
                add = proposed & ~existing
                view[add] = (view[add] * 0.40 + np.array([255, 190, 0]) * 0.60).astype(np.uint8)
            for (px, py), label in zip(points, labels):
                cv2.circle(view, (int(px), int(py)), 4, (0, 255, 0) if label else (0, 0, 255), -1)
                cv2.circle(view, (int(px), int(py)), 5, (0, 0, 0), 1)
            lines = [f'Gap {idx+1}/{len(gaps)} | + green, - red | P predict, A accept, S skip',
                     'U undo, C clear extras, Q quit | cyan = proposed, green = existing']
            if warning:
                lines.append(warning)
            for i, line in enumerate(lines):
                yy = 18 + i*20
                cv2.rectangle(view, (0, yy-15), (min(view.shape[1]-1, len(line)*7+6), yy+4), (0, 0, 0), -1)
                cv2.putText(view, line, (4, yy), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (255,255,255), 1)
            return view

        def mouse(event, x, y, flags, userdata):
            nonlocal proposed, warning
            if event in (cv2.EVENT_LBUTTONDOWN, cv2.EVENT_RBUTTONDOWN):
                points.append([x, y])
                labels.append(1 if event == cv2.EVENT_LBUTTONDOWN else 0)
                proposed = None
                warning = ''

        cv2.namedWindow(window, cv2.WINDOW_NORMAL)
        cv2.setMouseCallback(window, mouse)
        while True:
            cv2.imshow(window, draw())
            key = cv2.waitKey(40) & 0xff
            if key == ord('u') and len(points) > 2:
                points.pop(); labels.pop(); proposed = None; warning = ''
            elif key == ord('c'):
                points = points[:2]; labels = labels[:2]; proposed = None; warning = ''
            elif key == ord('p'):
                with torch.inference_mode():
                    pred, scores, _ = predictor.predict(
                        point_coords=np.asarray(points, dtype=np.float32),
                        point_labels=np.asarray(labels, dtype=np.int32),
                        multimask_output=True)
                best = int(np.argmax(scores))
                proposed = pred[best].astype(bool)
                frac = proposed.mean()
                warning = f'SAM2 score={float(scores[best]):.3f}; crop foreground={frac:.1%}'
                if frac > a.max_add_fraction:
                    warning += ' WARNING: large region; add negative prompts'
            elif key == ord('a'):
                if proposed is None:
                    print('Press P to generate a proposal before accepting.')
                    continue
                new = proposed & (merged[y0:y3, x0:x3] == 0)
                if proposed.mean() > a.max_add_fraction:
                    print('WARNING: proposal covers a large crop; inspect carefully.')
                merged[y0:y3, x0:x3][new] = 255
                accepted = (proposed.astype(np.uint8) * 255)
                cv2.imwrite(str(out / f'gap_{idx+1:02d}_accepted_crop.png'), accepted)
                action = 'accepted'
                break
            elif key == ord('s'):
                action = 'skipped'; break
            elif key == ord('q') or key == 27:
                action = 'quit'; break
        cv2.destroyWindow(window)
        log.append({'gap': idx+1, 'from_xy': [x1,y1], 'to_xy': [x2,y2],
                    'status': action, 'points_crop_xy': points, 'labels': labels,
                    'crop_xyxy': [x0,y0,x3,y3]})
        cv2.imwrite(str(out / 'recovered_mask_progress.png'), merged)
        if action == 'quit':
            break

    cv2.imwrite(str(out / 'recovered_mask.png'), merged)
    overlay = image.copy()
    added = (merged > 0) & (mask <= 127)
    overlay[added] = (overlay[added]*0.3 + np.array([255, 180, 0])*0.7).astype(np.uint8)
    cv2.imwrite(str(out / 'recovered_overlay.png'), overlay)
    (out / 'recovery_report.json').write_text(json.dumps({
        'device': device, 'source_report': a.report,
        'accepted_gaps': sum(x['status']=='accepted' for x in log),
        'new_pixels': int(added.sum()), 'repairs': log,
        'note': 'Accepted SAM2 mask additions are unverified until re-skeletonization and route review.'
    }, indent=2))
    print('Saved:', out / 'recovered_mask.png')
    print('Next: re-run extract_main_stem.py and verify_main_stem.py with the updated mask.')

if __name__ == '__main__':
    main()

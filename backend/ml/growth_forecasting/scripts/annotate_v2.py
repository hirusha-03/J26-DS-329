"""SAM2 crop-based annotation experiment. Run from the sam2 repository directory.
Controls: left positive, right negative, 1/2/3 candidates, a accept,
         n next crop, b previous crop, u undo accept, r reset prompts,
         s save, q quit. Zoom with matplotlib toolbar.
"""
import argparse
from pathlib import Path
import cv2
import numpy as np
import torch
import matplotlib.pyplot as plt
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--image', default='/mnt/f/vanilla-sam2/images/vine01.jpeg')
    p.add_argument('--checkpoint', default='checkpoints/sam2.1_hiera_tiny.pt')
    p.add_argument('--config', default='configs/sam2.1/sam2.1_hiera_t.yaml')
    p.add_argument('--out', default='/mnt/f/vanilla-sam2/masks/vine01_v2_mask.png')
    p.add_argument('--crop-height', type=int, default=420)
    p.add_argument('--overlap', type=int, default=160)
    args = p.parse_args()
    bgr = cv2.imread(args.image)
    if bgr is None: raise FileNotFoundError(args.image)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    if args.crop_height <= args.overlap or args.overlap < 0: raise ValueError('crop-height must exceed overlap >= 0')
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('Device:', device)
    model = build_sam2(args.config, args.checkpoint, device=device)
    predictor = SAM2ImagePredictor(model)
    # Crops span full width; overlapping windows reduce loss of context.
    stride = args.crop_height - args.overlap
    starts = list(range(0, max(1, h - args.crop_height + 1), stride))
    starts.append(max(0, h - args.crop_height))
    starts = sorted(set(starts))
    crops = [(y, min(h, y + args.crop_height)) for y in starts]
    state = {'idx': 0, 'positive': [], 'negative': [], 'masks': None, 'scores': None, 'selected': 0}
    accumulated = np.zeros((h, w), dtype=bool)
    undo = []
    fig, ax = plt.subplots(figsize=(8, 10))

    def load_crop():
        y0, y1 = crops[state['idx']]
        predictor.set_image(rgb[y0:y1])
        state.update(positive=[], negative=[], masks=None, scores=None, selected=0)
        render()

    def predict():
        pts = state['positive'] + state['negative']
        if not pts: return
        coords = np.array(pts, dtype=np.float32)
        labels = np.array([1] * len(state['positive']) + [0] * len(state['negative']), dtype=np.int32)
        with torch.inference_mode():
            masks, scores, _ = predictor.predict(point_coords=coords, point_labels=labels, multimask_output=True)
        state['masks'] = masks.astype(bool)
        state['scores'] = scores
        state['selected'] = int(np.argmax(scores))
        render()

    def render():
        ax.clear()
        y0, y1 = crops[state['idx']]
        ax.imshow(rgb[y0:y1])
        prior = accumulated[y0:y1]
        if prior.any():
            overlay = np.zeros((*prior.shape, 4), dtype=float)
            overlay[prior] = [0, 1, 0, 0.4]
            ax.imshow(overlay)
        if state['masks'] is not None:
            candidate = state['masks'][state['selected']]
            overlay = np.zeros((*candidate.shape, 4), dtype=float)
            overlay[candidate] = [0, 0.5, 1, 0.45]
            ax.imshow(overlay)
        for name, color, marker in [('positive', 'lime', 'o'), ('negative', 'red', 'x')]:
            if state[name]:
                pts = np.array(state[name]); ax.scatter(pts[:,0], pts[:,1], c=color, marker=marker, s=35)
        score = '' if state['scores'] is None else f" | candidate {state['selected']+1}: {state['scores'][state['selected']]:.3f}"
        ax.set_title(f"Crop {state['idx']+1}/{len(crops)} (rows {y0}-{y1}){score}\nLeft:+ Right:- | 1/2/3 select | A accept | N/B crops | R reset | U undo | S save | Q quit", fontsize=9)
        ax.set_xlim(0, w); ax.set_ylim(y1-y0, 0)
        fig.canvas.draw_idle()

    def click(e):
        if e.inaxes != ax or e.xdata is None or e.ydata is None: return
        if e.button not in (1, 3): return
        state['positive' if e.button == 1 else 'negative'].append([e.xdata, e.ydata])
        predict()

    def key(e):
        nonlocal accumulated
        k = (e.key or '').lower()
        if k in ('1', '2', '3') and state['masks'] is not None:
            state['selected'] = int(k)-1; render()
        elif k == 'a' and state['masks'] is not None:
            y0, y1 = crops[state['idx']]
            undo.append(accumulated.copy())
            accumulated[y0:y1] |= state['masks'][state['selected']]
            state.update(positive=[], negative=[], masks=None, scores=None, selected=0)
            render()
        elif k == 'u' and undo:
            accumulated = undo.pop(); render()
        elif k == 'r':
            state.update(positive=[], negative=[], masks=None, scores=None, selected=0); render()
        elif k in ('n', 'b'):
            state['idx'] = (state['idx'] + (1 if k == 'n' else -1)) % len(crops)
            load_crop()
        elif k == 's':
            out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out), (accumulated.astype(np.uint8)*255))
            vis = bgr.copy(); vis[accumulated] = (0.55 * vis[accumulated] + 0.45 * np.array([0,255,0])).astype(np.uint8)
            overlay_path = out.with_name(out.stem + '_overlay.png')
            cv2.imwrite(str(overlay_path), vis)
            print('Saved:', out, overlay_path)
        elif k == 'q': plt.close(fig)

    fig.canvas.mpl_connect('button_press_event', click)
    fig.canvas.mpl_connect('key_press_event', key)
    load_crop()
    plt.show()

if __name__ == '__main__': main()

#!/usr/bin/env python3
"""Interactive, manual main-stem mask correction (no automatic gap filling)."""
import argparse
from pathlib import Path
import cv2
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider

p = argparse.ArgumentParser()
p.add_argument('--image', required=True)
p.add_argument('--mask', required=True)
p.add_argument('--out', required=True, help='Output directory')
a = p.parse_args()
image_bgr = cv2.imread(a.image)
mask_gray = cv2.imread(a.mask, cv2.IMREAD_GRAYSCALE)
if image_bgr is None or mask_gray is None:
    p.error('Could not read image or mask: check both paths')
if image_bgr.shape[:2] != mask_gray.shape:
    p.error('Image and mask dimensions do not match')
image = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
mask = mask_gray >= 127
history = []
mode = 'erase'
brush = 5
show_overlay = True
is_drawing = False
last_xy = None
h, w = mask.shape
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
fig, ax = plt.subplots(figsize=(9, 12))
fig.subplots_adjust(bottom=0.13)
ax.imshow(image)
overlay = ax.imshow(np.ma.masked_where(~mask, mask.astype(float)), cmap='spring', alpha=.48, vmin=0, vmax=1, interpolation='nearest')
ax.set_xlim(0, w); ax.set_ylim(h, 0)
ax.axis('off')
ax.set_title('Main stem mask editor')
status = fig.text(.05, .07, '', fontsize=10)

def refresh():
    overlay.set_data(np.ma.masked_where(~mask, mask.astype(float)))
    overlay.set_visible(show_overlay)
    status.set_text(f'Mode: {mode.upper()} | Brush radius: {brush}px | E=erase P=paint | [ ] size | Z=undo | S=save | V=overlay | scroll=zoom')
    fig.canvas.draw_idle()

def paint_segment(start, end):
    value = mode == 'paint'
    temp = np.zeros((h, w), np.uint8)
    cv2.line(temp, start, end, 255, thickness=brush*2+1, lineType=cv2.LINE_8)
    cv2.circle(temp, end, brush, 255, -1)
    mask[temp > 0] = value
    refresh()

def click(event):
    global is_drawing, last_xy
    if event.inaxes != ax or event.button != 1 or event.xdata is None: return
    x, y = int(round(event.xdata)), int(round(event.ydata))
    if not (0 <= x < w and 0 <= y < h): return
    history.append(mask.copy())
    if len(history) > 30: history.pop(0)
    is_drawing = True
    last_xy = (x, y)
    paint_segment(last_xy, last_xy)

def motion(event):
    global last_xy
    if not is_drawing or event.inaxes != ax or event.xdata is None: return
    x, y = int(np.clip(round(event.xdata), 0, w-1)), int(np.clip(round(event.ydata), 0, h-1))
    paint_segment(last_xy, (x, y))
    last_xy = (x, y)

def release(event):
    global is_drawing, last_xy
    is_drawing = False
    last_xy = None

def save():
    path = out / 'vine01_main_stem_mask.png'
    overlay_path = out / 'vine01_main_stem_overlay.png'
    cv2.imwrite(str(path), (mask.astype(np.uint8) * 255))
    overlay_bgr = image_bgr.copy()
    tint = np.zeros_like(overlay_bgr); tint[:] = (255, 0, 255)
    overlay_bgr[mask] = cv2.addWeighted(image_bgr[mask], .55, tint[mask], .45, 0)
    cv2.imwrite(str(overlay_path), overlay_bgr)
    print('Saved:', path, '\nSaved:', overlay_path)
    ax.set_title(f'Saved: {path.name}')
    fig.canvas.draw_idle()

def key(event):
    global mode, brush, mask, show_overlay
    if event.key == 'e': mode = 'erase'
    elif event.key == 'p': mode = 'paint'
    elif event.key in ('[', '-'): brush = max(1, brush-1)
    elif event.key in (']', '+', '='): brush = min(80, brush+1)
    elif event.key == 'z' and history: mask = history.pop()
    elif event.key == 'v': show_overlay = not show_overlay
    elif event.key == 's': save()
    refresh()

def scroll(event):
    if event.inaxes != ax or event.xdata is None: return
    factor = .8 if event.button == 'up' else 1.25
    x0,x1=ax.get_xlim(); y0,y1=ax.get_ylim()
    x,y=event.xdata,event.ydata
    ax.set_xlim(x+(x0-x)*factor, x+(x1-x)*factor)
    ax.set_ylim(y+(y0-y)*factor, y+(y1-y)*factor)
    fig.canvas.draw_idle()

fig.canvas.mpl_connect('button_press_event', click)
fig.canvas.mpl_connect('motion_notify_event', motion)
fig.canvas.mpl_connect('button_release_event', release)
fig.canvas.mpl_connect('key_press_event', key)
fig.canvas.mpl_connect('scroll_event', scroll)
refresh()
print('Edit mask: E erase; P paint; [ ] brush size; Z undo; V toggle overlay; scroll zoom; S save. Close window when done.')
plt.show()

#!/usr/bin/env python3
"""Interactive confidence-guided FULL vine tracer (training-free).

Start with sparse ORDERED waypoints, including any real turnaround. Trace between
points; review automatically ranked uncertain sections; click to insert corrections.
The entire ordered trajectory is retained (including downward/return sections).
Confidence is a heuristic review priority, NOT calibrated probability.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from guided_vine_tracer_v2 import trace_pair


def trace_all(img, points, corridor, downsample, max_chord):
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    results = []
    for i, (a, b) in enumerate(zip(points[:-1], points[1:])):
        path, color_error, excursion = trace_pair(img, lab, a, b, corridor, downsample)
        chord = float(np.linalg.norm(np.subtract(a, b)))
        length = float(np.linalg.norm(np.diff(path.astype(float), axis=0), axis=1).sum())
        ratio = length / max(chord, 1)
        # Heuristic, deliberately conservative. Large gaps are uncertain even if
        # color appears plausible. Do not interpret score as a probability.
        color_bad = min(1., color_error / 1.8)
        distance_bad = min(1., max(0., chord - 45) / max(1., max_chord - 45))
        detour_bad = min(1., max(0., ratio - 1.12) / .65)
        excursion_bad = min(1., excursion / max(corridor, 1))
        risk = float(np.clip(.32*color_bad + .38*distance_bad + .18*detour_bad + .12*excursion_bad, 0, 1))
        reasons = []
        if chord > max_chord: reasons.append('long_unconstrained_span')
        if color_error > 1.5: reasons.append('weak_local_color_evidence')
        if ratio > 1.65: reasons.append('large_detour')
        if excursion > .85*corridor: reasons.append('near_corridor_boundary')
        if risk >= .52: reasons.append('high_heuristic_uncertainty')
        results.append(dict(section=i+1, path=path, length_px=length, chord_px=chord,
                            mean_color_penalty=float(color_error), excursion_px=float(excursion),
                            risk_score=risk, review_reasons=reasons))
    return results


def save(img, points, segments, out, click_count, initial_count, history):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    mask = np.zeros(img.shape[:2], np.uint8)
    overlay = img.copy()
    uncertainty = img.copy()
    total = 0.
    rows = []
    for seg in segments:
        path = seg['path']; risk = seg['risk_score']; total += seg['length_px']
        cv2.polylines(mask, [path], False, 255, 1, cv2.LINE_8)
        color = (0, 70, 255) if risk >= .52 else (0, 220, 0)
        cv2.polylines(overlay, [path], False, color, 2, cv2.LINE_AA)
        cv2.polylines(uncertainty, [path], False, (0, 0, 255) if risk >= .52 else (0, 200, 0), 3, cv2.LINE_AA)
        rows.append({k: (round(v, 4) if isinstance(v, float) else v)
                     for k, v in seg.items() if k != 'path'})
    for i, (x, y) in enumerate(points):
        cv2.circle(overlay, (x, y), 4, (255, 0, 255), -1)
        cv2.putText(overlay, str(i+1), (x+5, y-5), cv2.FONT_HERSHEY_SIMPLEX, .4, (255,255,255), 1, cv2.LINE_AA)
    cv2.imwrite(str(out/'guided_route_overlay.png'), overlay)
    cv2.imwrite(str(out/'full_vine_centerline.png'), mask)
    cv2.imwrite(str(out/'final_main_stem_centerline.png'), mask)
    cv2.imwrite(str(out/'uncertainty_overlay.png'), uncertainty)
    report = dict(status='CANDIDATE_REQUIRES_VISUAL_VERIFICATION',
                  objective='complete ordered vine path, including genuine reversals',
                  initial_waypoint_count=initial_count, final_waypoint_count=len(points),
                  correction_click_count=click_count, total_user_click_count=initial_count+click_count,
                  route_length_px=round(total, 2),
                  high_risk_sections=[s['section'] for s in segments if s['risk_score'] >= .52],
                  waypoints_xy=[list(p) for p in points], sections=rows, correction_history=history,
                  warning='Risk is heuristic, not calibrated confidence. Hidden segments are inferred. '
                          'Length is a 2D projected path in pixels, not actual 3D physical length. '
                          'Overlapping route pixels are retained in the ordered length sum.')
    (out/'guided_route_report.json').write_text(json.dumps(report, indent=2))
    (out/'waypoints_v3.json').write_text(json.dumps({'waypoints_xy': report['waypoints_xy']}, indent=2))
    print(f"Saved {out}; route {total:.2f} px; initial clicks {initial_count}; corrections {click_count}")


def display_frame(img, points, segments, selected, phase, click_count):
    view = img.copy()
    if segments:
        for i, seg in enumerate(segments):
            color = (0, 255, 255) if i == selected else ((0, 60, 255) if seg['risk_score'] >= .52 else (0, 210, 0))
            cv2.polylines(view, [seg['path']], False, color, 3 if i == selected else 2, cv2.LINE_AA)
    else:
        for a, b in zip(points[:-1], points[1:]): cv2.line(view, a, b, (0, 255, 255), 1)
    for i, xy in enumerate(points):
        cv2.circle(view, xy, 4, (255, 0, 255), -1)
        cv2.putText(view, str(i+1), (xy[0]+5, xy[1]-5), cv2.FONT_HERSHEY_SIMPLEX, .4, (255,255,255), 1, cv2.LINE_AA)
    # Top text may be hard to read on foliage; use dark header band.
    cv2.rectangle(view, (0, 0), (view.shape[1], 48), (15, 15, 15), -1)
    if phase == 'initial':
        line1 = 'Click ordered vine anchors; ENTER = trace; U = undo; ESC = quit'
        line2 = f'Initial clicks: {len(points)} | include real turnarounds'
    else:
        risk = segments[selected]['risk_score'] if selected >= 0 else 0
        line1 = 'N/P = select section | click correction on vine | S = save | ESC = quit'
        line2 = f'Section {selected+1}/{len(segments)} | risk {risk:.2f} (heuristic) | corrections {click_count}'
    cv2.putText(view, line1, (8, 19), cv2.FONT_HERSHEY_SIMPLEX, .43, (255,255,255), 1, cv2.LINE_AA)
    cv2.putText(view, line2, (8, 38), cv2.FONT_HERSHEY_SIMPLEX, .43, (255,255,255), 1, cv2.LINE_AA)
    return view


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--corridor', type=int, default=35)
    parser.add_argument('--downsample', type=int, default=1)
    parser.add_argument('--max-chord', type=float, default=130)
    parser.add_argument('--points-json', help='Optional ordered initial anchors; still opens correction GUI unless --no-gui')
    parser.add_argument('--no-gui', action='store_true', help='Trace supplied --points-json without interactive review')
    args = parser.parse_args()
    if args.corridor <= 0 or args.downsample <= 0: parser.error('corridor and downsample must be positive')
    img = cv2.imread(args.image)
    if img is None: parser.error('Cannot open image')
    points = []
    if args.points_json:
        raw = json.loads(Path(args.points_json).read_text())
        if isinstance(raw, dict): raw = raw['waypoints_xy']
        points = [tuple(map(int, p)) for p in raw]
    if args.no_gui and not args.points_json: parser.error('--no-gui requires --points-json')
    h, w = img.shape[:2]
    def validate():
        if len(points) < 2: raise ValueError('At least 2 points required')
        if any(not (0 <= x < w and 0 <= y < h) for x, y in points): raise ValueError('Point outside image')
    if args.no_gui:
        validate(); segments = trace_all(img, points, args.corridor, args.downsample, args.max_chord)
        save(img, points, segments, args.out, 0, len(points), []); return
    name = 'Guided full-vine tracer V3 | confidence-guided corrections'
    cv2.namedWindow(name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(name, min(w, 900), min(h, 900))
    state = {'phase': 'initial' if not args.points_json else 'review', 'selected': 0,
             'segments': [], 'corrections': 0, 'history': [], 'initial_count': 0}
    def recalc():
        state['segments'] = trace_all(img, points, args.corridor, args.downsample, args.max_chord)
        state['selected'] = min(state['selected'], len(state['segments'])-1)
    if args.points_json:
        validate(); state['initial_count'] = len(points); recalc()
        state['selected'] = int(np.argmax([s['risk_score'] for s in state['segments']]))
    def on_mouse(event, x, y, flags, userdata):
        if event != cv2.EVENT_LBUTTONDOWN: return
        if not (0 <= x < w and 0 <= y < h): return
        if state['phase'] == 'initial':
            points.append((x, y))
        else:
            i = state['selected']
            # Click anywhere on vine within selected section; insert in biological order.
            # Avoid duplicating either endpoint.
            if np.linalg.norm(np.subtract((x,y), points[i])) < 4 or np.linalg.norm(np.subtract((x,y), points[i+1])) < 4: return
            points.insert(i+1, (x, y)); state['corrections'] += 1
            state['history'].append({'split_section': i+1, 'inserted_xy': [x, y]})
            recalc()
            state['selected'] = min(i, len(state['segments'])-1)
    cv2.setMouseCallback(name, on_mouse)
    print('Initial: click start, genuine turnarounds, end IN TRAVERSAL ORDER; Enter traces.')
    print('Review: N/P choose section, click on vine to insert correction, S save.')
    while True:
        cv2.imshow(name, display_frame(img, points, state['segments'], state['selected'], state['phase'], state['corrections']))
        key = cv2.waitKey(40) & 255
        if key == 27: print('Exited without saving'); break
        if state['phase'] == 'initial':
            if key in (ord('u'), 8) and points: points.pop()
            if key in (10, 13):
                try: validate()
                except ValueError as e: print(e); continue
                state['initial_count'] = len(points)
                recalc(); state['phase'] = 'review'
                state['selected'] = int(np.argmax([s['risk_score'] for s in state['segments']]))
                print('Review the yellow section. Press N/P to cycle; click on actual vine to refine; S to save.')
        else:
            if key == ord('n'): state['selected'] = (state['selected']+1) % len(state['segments'])
            if key == ord('p'): state['selected'] = (state['selected']-1) % len(state['segments'])
            if key == ord('s'):
                save(img, points, state['segments'], args.out, state['corrections'], state['initial_count'], state['history'])
                break
    cv2.destroyAllWindows()

if __name__ == '__main__': main()

#!/usr/bin/env python3
"""Draw a SAM2 V8 ordered route, ArUco marker, and estimated projected length."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--route', type=Path, required=True, help='ordered_route_v8.json')
    parser.add_argument('--measurement', type=Path, required=True, help='vine_measurement.json')
    parser.add_argument('--calibration', type=Path, required=True, help='aruco_calibration.json')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()

    img = cv2.imread(str(args.image))
    if img is None:
        parser.error(f'Could not read image: {args.image}')
    route = json.loads(args.route.read_text(encoding='utf-8'))
    report = json.loads(args.measurement.read_text(encoding='utf-8'))
    calibration = json.loads(args.calibration.read_text(encoding='utf-8'))
    segments = route.get('segments_xy', [])
    if not segments:
        parser.error('No segments_xy in ordered route JSON.')

    # Draw the ordered route, not the mask perimeter.
    for segment in segments:
        coords = np.asarray(segment, dtype=np.float32)
        if coords.ndim != 2 or coords.shape[1] != 2 or len(coords) < 2:
            parser.error('Invalid route segment: expected at least two [x, y] points.')
        poly = np.rint(coords).astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(img, [poly], False, (0, 0, 0), 7, cv2.LINE_AA)
        cv2.polylines(img, [poly], False, (0, 255, 255), 3, cv2.LINE_AA)

    first = np.asarray(segments[0][0], dtype=np.int32)
    last = np.asarray(segments[-1][-1], dtype=np.int32)
    for point, label in ((first, 'START'), (last, 'END')):
        pos = tuple(map(int, point))
        cv2.circle(img, pos, 7, (0, 0, 255), -1, cv2.LINE_AA)
        cv2.putText(img, label, (pos[0] + 9, max(25, pos[1] - 9)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(img, label, (pos[0] + 9, max(25, pos[1] - 9)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)

    marker_id = report['calibration']['marker_id']
    matches = [m for m in calibration.get('markers', []) if m['marker_id'] == marker_id]
    if len(matches) != 1:
        parser.error('Marker ID from measurement report not found uniquely in calibration.')
    corners = np.rint(np.asarray(matches[0]['corners_xy'], dtype=np.float32)).astype(np.int32)
    cv2.polylines(img, [corners.reshape(-1, 1, 2)], True, (255, 255, 0), 3, cv2.LINE_AA)

    length_cm = report['result']['estimated_projected_length_cm']
    marker_cm = report['calibration']['marker_side_cm']
    height, width = img.shape[:2]
    panel_h = 140
    result = np.full((height + panel_h, width, 3), 255, dtype=np.uint8)
    result[:height] = img
    cv2.putText(result, f'Estimated projected vine length: {length_cm:.1f} cm',
                (20, height + 48), cv2.FONT_HERSHEY_SIMPLEX, 0.95, (20, 20, 20), 2, cv2.LINE_AA)
    cv2.putText(result, f'ArUco ID {marker_id} | measured reference ~{marker_cm:g} cm',
                (20, height + 86), cv2.FONT_HERSHEY_SIMPLEX, 0.67, (50, 50, 50), 2, cv2.LINE_AA)
    cv2.putText(result, '2D estimate only - perspective/depth not corrected',
                (20, height + 119), cv2.FONT_HERSHEY_SIMPLEX, 0.57, (70, 70, 70), 1, cv2.LINE_AA)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(args.out), result):
        parser.error(f'Could not save output: {args.out}')
    print(f'Visualization saved: {args.out}')


if __name__ == '__main__':
    main()

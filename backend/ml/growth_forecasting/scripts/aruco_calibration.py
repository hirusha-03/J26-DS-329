#!/usr/bin/env python3
"""Detect a 5x5 ArUco marker and report nominal image-plane scale.

An assumed marker size does not establish physical ground truth.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--marker-size-cm', type=float, default=10.0)
    parser.add_argument('--route-report', type=Path, help='Optional V8 guided_route_report.json')
    args = parser.parse_args()
    if args.marker_size_cm <= 0:
        parser.error('--marker-size-cm must be positive')
    image = cv2.imread(str(args.image))
    if image is None:
        parser.error(f'Cannot read image: {args.image}')
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_5X5_50)
    corners, ids, _ = cv2.aruco.ArucoDetector(dictionary).detectMarkers(image)
    if ids is None or not len(ids):
        parser.error('No DICT_5X5_50 ArUco marker detected')
    results = []
    for marker_id, marker_corners in zip(ids.flatten(), corners):
        p = marker_corners.reshape(4, 2)
        side_lengths = [float(np.linalg.norm(p[(i + 1) % 4] - p[i])) for i in range(4)]
        side_px = float(np.mean(side_lengths))
        results.append({
            'marker_id': int(marker_id),
            'corners_xy': p.round(2).tolist(),
            'side_lengths_px': [round(v, 2) for v in side_lengths],
            'mean_side_px': round(side_px, 2),
            'nominal_marker_size_cm': args.marker_size_cm,
            'nominal_cm_per_px': round(args.marker_size_cm / side_px, 6),
        })
    selected = max(results, key=lambda item: item['mean_side_px'])
    output = {
        'image': str(args.image),
        'image_width_px': image.shape[1],
        'image_height_px': image.shape[0],
        'dictionary': 'DICT_5X5_50',
        'markers': results,
        'selected_marker_id': selected['marker_id'],
        'calibration_status': 'NOMINAL_UNVERIFIED',
        'measurement_type': 'projected_2d_estimate',
        'limitations': 'Marker size is assumed; perspective and depth differences can affect vine length.',
    }
    if args.route_report:
        with args.route_report.open(encoding='utf-8') as f:
            route = json.load(f)
        length_px = float(route['route_length_px'])
        output['route_length_px'] = length_px
        output['estimated_projected_length_cm'] = round(length_px * selected['nominal_cm_per_px'], 2)
        output['route_status'] = route.get('status', 'unknown')
    args.out.mkdir(parents=True, exist_ok=True)
    annotated = image.copy()
    cv2.aruco.drawDetectedMarkers(annotated, corners, ids)
    cv2.imwrite(str(args.out / 'aruco_detection.png'), annotated)
    (args.out / 'aruco_calibration.json').write_text(json.dumps(output, indent=2), encoding='utf-8')
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()

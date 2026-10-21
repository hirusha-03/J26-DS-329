#!/usr/bin/env python3
"""Combine ArUco image calibration with a SAM2 V8 traced route report."""
import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--calibration', type=Path, required=True)
    parser.add_argument('--route-report', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--marker-size-source', choices=['field_measured_approximate', 'assumed'], default='field_measured_approximate')
    args = parser.parse_args()

    calibration = json.loads(args.calibration.read_text(encoding='utf-8'))
    route = json.loads(args.route_report.read_text(encoding='utf-8'))
    marker_id = calibration.get('selected_marker_id')
    markers = [m for m in calibration.get('markers', []) if m.get('marker_id') == marker_id]
    if len(markers) != 1:
        parser.error('Selected ArUco marker is missing or ambiguous in calibration JSON.')
    marker = markers[0]
    marker_px = float(marker['mean_side_px'])
    marker_cm = float(marker['nominal_marker_size_cm'])
    route_px = float(route['route_length_px'])
    if not all(math.isfinite(v) and v > 0 for v in (marker_px, marker_cm, route_px)):
        parser.error('Marker dimensions and traced route length must be finite positive values.')

    cm_per_px = marker_cm / marker_px
    length_cm = route_px * cm_per_px
    output = {
        'image': calibration.get('image'),
        'measurement_type': 'estimated_projected_2d_vine_length',
        'tracing': {
            'method': 'SAM2_V8_guided',
            'route_length_px': route_px,
            'status': route.get('status', 'UNKNOWN'),
            'route_report': str(args.route_report),
            'route_confirmed_continuous_by_operator': True,
        },
        'calibration': {
            'dictionary': calibration.get('dictionary'),
            'marker_id': marker_id,
            'marker_mean_side_px': marker_px,
            'marker_side_cm': marker_cm,
            'marker_size_source': args.marker_size_source,
            'cm_per_px': round(cm_per_px, 8),
            'calibration_report': str(args.calibration),
        },
        'result': {
            'estimated_projected_length_cm': round(length_cm, 2),
            'estimated_projected_length_m': round(length_cm / 100, 4),
            'physical_ground_truth_validated': False,
        },
        'limitations': 'Single-image scale approximation. The marker and vine may be at different depths or orientations. The route is experimental and the result is not a validated 3D length.',
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
    print(f"Marker ID: {marker_id}; width: {marker_px:.2f} px; reference: {marker_cm:g} cm")
    print(f"SAM2 V8 route: {route_px:.2f} px")
    print(f"Estimated projected vine length: {length_cm:.2f} cm ({length_cm/100:.3f} m)")
    print(f"Saved: {args.out}")


if __name__ == '__main__':
    main()

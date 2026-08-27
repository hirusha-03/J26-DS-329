'use client';

import { Leaf } from 'lucide-react';
import { PLANTATION } from '../lib/plantData';

interface ContextBadgeProps {
  zone: string;
  block: string;
  plantNumber: number;
}

export default function ContextBadge({ zone, block, plantNumber }: ContextBadgeProps) {
  const zoneInfo = PLANTATION[zone];
  const color = zoneInfo ? zoneInfo.color : '#6B7280';
  const colorPale = zoneInfo ? zoneInfo.colorPale : '#F3F4F6';

  return (
    <div className="px-4 py-2 bg-white flex justify-center">
      <div
        style={{ backgroundColor: colorPale, color: color, borderColor: `${color}33` }}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border"
      >
        <Leaf className="h-3.5 w-3.5" />
        <span>
          Zone {zone} • Block {block.padStart(2, '0')} • Plant #{String(plantNumber).padStart(3, '0')}
        </span>
      </div>
    </div>
  );
}

export interface Block {
  id: string;
  plants: number;
}

export interface ZoneInfo {
  name: string;
  color: string;
  colorPale: string;
  blocks: Block[];
}

export const PLANTATION: Record<string, ZoneInfo> = {
  A: {
    name: 'Zone A',
    color: '#DC2626', // Red
    colorPale: '#FEF2F2',
    blocks: [
      { id: '01', plants: 100 },
      { id: '02', plants: 100 },
      { id: '03', plants: 100 },
      { id: '04', plants: 100 },
      { id: '05', plants: 70 },
      { id: '06', plants: 11 },
      { id: '07', plants: 50 },
    ],
  },
  B: {
    name: 'Zone B',
    color: '#D97706', // Yellow/Amber
    colorPale: '#FFFBEB',
    blocks: [
      { id: '01', plants: 100 },
      { id: '02', plants: 100 },
      { id: '03', plants: 100 },
      { id: '04', plants: 76 },
    ],
  },
  C: {
    name: 'Zone C',
    color: '#16A34A', // Green
    colorPale: '#F0FDF4',
    blocks: [
      { id: '01', plants: 100 },
      { id: '02', plants: 100 },
      { id: '03', plants: 70 },
    ],
  },
  D: {
    name: 'Zone D',
    color: '#2563EB', // Blue
    colorPale: '#EFF6FF',
    blocks: [
      { id: '01', plants: 200 },
      { id: '02', plants: 200 },
      { id: '03', plants: 200 },
      { id: '04', plants: 200 },
      { id: '05', plants: 200 },
    ],
  },
};

/**
 * Gets the list of pre-selected tracked plant numbers for a given block.
 * - Zone A, B, C: 5 plants per block, evenly spaced.
 * - Zone D: 8 plants per block, evenly spaced.
 */
export function getTrackedPlants(zone: string, blockId: string): number[] {
  const zoneInfo = PLANTATION[zone];
  if (!zoneInfo) return [];
  const block = zoneInfo.blocks.find(b => b.id === blockId);
  if (!block) return [];

  const maxPlants = block.plants;
  const count = zone === 'D' ? 8 : 5;

  if (maxPlants <= count) {
    // If fewer or equal plants than count, track all of them
    return Array.from({ length: maxPlants }, (_, i) => i + 1);
  }

  // Calculate spacing
  // For Zone D (200 plants): 1, 25, 50, 75, 100, 125, 150, 175
  // For Zone A, B, C (100 plants): 1, 20, 40, 60, 80
  const result: number[] = [];
  const step = Math.floor(maxPlants / count);
  for (let i = 0; i < count; i++) {
    const num = 1 + i * step;
    if (num <= maxPlants) {
      result.push(num);
    }
  }
  return result;
}

/**
 * Format plant ID: e.g. A01-P020
 */
export function formatPlantId(zone: string, blockId: string, plantNumber: number): string {
  const blockStr = blockId.padStart(2, '0');
  const plantStr = String(plantNumber).padStart(3, '0');
  return `${zone}${blockStr}-P${plantStr}`;
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Map, ChevronRight } from 'lucide-react';
import { PLANTATION } from '../../lib/plantData';
import { getSubmissions, getPlants, getInspections } from '../../lib/offline-db';
import { supabase } from '../../lib/supabaseClient';

export default function DigitalTwinPage() {
  const router = useRouter();
  const [activeZone, setActiveZone] = useState<string>('All');
  const [activeHealth, setActiveHealth] = useState<string>('All');
  const [blockStatus, setBlockStatus] = useState<
    Record<string, { status: 'healthy' | 'warning' | 'danger'; deadCount: number }>
  >({});

  const getBlockCategory = (zone: string, blockId: string): 'Healthy' | 'Moderate' | 'High Risk' | 'Dead' => {
    const bStatus = blockStatus[`${zone}-${blockId}`];
    if (!bStatus) return 'Healthy';
    if (bStatus.deadCount > 0) return 'Dead';
    if (bStatus.status === 'danger') return 'High Risk';
    if (bStatus.status === 'warning') return 'Moderate';
    return 'Healthy';
  };

  const getHealthFilterCount = (statusVal: string) => {
    let count = 0;
    Object.entries(PLANTATION).forEach(([z, zd]) => {
      if (activeZone === 'All' || activeZone === z) {
        zd.blocks.forEach(b => {
          const category = getBlockCategory(z, b.id);
          if (statusVal === category) {
            count++;
          }
        });
      }
    });
    return count;
  };

  const healthFilters = [
    { label: 'All', value: 'All' },
    { label: 'Healthy', value: 'Healthy' },
    { label: 'Moderate', value: 'Moderate' },
    { label: 'High Risk', value: 'High Risk' },
    { label: 'Dead', value: 'Dead' },
  ];

  useEffect(() => {
    const calcHealth = async () => {
      // Helper to parse dates robustly
      const parseDateMs = (dateVal: any): number => {
        if (!dateVal) return 0;
        if (typeof dateVal === 'number') return dateVal;
        if (dateVal instanceof Date) return dateVal.getTime();
        
        let str = String(dateVal).trim();
        let t = Date.parse(str);
        if (!isNaN(t)) return t;
        
        // Handle database date space replacing
        str = str.replace(' ', 'T');
        t = Date.parse(str);
        if (!isNaN(t)) return t;
        
        return 0;
      };

      // 1. Fetch plants (to map plant_id -> zone, block)
      let plantList: any[] = [];
      try {
        const local = await getPlants();
        const { data: remote } = await supabase.from('plants').select('plant_id, zone, block');
        
        const merged: Record<string, any> = {};
        (remote || []).forEach(p => {
          if (p.plant_id) merged[p.plant_id] = p;
        });
        local.forEach(p => {
          if (p.plant_id) merged[p.plant_id] = { ...merged[p.plant_id], ...p };
        });
        plantList = Object.values(merged);
      } catch (err) {
        console.error('Error fetching plants for health calc:', err);
      }

      // Build a map of plant_id -> { zone, block } (ONLY for registered plants)
      const plantMap: Record<string, { zone: string; block: string }> = {};
      plantList.forEach(p => {
        if (p.plant_id && p.zone && p.block) {
          plantMap[p.plant_id] = { zone: p.zone, block: p.block };
        }
      });

      // 2. Fetch inspections
      let inspectionList: any[] = [];
      try {
        const localInsp = await getInspections();
        const { data: remoteInsp } = await supabase
          .from('inspections')
          .select('id, plant_id, inspection_date, soil_ph, foliage_color, created_at');

        const mergedInsp: Record<string, any> = {};
        (remoteInsp || []).forEach(i => {
          if (i.id) mergedInsp[i.id] = i;
        });
        localInsp.forEach(i => {
          if (i.id) mergedInsp[i.id] = { ...mergedInsp[i.id], ...i };
        });
        
        inspectionList = Object.values(mergedInsp);
      } catch (err) {
        console.error('Error fetching inspections for health calc:', err);
      }

      // Group inspections by plant_id and keep only the latest one for each registered plant
      const latestInspectionsByPlant: Record<string, any> = {};
      inspectionList.forEach(i => {
        const pid = i.plant_id;
        if (!pid || !plantMap[pid]) return; // Only process inspections for registered plants!
        
        const currentLatest = latestInspectionsByPlant[pid];
        const dateA = parseDateMs(i.inspection_date || i.created_at);
        const dateB = currentLatest ? parseDateMs(currentLatest.inspection_date || currentLatest.created_at) : 0;
        if (!currentLatest || dateA > dateB) {
          latestInspectionsByPlant[pid] = i;
        }
      });

      // Also support legacy submissions if they exist in IndexedDB and are for registered plants
      try {
        const legacySubmissions = await getSubmissions();
        legacySubmissions.forEach(s => {
          const pid = s.plant_id;
          if (!pid || !plantMap[pid]) return; // Only process legacy submissions for registered plants!
          
          const currentLatest = latestInspectionsByPlant[pid];
          const dateA = parseDateMs(s.submitted_at || s.created_at);
          const dateB = currentLatest ? parseDateMs(currentLatest.inspection_date || currentLatest.created_at || currentLatest.submitted_at) : 0;
          if (!currentLatest || dateA > dateB) {
            latestInspectionsByPlant[pid] = {
              plant_id: pid,
              inspection_date: s.submitted_at || s.created_at,
              soil_ph: s.soil_pH ?? s.soil_ph,
              foliage_color: s.foliage_color
            };
          }
        });
      } catch (err) {
        console.error('Error fetching legacy submissions for health calc:', err);
      }

      // Initialize map with default 'healthy' status
      const map: Record<string, { status: 'healthy' | 'warning' | 'danger'; deadCount: number }> = {};
      Object.entries(PLANTATION).forEach(([z, zd]) =>
        zd.blocks.forEach(b => { map[`${z}-${b.id}`] = { status: 'healthy', deadCount: 0 }; })
      );

      // Group registered plants by block
      const blockPlants: Record<string, string[]> = {};
      Object.entries(plantMap).forEach(([pid, loc]) => {
        const blockKey = `${loc.zone}-${loc.block}`;
        if (!blockPlants[blockKey]) {
          blockPlants[blockKey] = [];
        }
        blockPlants[blockKey].push(pid);
      });

      // For each block, calculate overall status based on the derived health of all its registered plants
      Object.entries(blockPlants).forEach(([blockKey, pids]) => {
        if (!map[blockKey]) return;
        
        let hasDanger = false;
        let hasWarning = false;
        let deadCount = 0;

        pids.forEach(pid => {
          const insp = latestInspectionsByPlant[pid];
          if (!insp) return; // No inspection defaults to healthy, doesn't trigger warning/danger
          
          const pH = insp.soil_ph ?? insp.soil_pH;
          const f = insp.foliage_color;
          
          // Match the exact deriveHealth logic of block details page
          let plantHealth: 'healthy' | 'moderate' | 'high-risk' | 'dead' = 'healthy';
          if (f === 'Red') {
            plantHealth = 'dead';
            deadCount += 1;
          } else if (f === 'Brown' || pH < 5.5 || pH > 7.0) {
            plantHealth = 'high-risk';
          } else if (f === 'Yellow' || f === 'Mixed' || (pH >= 5.5 && pH < 6.0) || (pH > 6.5 && pH <= 7.0)) {
            plantHealth = 'moderate';
          }

          if (plantHealth === 'high-risk' || plantHealth === 'dead') {
            hasDanger = true;
          } else if (plantHealth === 'moderate') {
            hasWarning = true;
          }
        });

        map[blockKey].deadCount = deadCount;
        if (hasDanger) {
          map[blockKey].status = 'danger';
        } else if (hasWarning) {
          map[blockKey].status = 'warning';
        }
      });

      setBlockStatus(map);
    };
    calcHealth();
  }, []);

  const getStyles = (zone: string, blockId: string) => {
    const s = blockStatus[`${zone}-${blockId}`]?.status || 'healthy';
    if (s === 'danger') return {
      card: 'bg-red-50 border-red-400/60 hover:bg-red-100/60',
      badge: 'bg-red-500 text-white', label: 'Danger', dot: 'bg-red-500'
    };
    if (s === 'warning') return {
      card: 'bg-amber-50 border-amber-400/60 hover:bg-amber-100/60',
      badge: 'bg-amber-500 text-white', label: 'Warning', dot: 'bg-amber-500'
    };
    return {
      card: 'bg-green-50/60 border-green-700/25 hover:bg-green-50',
      badge: 'bg-primary text-white', label: 'Healthy', dot: 'bg-green-500'
    };
  };

  const blocks: Array<{ zone: string; id: string; plants: number }> = [];
  Object.entries(PLANTATION).forEach(([z, zd]) => {
    if (activeZone === 'All' || activeZone === z) {
      zd.blocks.forEach(b => {
        const category = getBlockCategory(z, b.id);
        if (activeHealth === 'All' || activeHealth === category) {
          blocks.push({ zone: z, id: b.id, plants: b.plants });
        }
      });
    }
  });

  return (
    <div className="flex flex-col bg-surface min-h-screen">
      {/* Header */}
      <div className="bg-primary text-white px-5 py-5 rounded-b-3xl shadow-md">
        <span className="text-[10px] uppercase font-bold tracking-widest text-green-light flex items-center gap-1">
          <Map className="h-3 w-3" /> Digital Twin Map
        </span>
        <h1 className="text-xl font-extrabold mt-0.5">Plantation Map</h1>
        <p className="text-xs text-green-pale/85 mt-0.5 font-medium">19 Blocks • Galagedara, LK</p>
      </div>

      {/* Zone filter */}
      <div className="px-4 py-3 flex gap-2 overflow-x-auto scrollbar-none bg-white border-b border-border-light">
        {['All', 'A', 'B', 'C', 'D'].map(z => (
          <button
            key={z}
            onClick={() => {
              setActiveZone(z);
              setActiveHealth('All');
            }}
            className={`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all ${
              activeZone === z ? 'bg-primary text-white shadow-sm' : 'bg-pale-green text-primary hover:bg-pale-green/80'
            }`}
          >
            {z === 'All' ? 'Show All' : `Zone ${z}`}
          </button>
        ))}
      </div>

      {/* Health status filter */}
      <div className="px-4 py-2 flex gap-1.5 overflow-x-auto scrollbar-none bg-white border-b border-border-light">
        {healthFilters.map(filter => {
          const count = getHealthFilterCount(filter.value);
          const isActive = activeHealth === filter.value;
          return (
            <button
              key={filter.value}
              onClick={() => setActiveHealth(filter.value)}
              className={`px-3 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap border transition-all ${
                isActive
                  ? 'bg-primary text-white border-primary shadow-sm font-bold'
                  : 'bg-white text-text-secondary border-border-light hover:bg-surface-container'
              }`}
            >
              {filter.label}{filter.value !== 'All' && ` (${count})`}
            </button>
          );
        })}
      </div>

      {/* Block grid */}
      <div className="p-5 pb-28">
        <h2 className="text-xs font-bold uppercase tracking-widest text-text-secondary mb-3">Plantation Layout</h2>
        <div className="grid grid-cols-2 gap-3">
          {blocks.map(block => {
            const s = getStyles(block.zone, block.id);
            return (
              <button
                key={`${block.zone}-${block.id}`}
                onClick={() => router.push(`/blocks/${block.zone}/${block.id}`)}
                className={`p-4 border-2 rounded-2xl text-left transition-all shadow-sm flex flex-col justify-between h-32 active:scale-95 ${s.card}`}
              >
                <div className="flex justify-between items-start w-full">
                  <div>
                    <span className="text-[9px] font-extrabold uppercase opacity-75 tracking-wider block">Zone {block.zone}</span>
                    <span className="text-base font-black mt-0.5 block">Block {block.id}</span>
                  </div>
                  <span className={`text-[8px] font-bold px-2 py-0.5 rounded-full uppercase ${s.badge}`}>
                    {s.label}
                  </span>
                </div>
                <div className="flex justify-between items-center w-full border-t border-black/5 pt-2.5">
                  <span className="text-[10px] font-semibold opacity-75">{block.plants} plants</span>
                  <span className="text-[10px] font-bold text-primary flex items-center gap-0.5">
                    View <ChevronRight className="h-3 w-3" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

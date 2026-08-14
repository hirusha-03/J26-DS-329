'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, X, QrCode, Plus, ChevronRight, RefreshCw, Leaf } from 'lucide-react';
import { supabase } from '../../../../lib/supabaseClient';
import { getPlants, getMortalityReports } from '../../../../lib/offline-db';
import { PLANTATION } from '../../../../lib/plantData';

type HealthStatus = 'healthy' | 'moderate' | 'high-risk' | 'dead';

interface PlantWithHealth {
  plant_id: string;
  zone: string;
  block: string;
  plant_no: number;
  common_name: string;
  variety: string;
  plant_type: string;
  planted_date: string;
  sync_status: string;
  health: HealthStatus;
  lastInspectionDate: string | null;
  lastVineHeight: number | null;
  slot_id?: string;
  generation?: number;
}

function deriveHealth(insp: any): HealthStatus {
  if (!insp) return 'healthy';
  const pH = insp.soil_ph ?? insp.soil_pH;
  const f = insp.foliage_color;
  if (f === 'Red') return 'dead';
  if (f === 'Brown' || pH < 5.5 || pH > 7.0) return 'high-risk';
  if (f === 'Yellow' || f === 'Mixed' || (pH >= 5.5 && pH < 6.0) || (pH > 6.5 && pH <= 7.0)) return 'moderate';
  return 'healthy';
}

function formatPlantCardDate(plant: any): string {
  const dateVal = plant.planted_date || plant.created_at || plant.lastInspectionDate;
  if (!dateVal) return 'No Date';
  const dateObj = new Date(dateVal);
  if (isNaN(dateObj.getTime())) {
    // If it's something like "2026-07-11", try parsing manually
    return String(dateVal);
  }
  return dateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

export default function BlockRegistryPage({ params }: { params: Promise<{ zone: string; block: string }> }) {
  const { zone, block } = use(params);
  const router = useRouter();

  const [plants, setPlants] = useState<PlantWithHealth[]>([]);
  const [deadVinesCount, setDeadVinesCount] = useState(0);
  const [deadTreesCount, setDeadTreesCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const blockInfo = PLANTATION[zone]?.blocks.find(b => b.id === block);
  const totalCapacity = blockInfo?.plants || 0;

  const loadPlants = async () => {
    setLoading(true);
    try {
      // 1. Fetch local plants for this block
      const local = await getPlants();
      const localBlock = local.filter(p => p.zone === zone && p.block === block);

      // 2. Fetch remote plants from Supabase
      const { data: remote } = await supabase
        .from('plants')
        .select('*')
        .eq('zone', zone)
        .eq('block', block)
        .order('plant_no', { ascending: true });

      // Merge plants (determine sync_status)
      const merged = new Map<string, any>();
      (remote || []).forEach(p => {
        merged.set(p.plant_id, { ...p, sync_status: 'synced' });
      });
      localBlock.forEach(p => {
        const existing = merged.get(p.plant_id);
        if (existing) {
          merged.set(p.plant_id, { ...existing, ...p, sync_status: 'synced' });
        } else {
          merged.set(p.plant_id, { ...p, sync_status: p.sync_status || 'pending' });
        }
      });

      const plantList = Array.from(merged.values());

      // 3. Fetch latest inspections for this block's plants
      let enrichmentMap: Record<string, PlantWithHealth> = {};
      if (plantList.length > 0) {
        const { data: inspections } = await supabase
          .from('inspections')
          .select('plant_id, inspection_date, soil_ph, foliage_color, vine_height_cm')
          .in('plant_id', plantList.map(p => p.plant_id))
          .order('inspection_date', { ascending: false });

        const latestInsp: Record<string, any> = {};
        (inspections || []).forEach(i => {
          if (!latestInsp[i.plant_id]) {
            latestInsp[i.plant_id] = i;
          }
        });

        plantList.forEach(p => {
          enrichmentMap[p.plant_id] = {
            ...p,
            health: deriveHealth(latestInsp[p.plant_id]),
            lastInspectionDate: latestInsp[p.plant_id]?.inspection_date || null,
            lastVineHeight: latestInsp[p.plant_id]?.vine_height_cm || null,
          };
        });
      }

      const sortedPlants = Object.values(enrichmentMap).sort(
        (a, b) => (a.plant_no || 0) - (b.plant_no || 0)
      );
      setPlants(sortedPlants);

      // 4. Fetch mortality reports for stats
      const localMortality = await getMortalityReports();
      const localBlockMortality = localMortality.filter(
        r => r.zone === zone && r.block === block
      );

      const { data: remoteMortality } = await supabase
        .from('mortality_reports')
        .select('*')
        .eq('zone', zone)
        .eq('block', block);

      const mergedMortality = new Map<string, any>();
      (remoteMortality || []).forEach(r => {
        mergedMortality.set(r.id, r);
      });
      localBlockMortality.forEach(r => {
        mergedMortality.set(r.id, { ...mergedMortality.get(r.id), ...r });
      });

      let totalDeadVines = 0;
      let totalDeadTrees = 0;
      mergedMortality.forEach(r => {
        totalDeadVines += Number(r.dead_vines || 0);
        totalDeadTrees += Number(r.dead_support_trees || 0);
      });

      setDeadVinesCount(totalDeadVines);
      setDeadTreesCount(totalDeadTrees);
    } catch (err) {
      console.error('Error loading plants:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlants();
  }, [zone, block]);



  return (
    <div className="flex flex-col bg-surface min-h-screen pb-32">
      {/* Header matching 1st Image */}
      <div className="bg-primary text-white px-5 py-4 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="text-white hover:opacity-85 transition-opacity"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div>
            <span className="text-[10px] uppercase font-bold text-green-light block tracking-widest leading-none">
              Zone {zone}
            </span>
            <h1 className="text-base font-extrabold mt-0.5 leading-none">
              Block {block} – Plants
            </h1>
          </div>
        </div>
        <button
          onClick={() => router.push('/digital-twin')}
          className="text-white hover:opacity-85 transition-opacity"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Main Content Area */}
      {/* Three Stats Cards */}
      <div className="grid grid-cols-3 gap-3 px-5 pt-5">
        <div className="bg-white border border-border-light rounded-2xl p-3.5 shadow-sm">
          <span className="text-[10px] uppercase font-bold text-text-secondary tracking-wider block leading-tight">
            Total Plants
          </span>
          <span className="text-xl font-black text-text-primary block mt-1">
            {totalCapacity}
          </span>
        </div>
        <div className="bg-white border border-border-light rounded-2xl p-3.5 shadow-sm">
          <span className="text-[10px] uppercase font-bold text-text-secondary tracking-wider block leading-tight">
            Dead Vines
          </span>
          <span className="text-xl font-black text-text-primary block mt-1">
            {deadVinesCount}
          </span>
        </div>
        <div className="bg-white border border-border-light rounded-2xl p-3.5 shadow-sm">
          <span className="text-[10px] uppercase font-bold text-text-secondary tracking-wider block leading-tight">
            Dead Trees
          </span>
          <span className="text-xl font-black text-text-primary block mt-1">
            {deadTreesCount}
          </span>
        </div>
      </div>

      {/* Registered Plants Header & Alert */}
      <div className="px-5 pt-6 pb-2">
        <h2 className="text-[11px] font-extrabold uppercase tracking-widest text-text-secondary">
          Registered Plants ({plants.length})
        </h2>
      </div>

      {plants.length === 0 && (
        <div className="mx-5 mb-2 bg-[#FFF9F2] border border-[#F5E6D3] rounded-xl p-4 text-[#A05E2B] text-xs font-semibold shadow-sm">
          No plants registered in this block yet.
        </div>
      )}

      {/* Registered Plant IDs Quick Links */}
      {plants.length > 0 && (
        <div className="px-5 pt-3 pb-3">
          <h3 className="text-[10px] uppercase font-bold text-text-secondary tracking-widest mb-2.5">
            Registered Plant IDs
          </h3>
          <div className="flex gap-2 mb-3 overflow-x-auto scrollbar-none animate-in fade-in duration-300">
            {plants.map(plant => {
              const plantNo = plant.plant_no || 1;
              return (
                <button
                  key={plant.plant_id}
                  onClick={() => router.push(`/plant/${plant.plant_id}`)}
                  className="px-4 py-2 rounded-xl text-xs font-bold border shadow-sm transition-all duration-200 active:scale-95 bg-green-50 text-green-700 border-green-200 hover:border-green-300"
                >
                  #{String(plantNo).padStart(3, '0')}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-text-secondary font-medium">
            Tap any ID to view plant details.
          </p>
        </div>
      )}

      {/* Plants Card List */}
      <div className="px-5 pt-2 space-y-3">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent mb-2.5" />
            <p className="text-xs font-semibold">Loading block registry...</p>
          </div>
        ) : (
          plants.map(plant => (
            <button
              key={plant.plant_id}
              onClick={() => router.push(`/plant/${plant.plant_id}`)}
              className="w-full text-left bg-white rounded-2xl border border-border-light p-4 shadow-sm flex items-center justify-between hover:shadow-md hover:border-primary/20 active:scale-[0.99] transition-all duration-200"
            >
              <div className="flex items-center gap-4">
                {/* Dynamic Zone Badge */}
                <div
                  style={{
                    backgroundColor: PLANTATION[zone]?.colorPale || '#FEF2F2',
                    color: PLANTATION[zone]?.color || '#DC2626',
                  }}
                  className="w-12 h-12 rounded-xl flex flex-col items-center justify-center font-bold"
                >
                  <span className="text-[8px] uppercase tracking-wider opacity-85">Zone</span>
                  <span className="text-lg font-black leading-none mt-0.5">{zone}</span>
                </div>

                {/* Center Details */}
                <div>
                  <h4 className="text-sm font-black text-text-primary leading-tight">
                    {plant.slot_id ? `${plant.slot_id} · G${plant.generation || 1}` : plant.plant_id}
                  </h4>
                  <p className="text-[10px] text-text-secondary mt-0.5">
                    {plant.common_name || 'Vanilla'} • {plant.variety || 'Local'} • Block {block}
                  </p>
                  <p className="text-[10px] text-text-secondary mt-0.5">
                    {plant.plant_type || 'Cutting'} • {formatPlantCardDate(plant)}
                  </p>
                </div>
              </div>

              {/* Right Side: QR and Status Badge */}
              <div className="flex flex-col items-end justify-between h-12">
                <QrCode className="h-5 w-5 text-text-secondary opacity-40" />
                <span
                  className={`text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded ${
                    plant.sync_status === 'pending'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-green-100 text-green-800'
                  }`}
                >
                  {plant.sync_status === 'pending' ? 'PENDING' : 'SYNCED'}
                </span>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Sticky Bottom Glassmorphic Button */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white/70 backdrop-blur-md border-t border-border-light/45 px-5 py-4 z-40">
        <button
          onClick={() => router.push(`/add-plant?zone=${zone}&block=${block}`)}
          className="w-full bg-primary text-white py-3.5 rounded-full shadow-lg flex items-center justify-center gap-2 font-bold hover:bg-primary/95 active:scale-[0.98] transition-all"
        >
          <Plus className="h-5 w-5" />
          <span>Add New Plant</span>
        </button>
      </div>
    </div>
  );
}

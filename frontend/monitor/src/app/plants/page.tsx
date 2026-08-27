'use client';

import { useEffect, useState, useRef } from 'react';
import { Sprout, Search, X, QrCode, Download, MapPin, Calendar, Leaf, TreePine, FlaskConical, Ruler, ArrowLeft, RefreshCw } from 'lucide-react';
import { getPlants, getSlot } from '../../lib/offline-db';
import { supabase } from '../../lib/supabaseClient';
import QRCode from 'qrcode';
import Link from 'next/link';

export default function PlantsPage() {
  const [plants, setPlants] = useState<any[]>([]);
  const [filtered, setFiltered] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedPlant, setSelectedPlant] = useState<any>(null);
  const [plantLocation, setPlantLocation] = useState<any>(null);
  const [qrUrl, setQrUrl] = useState<string>('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const loadPlants = async () => {
    setLoading(true);
    try {
      // Load from IndexedDB first
      const localPlants = await getPlants();

      // Merge with Supabase
      const { data: remotePlants } = await supabase
        .from('plants')
        .select('*')
        .order('created_at', { ascending: false });

      // Merge: prefer local for pending items, use remote for synced
      const merged = new Map<string, any>();
      (remotePlants || []).forEach(p => merged.set(p.plant_id, p));
      localPlants.forEach(p => merged.set(p.plant_id, { ...merged.get(p.plant_id), ...p }));

      const all = Array.from(merged.values()).sort((a, b) =>
        new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );
      setPlants(all);
      setFiltered(all);
    } catch (err) {
      console.error('Error loading plants:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlants();
  }, []);

  useEffect(() => {
    const q = search.toLowerCase();
    if (!q) {
      setFiltered(plants);
    } else {
      setFiltered(
        plants.filter(
          p =>
            p.plant_id?.toLowerCase().includes(q) ||
            p.zone?.toLowerCase().includes(q) ||
            p.block?.toLowerCase().includes(q) ||
            p.common_name?.toLowerCase().includes(q) ||
            p.variety?.toLowerCase().includes(q)
        )
      );
    }
  }, [search, plants]);

  const openPlant = async (plant: any) => {
    setSelectedPlant(plant);
    setQrUrl('');

    // Load location
    if (plant.slot_id) {
      const loc = await getSlot(plant.slot_id);
      if (!loc) {
        const { data } = await supabase
          .from('slots')
          .select('*')
          .eq('slot_id', plant.slot_id)
          .maybeSingle();
        setPlantLocation(data || null);
      } else {
        setPlantLocation(loc);
      }
    } else {
      setPlantLocation(null);
    }
  };

  // Generate QR code when modal opens
  useEffect(() => {
    if (!selectedPlant || !canvasRef.current) return;
    const qrData = JSON.stringify({
      plant_id: selectedPlant.plant_id,
      zone: selectedPlant.zone,
      block: selectedPlant.block,
      plant_no: String(selectedPlant.plant_no)
    });
    QRCode.toCanvas(canvasRef.current, qrData, { width: 200, margin: 2 }, (err) => {
      if (!err && canvasRef.current) {
        setQrUrl(canvasRef.current.toDataURL('image/png'));
      }
    });
  }, [selectedPlant]);

  const closeModal = () => {
    setSelectedPlant(null);
    setPlantLocation(null);
    setQrUrl('');
  };

  const zoneColor: Record<string, string> = {
    A: 'bg-red-100 text-red-700 border-red-200',
    B: 'bg-amber-100 text-amber-700 border-amber-200',
    C: 'bg-green-100 text-green-700 border-green-200',
    D: 'bg-blue-100 text-blue-700 border-blue-200',
  };

  const syncBadge = (status: string) =>
    status === 'synced'
      ? 'bg-pale-green text-primary'
      : 'bg-amber-warning/20 text-amber-700';

  return (
    <div className="flex flex-col bg-surface min-h-screen pb-24">
      {/* Header */}
      <div className="bg-primary text-white px-5 py-5 rounded-b-3xl shadow-md space-y-4">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="hover:opacity-80">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              <span className="text-[10px] uppercase font-bold tracking-widest text-green-light flex items-center gap-1">
                <Sprout className="h-3 w-3" />
                Plant Registry
              </span>
              <h1 className="text-xl font-extrabold mt-0.5">Registered Plants</h1>
            </div>
          </div>
          <button
            onClick={loadPlants}
            disabled={loading}
            className="h-9 w-9 bg-white/10 border border-white/20 rounded-full flex items-center justify-center hover:bg-white/20"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Search */}
        <div className="relative flex items-center bg-white/10 border border-white/20 rounded-2xl px-4 py-2.5">
          <Search className="h-4 w-4 text-white/60 mr-2 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search by Plant ID, zone, variety..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent text-xs text-white placeholder:text-white/55 outline-none flex-1 font-semibold"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-white/60 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-white/10 rounded-2xl p-2.5 text-center">
            <span className="text-[9px] uppercase font-bold text-green-light/70 block">Total</span>
            <span className="text-base font-black block mt-0.5">{plants.length}</span>
          </div>
          <div className="bg-white/10 rounded-2xl p-2.5 text-center">
            <span className="text-[9px] uppercase font-bold text-green-light/70 block">Synced</span>
            <span className="text-base font-black block mt-0.5 text-green-300">
              {plants.filter(p => p.sync_status === 'synced').length}
            </span>
          </div>
          <div className="bg-white/10 rounded-2xl p-2.5 text-center">
            <span className="text-[9px] uppercase font-bold text-green-light/70 block">Pending</span>
            <span className="text-base font-black block mt-0.5 text-amber-300">
              {plants.filter(p => p.sync_status === 'pending').length}
            </span>
          </div>
        </div>
      </div>

      {/* Plant List */}
      <div className="p-5 space-y-3">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-secondary">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mb-3" />
            <p className="text-xs font-semibold">Loading plants...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-dashed border-border-light rounded-3xl p-10 text-center text-text-secondary">
            <Sprout className="h-10 w-10 mx-auto mb-3 opacity-30 text-primary" />
            <p className="text-xs font-semibold">No plants found.</p>
            <p className="text-[10px] opacity-75 mt-1">Register a new plant from the Dashboard.</p>
            <Link
              href="/add-plant"
              className="inline-block mt-4 px-5 py-2.5 bg-primary text-white rounded-full text-xs font-bold hover:bg-primary/90 transition"
            >
              + Add New Plant
            </Link>
          </div>
        ) : (
          filtered.map(plant => (
            <button
              key={plant.plant_id}
              onClick={() => openPlant(plant)}
              className="w-full text-left bg-white rounded-2xl border border-border-light p-4 shadow-xs flex items-center gap-4 hover:shadow-md hover:border-primary/25 transition-all duration-200"
            >
              {/* Zone badge */}
              <div className={`h-12 w-12 rounded-xl flex-shrink-0 flex flex-col items-center justify-center border font-black text-sm ${zoneColor[plant.zone] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                <span className="text-[9px] font-bold opacity-70 leading-none">Zone</span>
                <span>{plant.zone}</span>
              </div>

              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-black text-text-primary truncate">{plant.plant_id}</h4>
                <p className="text-[10px] text-text-secondary mt-0.5">
                  {plant.common_name || 'Vanilla'} • {plant.variety || 'Local'} • Block {plant.block}
                </p>
                <p className="text-[10px] text-text-secondary">
                  {plant.plant_type || 'Cutting'} · {plant.planted_date ? new Date(plant.planted_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date unknown'}
                </p>
              </div>

              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <QrCode className="h-4 w-4 text-text-secondary opacity-60" />
                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase ${syncBadge(plant.sync_status)}`}>
                  {plant.sync_status || 'pending'}
                </span>
              </div>
            </button>
          ))
        )}
      </div>

      {/* ── MODAL: PLANT DETAILS ── */}
      {selectedPlant && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm max-h-[92vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200">
            
            {/* Modal Header */}
            <div className="bg-primary px-5 py-4 text-white flex justify-between items-center rounded-t-3xl flex-shrink-0">
              <div>
                <span className="text-[9px] uppercase font-bold text-green-light tracking-widest">
                  Plant Profile
                </span>
                <h3 className="font-extrabold text-base mt-0.5">{selectedPlant.plant_id}</h3>
              </div>
              <button onClick={closeModal} className="text-white/80 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Scrollable content */}
            <div className="overflow-y-auto flex-1 p-5 space-y-4">

              {/* QR Code Section */}
              <div className="bg-surface border border-border-light rounded-2xl p-4 flex flex-col items-center gap-3">
                <span className="text-[9px] uppercase font-bold text-text-secondary tracking-widest flex items-center gap-1">
                  <QrCode className="h-3 w-3" /> Plant QR Code
                </span>
                <div className="bg-white border border-border-light rounded-xl p-3 shadow-sm">
                  <canvas ref={canvasRef} className="max-w-full" />
                </div>
                <p className="text-[9px] text-text-secondary text-center leading-relaxed max-w-[220px]">
                  Affix this sticker to the support tree for scanning during inspections.
                </p>
                {qrUrl && (
                  <a
                    href={qrUrl}
                    download={`QR_${selectedPlant.plant_id}.png`}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full text-xs font-bold hover:bg-primary/90 transition"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download QR Code
                  </a>
                )}
              </div>

              {/* Identification */}
              <Section title="Identification" icon={<Leaf className="h-3 w-3" />}>
                <Row label="Common Name" value={selectedPlant.common_name} />
                <Row label="Latin Name" value={selectedPlant.latin_name} />
                <Row label="Scientific Name" value={selectedPlant.scientific_name} />
                <Row label="Variety" value={selectedPlant.variety} />
                <Row label="Plant Type" value={selectedPlant.plant_type} />
              </Section>

              {/* Purchase Details */}
              <Section title="Purchase & Origin" icon={<Calendar className="h-3 w-3" />}>
                <Row label="Purchased From" value={selectedPlant.purchased_from} />
                <Row label="Purchase Date" value={selectedPlant.purchase_date} />
                <Row label="Planting Date" value={selectedPlant.planted_date} />
                <Row label="Purchase Condition" value={selectedPlant.purchase_condition} />
                <Row label="Max Cutting Height" value={selectedPlant.max_cutting_height_cm ? `${selectedPlant.max_cutting_height_cm} cm` : null} />
              </Section>

              {/* Field Layout */}
              <Section title="Field Layout" icon={<TreePine className="h-3 w-3" />}>
                <Row label="Planting Arrangement" value={selectedPlant.planting_arrangement} />
                <Row label="Spacing (Hedges)" value={selectedPlant.spacing_between_hedges} />
                <Row label="Spacing (Rows)" value={selectedPlant.spacing_between_rows} />
                <Row label="Land Type" value={selectedPlant.land_type} />
                <Row label="Agri. Land Type" value={selectedPlant.agricultural_land_type} />
                <Row label="Landform" value={selectedPlant.landform_type} />
                <Row label="Support Tree" value={selectedPlant.support_tree_type} />
              </Section>

              {/* GPS */}
              {plantLocation && (
                <Section title="GPS Location" icon={<MapPin className="h-3 w-3" />}>
                  <Row label="Latitude" value={plantLocation.latitude?.toFixed(6)} />
                  <Row label="Longitude" value={plantLocation.longitude?.toFixed(6)} />
                  <Row label="Altitude" value={plantLocation.altitude ? `${plantLocation.altitude.toFixed(1)} m` : null} />
                  <Row label="Accuracy" value={plantLocation.accuracy ? `± ${plantLocation.accuracy.toFixed(1)} m` : null} />
                  {plantLocation.latitude && plantLocation.longitude && (
                    <a
                      href={`https://maps.google.com/?q=${plantLocation.latitude},${plantLocation.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] font-bold text-primary hover:underline mt-1"
                    >
                      <MapPin className="h-3 w-3" />
                      View on Google Maps
                    </a>
                  )}
                </Section>
              )}

              {/* Sync Status */}
              <div className="text-[9px] text-text-secondary border-t border-border-light pt-3 space-y-0.5 font-medium">
                <div>QR Code: <span className="font-bold text-text-primary">{selectedPlant.qr_code}</span></div>
                <div>Registered: {selectedPlant.created_at ? new Date(selectedPlant.created_at).toLocaleString() : 'Unknown'}</div>
                <div className="flex items-center gap-1 mt-1">
                  Sync Status:
                  <span className={`font-bold uppercase ml-1 ${selectedPlant.sync_status === 'synced' ? 'text-primary' : 'text-amber-700'}`}>
                    {selectedPlant.sync_status || 'pending'}
                  </span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-border-light flex gap-2 flex-shrink-0">
              <Link
                href={`/inspect/form?plant_id=${selectedPlant.plant_id}`}
                className="flex-1 bg-primary text-white py-3 rounded-full text-xs font-bold text-center hover:bg-primary/90 transition"
              >
                Inspect This Plant
              </Link>
              <button
                onClick={closeModal}
                className="px-5 border border-border-light text-text-secondary py-3 rounded-full text-xs font-bold hover:bg-surface transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper components
function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border-light rounded-2xl p-4 space-y-2.5">
      <span className="text-[9px] uppercase font-bold text-text-secondary tracking-widest flex items-center gap-1">
        {icon} {title}
      </span>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-[10px] text-text-secondary font-medium flex-shrink-0">{label}</span>
      <span className="text-[10px] font-bold text-text-primary text-right">{String(value)}</span>
    </div>
  );
}

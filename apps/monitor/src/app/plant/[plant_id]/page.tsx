'use client';

import { useEffect, useState, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, QrCode, MapPin, Download, ChevronRight,
  Leaf, Calendar, TreePine, Droplets, Thermometer,
  Camera, FileText, ClipboardCheck, Share2, Printer,
  RefreshCw, X, ExternalLink
} from 'lucide-react';
import QRCode from 'qrcode';
import { supabase } from '../../../lib/supabaseClient';

// ─── Types ───────────────────────────────────────────────────
type HealthStatus = 'healthy' | 'moderate' | 'high-risk' | 'dead' | 'unknown';

const HEALTH: Record<HealthStatus, { label: string; bg: string; text: string; dot: string }> = {
  healthy:    { label: 'Healthy',   bg: 'bg-green-100',  text: 'text-green-800',  dot: 'bg-green-500' },
  moderate:   { label: 'Moderate',  bg: 'bg-amber-100',  text: 'text-amber-800',  dot: 'bg-amber-400' },
  'high-risk':{ label: 'High Risk', bg: 'bg-orange-100', text: 'text-orange-800', dot: 'bg-orange-500' },
  dead:       { label: 'Dead',      bg: 'bg-red-100',    text: 'text-red-800',    dot: 'bg-red-600' },
  unknown:    { label: 'No Data',   bg: 'bg-gray-100',   text: 'text-gray-600',   dot: 'bg-gray-400' },
};

function deriveHealth(insp: any): HealthStatus {
  if (!insp) return 'unknown';
  const pH = insp.soil_ph ?? insp.soil_pH;
  const f = insp.foliage_color;
  if (f === 'Red') return 'dead';
  if (f === 'Brown' || pH < 5.5 || pH > 7.0) return 'high-risk';
  if (f === 'Yellow' || f === 'Mixed' || (pH >= 5.5 && pH < 6.0) || (pH > 6.5 && pH <= 7.0)) return 'moderate';
  return 'healthy';
}

function mapSunlight(val: string | null) {
  if (!val) return null;
  const mapping: Record<string, string> = {
    bright: 'Bright (7-9 bars, >20k lux)',
    bright_indirect: 'Bright indirect (4-6 bars, 10k-20k lux)',
    medium: 'Medium (2-3 bars, 1k-10k lux)',
    low: 'Low (0-1 bars, <1k lux)'
  };
  return mapping[val.toLowerCase()] || val;
}

function mapShade(val: string | null) {
  if (!val) return null;
  const mapping: Record<string, string> = {
    light: 'Light (0-25%)',
    partial: 'Partial (25-50%)',
    moderate: 'Moderate (50-70%)',
    heavy: 'Heavy (>70%)'
  };
  return mapping[val.toLowerCase()] || val;
}

// ─── Main Component ───────────────────────────────────────────
export default function PlantTwinPage({ params }: { params: Promise<{ plant_id: string }> }) {
  const { plant_id } = use(params);
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [plant, setPlant] = useState<any>(null);
  const [location, setLocation] = useState<any>(null);
  const [latestInsp, setLatestInsp] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [qrUrl, setQrUrl] = useState('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Load data ─────────────────────────────────────────────
  const loadData = async () => {
    setLoading(true);
    try {
      // Static plant data
      const { data: p } = await supabase.from('plants').select('*').eq('plant_id', plant_id).single();
      setPlant(p || null);

      // GPS
      if (p && p.slot_id) {
        const { data: loc } = await supabase.from('slots').select('*').eq('slot_id', p.slot_id).maybeSingle();
        setLocation(loc || null);
      } else {
        setLocation(null);
      }

      // Latest inspection only
      const { data: inspections } = await supabase
        .from('inspections')
        .select('*')
        .eq('plant_id', plant_id)
        .order('inspection_date', { ascending: false })
        .limit(1);

      setLatestInsp(inspections?.[0] || null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    const { data } = await supabase
      .from('inspections')
      .select('id, inspection_date, foliage_color, soil_ph, vine_height_cm, supervisor_name')
      .eq('plant_id', plant_id)
      .order('inspection_date', { ascending: false });
    setHistory(data || []);
    setHistoryLoading(false);
  };

  useEffect(() => { loadData(); }, [plant_id]);

  // ── QR Code ───────────────────────────────────────────────
  useEffect(() => {
    if (!plant || !canvasRef.current) return;
    const data = JSON.stringify({
      plant_id: plant.plant_id,
      zone: plant.zone,
      block: plant.block,
      plant_no: String(plant.plant_no).padStart(3, '0'),
    });
    QRCode.toCanvas(canvasRef.current, data, { width: 200, margin: 2 }, (err) => {
      if (!err && canvasRef.current) setQrUrl(canvasRef.current.toDataURL('image/png'));
    });
  }, [plant, showQrModal]);

  const health = deriveHealth(latestInsp);
  const hStyle = HEALTH[health];

  // ── Render helpers ────────────────────────────────────────
  const fmt = (v: any, suffix = '') => (v !== null && v !== undefined && v !== '') ? `${v}${suffix}` : '—';
  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

  if (loading) return (
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-text-secondary">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-xs font-semibold">Loading Digital Twin...</span>
      </div>
    </div>
  );

  if (!plant) return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-8 text-center">
      <div>
        <Leaf className="h-12 w-12 text-primary opacity-30 mx-auto mb-3" />
        <p className="text-sm font-bold text-text-primary">Plant not found</p>
        <p className="text-xs text-text-secondary mt-1">No record for {plant_id}</p>
        <button onClick={() => router.back()} className="mt-4 px-5 py-2.5 bg-primary text-white rounded-full text-xs font-bold">Go Back</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col bg-surface min-h-screen pb-32">

      {/* ── HEADER ── */}
      <div className="bg-primary text-white px-5 pt-5 pb-6 rounded-b-3xl shadow-lg">
        {/* Nav row */}
        <div className="flex items-center justify-between mb-5">
          <button onClick={() => router.back()} className="h-8 w-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex gap-2">
            <button onClick={() => { setShowQrModal(true); }} className="h-8 w-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
              <QrCode className="h-4 w-4" />
            </button>
            {location?.latitude && (
              <a
                href={`https://maps.google.com/?q=${location.latitude},${location.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="h-8 w-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20"
              >
                <MapPin className="h-4 w-4" />
              </a>
            )}
            <button onClick={loadData} className="h-8 w-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Plant identity */}
        <div className="flex items-start justify-between">
          <div>
            <span className="text-[9px] uppercase font-bold text-green-light tracking-widest">
              Zone {plant.zone} · Block {plant.block} {plant.slot_id ? `· Slot ${plant.slot_id}` : ''}
            </span>
            <h1 className="text-2xl font-black mt-1">
              {plant.slot_id ? `${plant.slot_id} · G${plant.generation || 1}` : plant.plant_id}
            </h1>
            <p className="text-[10px] text-green-pale/80 font-medium mt-0.5">
              Plant ID: {plant.plant_id}
            </p>
            <p className="text-[10px] text-green-pale/70 font-medium">
              {plant.common_name || 'Vanilla'} · {plant.variety || 'Local'} · {plant.plant_type || 'Cutting'}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase ${hStyle.bg} ${hStyle.text}`}>
              {hStyle.label}
            </span>
            {latestInsp && (
              <span className="text-[9px] text-green-pale/70 font-medium">
                Last: {fmtDate(latestInsp.inspection_date)}
              </span>
            )}
          </div>
        </div>

        {/* Key metrics strip */}
        {latestInsp && (
          <div className="grid grid-cols-3 gap-2 mt-5">
            <Metric label="Vine Height" value={latestInsp.vine_height_cm ? `${latestInsp.vine_height_cm} cm` : '—'} />
            <Metric label="Soil pH" value={fmt(latestInsp.soil_ph ?? latestInsp.soil_pH)} />
            <Metric label="Foliage" value={fmt(latestInsp.foliage_color)} />
          </div>
        )}
      </div>

      {/* ── CONTENT SECTIONS ── */}
      <div className="px-5 pt-5 space-y-4">

        {/* Section 1 — Basic Information */}
        <Section title="Basic Information" icon={<Leaf className="h-3.5 w-3.5" />}>
          <Row label="Common Name" value={plant.common_name} />
          <Row label="Latin Name" value={plant.latin_name} />
          <Row label="Scientific Name" value={plant.scientific_name} />
          <Row label="Variety" value={plant.variety} />
          <Row label="Type of Plant" value={plant.plant_type} />
        </Section>

        {/* Lineage Information */}
        {(plant.previous_plant_id || plant.replaced_by_plant_id) && (
          <Section title="Vine Lineage & Replacements" icon={<RefreshCw className="h-3.5 w-3.5" />}>
            {plant.previous_plant_id && (
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-text-secondary font-medium">Previous Generation</span>
                <button
                  onClick={() => router.push(`/plant/${plant.previous_plant_id}`)}
                  className="font-bold text-primary hover:underline"
                >
                  View Previous Vine (G{(plant.generation || 2) - 1})
                </button>
              </div>
            )}
            {plant.replaced_by_plant_id && (
              <div className="flex justify-between items-center text-[10px] mt-2 pt-2 border-t border-border-light">
                <span className="text-text-secondary font-medium">Replaced By</span>
                <button
                  onClick={() => router.push(`/plant/${plant.replaced_by_plant_id}`)}
                  className="font-bold text-amber-600 hover:underline"
                >
                  View Successor Vine (G{(plant.generation || 1) + 1})
                </button>
              </div>
            )}
          </Section>
        )}

        {/* Section 2 — Purchase Information */}
        <Section title="Purchase Information" icon={<Calendar className="h-3.5 w-3.5" />}>
          <Row label="Purchase Date" value={fmtDate(plant.purchase_date)} />
          <Row label="Date of Planting" value={fmtDate(plant.planted_date)} />
          <Row label="Purchased From" value={plant.purchased_from} />
          <Row label="Purchase Condition" value={plant.purchase_condition} />
          <Row label="Maximum Cutting Height" value={plant.max_cutting_height_cm ? `${plant.max_cutting_height_cm} cm` : null} />
        </Section>

        {/* Section 3 — Planting Information */}
        <Section title="Planting Information" icon={<TreePine className="h-3.5 w-3.5" />}>
          <Row label="Planting Arrangement" value={plant.planting_arrangement} />
          <Row label="Spacing Between Hedges" value={plant.spacing_between_hedges} />
          <Row label="Spacing Between Rows" value={plant.spacing_between_rows} />
          <Row label="Type of Land" value={plant.land_type} />
          <Row label="Agricultural Land Type" value={plant.agricultural_land_type} />
          <Row label="Landform Type" value={plant.landform_type} />
          <Row label="Support Tree Type" value={plant.support_tree_type} />
        </Section>

        {/* Section 4 — GPS */}
        {location && (
          <Section title="GPS Location" icon={<MapPin className="h-3.5 w-3.5" />}>
            <Row label="Latitude" value={location.latitude?.toFixed(7)} />
            <Row label="Longitude" value={location.longitude?.toFixed(7)} />
            <Row label="Altitude" value={location.altitude ? `${location.altitude.toFixed(1)} m` : null} />
            <Row label="Accuracy" value={location.accuracy ? `± ${location.accuracy.toFixed(1)} m` : null} />
            <a
              href={`https://maps.google.com/?q=${location.latitude},${location.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-2 text-[10px] font-bold text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> View on Google Maps
            </a>
          </Section>
        )}

        {/* Section 5 — Latest Inspection */}
        {latestInsp ? (
          <Section title="Latest Inspection" icon={<ClipboardCheck className="h-3.5 w-3.5" />}
            badge={fmtDate(latestInsp.inspection_date)}>
            <Row label="Supervisor" value={latestInsp.supervisor_name} />
            <Row label="Watering Status" value={latestInsp.watering_status} />
            <Row label="Sunlight Level" value={mapSunlight(latestInsp.sunlight_level)} />
            <Row label="Shade Level" value={mapShade(latestInsp.shade_level)} />
            <Row label="Soil Type" value={latestInsp.soil_type} />
            <Row label="Soil pH" value={latestInsp.soil_ph ?? latestInsp.soil_pH} />
            <Row label="Soil EC" value={latestInsp.soil_ec ? `${latestInsp.soil_ec} mS/cm` : null} />
            <Row label="Temperature" value={latestInsp.temperature ? `${latestInsp.temperature} °C` : null} />
            <Row label="Humidity" value={latestInsp.humidity ? `${latestInsp.humidity}%` : null} />
            <Row label="Vine Height" value={latestInsp.vine_height_cm ? `${latestInsp.vine_height_cm} cm` : null} />
            <Row label="Foliage Colour" value={latestInsp.foliage_color} />
            {latestInsp.field_notes && (
              <div className="mt-2 pt-2 border-t border-border-light">
                <span className="text-[9px] uppercase font-bold text-text-secondary block mb-1">Notes</span>
                <p className="text-[11px] text-text-primary leading-relaxed">{latestInsp.field_notes}</p>
              </div>
            )}
            {latestInsp.photo_url && (
              <div className="mt-3">
                <span className="text-[9px] uppercase font-bold text-text-secondary block mb-1.5">Latest Photo</span>
                <img
                  src={latestInsp.photo_url}
                  alt="Inspection photo"
                  className="w-full rounded-xl object-cover max-h-48 border border-border-light"
                />
              </div>
            )}
          </Section>
        ) : (
          <div className="bg-white border border-dashed border-border-light rounded-2xl p-6 text-center text-text-secondary">
            <ClipboardCheck className="h-8 w-8 mx-auto mb-2 opacity-30 text-primary" />
            <p className="text-xs font-semibold">No inspections logged yet</p>
          </div>
        )}

        {/* Section 6 — Inspection Timeline */}
        <div className="bg-white rounded-2xl border border-border-light overflow-hidden shadow-sm">
          <button
            onClick={async () => {
              if (!historyExpanded && history.length === 0) await loadHistory();
              setHistoryExpanded(v => !v);
            }}
            className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-surface transition-colors"
          >
            <span className="text-[10px] uppercase font-bold text-text-secondary tracking-widest flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Inspection Timeline
            </span>
            <ChevronRight className={`h-4 w-4 text-text-secondary transition-transform ${historyExpanded ? 'rotate-90' : ''}`} />
          </button>

          {historyExpanded && (
            <div className="px-4 pb-4 space-y-2 border-t border-border-light pt-3">
              {historyLoading ? (
                <div className="flex items-center gap-2 text-text-secondary py-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <span className="text-xs">Loading history...</span>
                </div>
              ) : history.length === 0 ? (
                <p className="text-xs text-text-secondary py-2">No inspections recorded.</p>
              ) : (
                <div className="relative pl-5">
                  {/* Timeline line */}
                  <div className="absolute left-1.5 top-2 bottom-2 w-0.5 bg-border-light" />
                  <div className="space-y-4">
                    {history.map((insp, i) => {
                      const h = HEALTH[deriveHealth(insp)];
                      return (
                        <div key={insp.id} className="relative flex items-start gap-3">
                          {/* dot */}
                          <div className={`absolute -left-3.5 mt-1 h-3 w-3 rounded-full border-2 border-white shadow-sm ${h.dot}`} />
                          <div className="flex-1 bg-surface border border-border-light rounded-xl px-3 py-2.5 flex justify-between items-center">
                            <div>
                              <span className="text-[10px] font-black text-text-primary block">
                                {fmtDate(insp.inspection_date)}
                              </span>
                              <span className={`text-[8px] font-bold uppercase ${h.text}`}>{h.label}</span>
                              {insp.vine_height_cm && (
                                <span className="text-[9px] text-text-secondary ml-2">· {insp.vine_height_cm} cm</span>
                              )}
                            </div>
                            <button
                              onClick={() => router.push(`/history?plant_id=${plant_id}&view=${insp.id}`)}
                              className="text-[9px] font-bold text-primary hover:underline"
                            >
                              View
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Section 7 — Action Buttons */}
        <div className="space-y-2.5 pt-1">
          <button
            onClick={() => router.push(`/inspect/form?plant_id=${plant_id}`)}
            className="w-full bg-primary text-white py-4 rounded-2xl text-sm font-bold hover:bg-primary/90 active:scale-[0.98] transition flex items-center justify-center gap-2 shadow-md"
          >
            <ClipboardCheck className="h-5 w-5" /> New Inspection
          </button>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={() => router.push(`/history?plant_id=${plant_id}`)}
              className="bg-white border border-border-light text-text-primary py-3.5 rounded-2xl text-xs font-bold hover:bg-surface active:scale-95 transition flex items-center justify-center gap-1.5 shadow-sm"
            >
              <FileText className="h-4 w-4 text-primary" /> View History
            </button>
            <button
              onClick={() => setShowQrModal(true)}
              className="bg-white border border-border-light text-text-primary py-3.5 rounded-2xl text-xs font-bold hover:bg-surface active:scale-95 transition flex items-center justify-center gap-1.5 shadow-sm"
            >
              <QrCode className="h-4 w-4 text-primary" /> QR Code
            </button>
            <button
              onClick={() => router.push(`/add-plant?edit=${plant_id}`)}
              className="bg-white border border-border-light text-text-primary py-3.5 rounded-2xl text-xs font-bold hover:bg-surface active:scale-95 transition flex items-center justify-center gap-1.5 shadow-sm"
            >
              <Leaf className="h-4 w-4 text-primary" /> Edit Plant
            </button>
            <button
              onClick={() => window.print()}
              className="bg-white border border-border-light text-text-primary py-3.5 rounded-2xl text-xs font-bold hover:bg-surface active:scale-95 transition flex items-center justify-center gap-1.5 shadow-sm"
            >
              <Printer className="h-4 w-4 text-primary" /> Print / PDF
            </button>
          </div>
        </div>
      </div>

      {/* ── QR MODAL ── */}
      {showQrModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-white rounded-3xl w-full max-w-xs p-6 shadow-2xl text-center animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <div className="text-left">
                <span className="text-[9px] uppercase font-bold text-text-secondary tracking-widest">QR Code</span>
                <h3 className="text-base font-black text-text-primary">{plant_id}</h3>
              </div>
              <button onClick={() => setShowQrModal(false)} className="h-8 w-8 bg-surface rounded-full flex items-center justify-center hover:bg-border-light">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="bg-surface rounded-2xl p-4 border border-border-light flex justify-center mb-4">
              <canvas ref={canvasRef} />
            </div>

            <p className="text-[9px] text-text-secondary leading-relaxed mb-4">
              Affix this sticker to the Glyricidia support tree for scanning during subsequent inspections.
            </p>

            <div className="flex gap-2">
              {qrUrl && (
                <a
                  href={qrUrl}
                  download={`QR_${plant_id}.png`}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-primary text-white py-3 rounded-full text-xs font-bold hover:bg-primary/90 transition"
                >
                  <Download className="h-3.5 w-3.5" /> Download
                </a>
              )}
              {typeof navigator !== 'undefined' && navigator.share && qrUrl && (
                <button
                  onClick={async () => {
                    const blob = await (await fetch(qrUrl)).blob();
                    const file = new File([blob], `QR_${plant_id}.png`, { type: 'image/png' });
                    navigator.share({ title: `QR Code ${plant_id}`, files: [file] }).catch(() => {});
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-surface border border-border-light text-text-primary py-3 rounded-full text-xs font-bold hover:bg-border-light transition"
                >
                  <Share2 className="h-3.5 w-3.5" /> Share
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── UI Helpers ───────────────────────────────────────────────
function Section({ title, icon, badge, children }: {
  title: string; icon: React.ReactNode; badge?: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border-light overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-light bg-surface/60">
        <span className="text-[9px] uppercase font-bold text-text-secondary tracking-widest flex items-center gap-1.5">
          {icon} {title}
        </span>
        {badge && <span className="text-[9px] font-bold text-text-secondary">{badge}</span>}
      </div>
      <div className="px-4 py-3.5 space-y-2.5">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === '' || value === '—') return null;
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-[10px] text-text-secondary font-medium flex-shrink-0 leading-relaxed">{label}</span>
      <span className="text-[10px] font-bold text-text-primary text-right leading-relaxed">{String(value)}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/10 rounded-2xl p-2.5 text-center">
      <span className="text-[8px] uppercase font-bold text-green-light/70 block">{label}</span>
      <span className="text-sm font-black block mt-0.5">{value}</span>
    </div>
  );
}

'use client';

import { useEffect, useState, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Search, X, QrCode, Leaf, CheckCircle,
  Camera, ChevronRight, ClipboardCheck
} from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { saveInspectionOffline } from '../../lib/offline-db';
import { getUserProfile } from '../../lib/authService';

// ─── types ───────────────────────────────────────────────────
type Step = 'select' | 'form';

interface PlantMeta {
  plant_id: string;
  zone: string;
  block: string;
  plant_no: number;
  common_name: string;
  variety: string;
  plant_type: string;
  qr_code: string;
}

// ─── Main page wrapper (needs Suspense for useSearchParams) ──
export default function NewInspectionPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-surface flex items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>}>
      <NewInspectionInner />
    </Suspense>
  );
}

function NewInspectionInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedId = searchParams.get('plant_id');

  const [step, setStep] = useState<Step>(preselectedId ? 'form' : 'select');
  const [selectedPlant, setSelectedPlant] = useState<PlantMeta | null>(null);

  // plant search state
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlantMeta[]>([]);
  const [searching, setSearching] = useState(false);

  // form state
  const [submitting, setSubmitting] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const profile = getUserProfile();

  const [form, setForm] = useState({
    inspection_date: new Date().toISOString().split('T')[0],
    supervisor_name: profile?.name || '',
    supervisor_email: profile?.email || '',
    watering_status: '',
    sunlight_level: '',
    shade_level: '',
    soil_type: '',
    soil_ph: '',
    soil_ec: '',
    temperature: '',
    humidity: '',
    vine_height_cm: '',
    foliage_color: 'Green',
    fertilizer_used: '',
    fertilizer_type: [] as string[],
    last_fertilized: '',
    notes: '',
  });

  // ── Pre-load plant if plant_id is in URL ────────────────────
  useEffect(() => {
    if (!preselectedId) return;
    supabase.from('plants').select('*').eq('plant_id', preselectedId).single()
      .then(({ data }) => {
        if (data) { setSelectedPlant(data); setStep('form'); }
      });
  }, [preselectedId]);

  // ── Plant search ─────────────────────────────────────────────
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const q = query.trim().toLowerCase();
      const { data } = await supabase
        .from('plants')
        .select('plant_id, zone, block, plant_no, common_name, variety, plant_type, qr_code')
        .or(`plant_id.ilike.%${q}%,zone.ilike.%${q}%,block.ilike.%${q}%,variety.ilike.%${q}%`)
        .limit(20);
      setResults(data || []);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const selectPlant = (p: PlantMeta) => {
    setSelectedPlant(p);
    setQuery('');
    setResults([]);
    setStep('form');
  };

  // ── Form field helpers ────────────────────────────────────────
  const setField = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  const toggleFertType = (val: string) => {
    setForm(f => ({
      ...f,
      fertilizer_type: f.fertilizer_type.includes(val)
        ? f.fertilizer_type.filter(x => x !== val)
        : [...f.fertilizer_type, val]
    }));
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    const url = URL.createObjectURL(file);
    setPhotoPreview(url);
  };

  // ── Submit ────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlant) return;
    setSubmitting(true);

    try {
      const now = new Date();
      const inspId = `${selectedPlant.plant_id}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

      // Upload photo if provided
      let photoUrl: string | null = null;
      if (photoFile) {
        const ext = photoFile.name.split('.').pop() || 'jpg';
        const zoneFolder = selectedPlant.zone ? selectedPlant.zone.toUpperCase() : 'Unknown';
        const blockFolder = selectedPlant.block ? (String(selectedPlant.block).startsWith('Block') ? selectedPlant.block : `Block ${String(selectedPlant.block).padStart(2, '0')}`) : 'Unknown_Block';
        const path = `${zoneFolder}/${blockFolder}/Inspection_${selectedPlant.plant_id}_${now.toISOString().split('T')[0]}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('inspection-photos')
          .upload(path, photoFile, { upsert: true });
        if (!uploadErr) {
          const { data: urlData } = supabase.storage.from('inspection-photos').getPublicUrl(path);
          photoUrl = urlData.publicUrl;
        }
      }

      const record = {
        id: inspId,
        plant_id: selectedPlant.plant_id,
        zone: selectedPlant.zone,
        block: selectedPlant.block,
        inspection_date: new Date(form.inspection_date).toISOString(),
        supervisor_name: form.supervisor_name,
        supervisor_email: form.supervisor_email,
        watering_status: form.watering_status,
        sunlight_level: form.sunlight_level,
        shade_level: form.shade_level,
        soil_type: form.soil_type,
        soil_ph: form.soil_ph ? Number(form.soil_ph) : null,
        soil_ec: form.soil_ec ? Number(form.soil_ec) : null,
        temperature: form.temperature ? Number(form.temperature) : null,
        humidity: form.humidity ? Number(form.humidity) : null,
        vine_height_cm: form.vine_height_cm ? Number(form.vine_height_cm) : null,
        foliage_color: form.foliage_color,
        fertilizer_used: form.fertilizer_used || null,
        fertilizer_type: form.fertilizer_type,
        last_fertilized: form.last_fertilized || null,
        notes: form.notes || null,
        photo_url: photoUrl,
        sync_status: 'pending',
        created_at: now.toISOString(),
      };

      // Save offline first
      await saveInspectionOffline(record);

      // Try Supabase directly
      await supabase.from('inspections').upsert(record, { onConflict: 'id' });

      // Update sync status to synced
      const syncedRecord = { ...record, sync_status: 'synced' };
      await saveInspectionOffline(syncedRecord);

      window.dispatchEvent(new Event('submissions-updated'));
      router.push('/dashboard');
    } catch (err) {
      console.error(err);
      alert('Saved offline. Will sync when connected.');
      router.push('/dashboard');
    } finally {
      setSubmitting(false);
    }
  };

  // ════════════════════════════════════════════════════════════
  // RENDER — STEP 1: PLANT SELECTION
  // ════════════════════════════════════════════════════════════
  if (step === 'select') {
    return (
      <div className="flex flex-col bg-surface min-h-screen pb-28">
        {/* Header */}
        <div className="bg-primary text-white px-5 pt-5 pb-6 rounded-b-3xl shadow-md">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={() => router.back()} className="h-8 w-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <span className="text-[9px] uppercase font-bold text-green-light tracking-widest">New Inspection</span>
              <h1 className="text-xl font-extrabold">Select Plant</h1>
            </div>
          </div>

          {/* Search */}
          <div className="flex items-center bg-white/10 border border-white/20 rounded-2xl px-4 py-3 gap-2">
            <Search className="h-4 w-4 text-white/60 flex-shrink-0" />
            <input
              autoFocus
              type="text"
              placeholder="Search by Plant ID, Zone, Block, Variety..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="bg-transparent text-xs text-white placeholder:text-white/50 outline-none flex-1 font-semibold"
            />
            {query && <button onClick={() => setQuery('')}><X className="h-4 w-4 text-white/60" /></button>}
          </div>
        </div>

        <div className="px-5 pt-5 space-y-3">
          {/* QR scan tip */}
          <div className="bg-white border border-dashed border-primary/30 rounded-2xl p-4 flex items-center gap-3">
            <div className="h-10 w-10 bg-pale-green rounded-xl flex items-center justify-center flex-shrink-0">
              <QrCode className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-bold text-text-primary">Scan QR Code</p>
              <p className="text-[10px] text-text-secondary mt-0.5">Use your device camera to scan the plant QR sticker on the support tree, or search manually above.</p>
            </div>
          </div>

          {/* Results */}
          {searching && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          )}

          {!searching && results.length > 0 && (
            <div>
              <span className="text-[9px] uppercase font-bold text-text-secondary tracking-widest block mb-2">{results.length} Plants Found</span>
              <div className="space-y-2">
                {results.map(p => (
                  <button
                    key={p.plant_id}
                    onClick={() => selectPlant(p)}
                    className="w-full text-left bg-white rounded-2xl border border-border-light p-4 flex items-center gap-3 hover:border-primary/30 hover:shadow-md active:scale-[0.99] transition-all"
                  >
                    <div className="h-10 w-10 bg-pale-green rounded-xl flex items-center justify-center flex-shrink-0">
                      <Leaf className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-black text-text-primary">{p.plant_id}</h4>
                      <p className="text-[10px] text-text-secondary mt-0.5">
                        {p.common_name || 'Vanilla'} • {p.variety || 'Local'} • Zone {p.zone} Block {p.block}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-text-secondary opacity-50 flex-shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {!searching && query && results.length === 0 && (
            <div className="bg-white border border-dashed border-border-light rounded-2xl p-8 text-center text-text-secondary">
              <Leaf className="h-8 w-8 mx-auto mb-2 opacity-25 text-primary" />
              <p className="text-xs font-semibold">No plants match &ldquo;{query}&rdquo;</p>
              <p className="text-[10px] opacity-70 mt-1">Check the Plant ID format (e.g. A01-P001)</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  // RENDER — STEP 2: INSPECTION FORM
  // ════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col bg-surface min-h-screen pb-28">
      {/* Header */}
      <div className="bg-primary text-white px-5 pt-5 pb-5 rounded-b-3xl shadow-md">
        <div className="flex items-center gap-3">
          <button onClick={() => { setStep('select'); setSelectedPlant(null); }} className="h-8 w-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <span className="text-[9px] uppercase font-bold text-green-light tracking-widest">New Inspection</span>
            <h1 className="text-xl font-extrabold">Inspection Form</h1>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="px-5 pt-5 space-y-4">

        {/* ── Plant Identity Card (read-only) ── */}
        {selectedPlant && (
          <div className="bg-white rounded-2xl border border-primary/20 p-4 flex items-center gap-4 shadow-sm">
            <div className="h-12 w-12 bg-pale-green rounded-2xl flex items-center justify-center flex-shrink-0">
              <Leaf className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-text-primary">{selectedPlant.plant_id}</h3>
                <CheckCircle className="h-4 w-4 text-primary" />
              </div>
              <p className="text-[10px] text-text-secondary mt-0.5">
                {selectedPlant.common_name || 'Vanilla'} • {selectedPlant.variety || 'Local'} • Zone {selectedPlant.zone} Block {selectedPlant.block}
              </p>
            </div>
            <QrCode className="h-5 w-5 text-text-secondary opacity-40" />
          </div>
        )}

        {/* ── Date & Supervisor ── */}
        <FormSection title="Inspection Details" icon={<ClipboardCheck className="h-3.5 w-3.5" />}>
          <FormField label="Inspection Date">
            <input
              type="date"
              value={form.inspection_date}
              onChange={e => setField('inspection_date', e.target.value)}
              required
              className={INPUT}
            />
          </FormField>
          <FormField label="Supervisor Name">
            <input
              type="text"
              value={form.supervisor_name}
              onChange={e => setField('supervisor_name', e.target.value)}
              placeholder="Enter supervisor name"
              className={INPUT}
            />
          </FormField>
        </FormSection>

        {/* ── Care ── */}
        <FormSection title="Care">
          <FormField label="Watering Status">
            <select value={form.watering_status} onChange={e => setField('watering_status', e.target.value)} className={INPUT}>
              <option value="">Select...</option>
              {['Dry out', 'Partially dry', 'Keep moist', 'High humidity'].map(o => <option key={o}>{o}</option>)}
            </select>
          </FormField>
          <FormField label="Sunlight Level">
            <select value={form.sunlight_level} onChange={e => setField('sunlight_level', e.target.value)} className={INPUT}>
              <option value="">Select...</option>
              <option value="bright">Bright (7-9 bars, &gt;20,000 lux)</option>
              <option value="bright_indirect">Bright indirect (4-6 bars, 10,000-20,000 lux)</option>
              <option value="medium">Medium (2-3 bars, 1,000-10,000 lux)</option>
              <option value="low">Low (0-1 bars, &lt;1,000 lux)</option>
            </select>
          </FormField>
          <FormField label="Shade Level">
            <select value={form.shade_level} onChange={e => setField('shade_level', e.target.value)} className={INPUT}>
              <option value="">Select...</option>
              <option value="light">Light (0-25%)</option>
              <option value="partial">Partial (25-50%)</option>
              <option value="moderate">Moderate (50-70%)</option>
              <option value="heavy">Heavy (&gt;70%)</option>
            </select>
          </FormField>
        </FormSection>

        {/* ── Environment ── */}
        <FormSection title="Environment">
          <FormField label="Soil Type">
            <select value={form.soil_type} onChange={e => setField('soil_type', e.target.value)} className={INPUT}>
              <option value="">Select...</option>
              {['Standard', 'Cactus', 'Acidic', 'Orchid'].map(o => <option key={o}>{o}</option>)}
            </select>
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Soil pH">
              <input type="number" step="0.1" min="0" max="14" value={form.soil_ph}
                onChange={e => setField('soil_ph', e.target.value)} placeholder="6.0 – 6.5" className={INPUT} />
            </FormField>
            <FormField label="Soil EC (mS/cm)">
              <input type="number" step="0.01" value={form.soil_ec}
                onChange={e => setField('soil_ec', e.target.value)} placeholder="e.g. 1.2" className={INPUT} />
            </FormField>
            <FormField label="Temperature (°C)">
              <input type="number" step="0.1" value={form.temperature}
                onChange={e => setField('temperature', e.target.value)} placeholder="e.g. 28" className={INPUT} />
            </FormField>
            <FormField label="Humidity (%)">
              <input type="number" step="1" min="0" max="100" value={form.humidity}
                onChange={e => setField('humidity', e.target.value)} placeholder="e.g. 75" className={INPUT} />
            </FormField>
          </div>
        </FormSection>

        {/* ── Measurements ── */}
        <FormSection title="Measurements">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Vine Height (cm)">
              <input type="number" step="1" value={form.vine_height_cm}
                onChange={e => setField('vine_height_cm', e.target.value)} placeholder="e.g. 145" className={INPUT} />
            </FormField>
            <FormField label="Foliage Colour">
              <select value={form.foliage_color} onChange={e => setField('foliage_color', e.target.value)} className={INPUT}>
                {['Green', 'Yellow', 'Brown', 'Red', 'Mixed'].map(o => <option key={o}>{o}</option>)}
              </select>
            </FormField>
          </div>
        </FormSection>

        {/* ── Fertilizer ── */}
        <FormSection title="Fertilization">
          <FormField label="Fertilizer Brand / Name">
            <input type="text" value={form.fertilizer_used}
              onChange={e => setField('fertilizer_used', e.target.value)} placeholder="e.g. Dolomite" className={INPUT} />
          </FormField>
          <FormField label="Type(s)">
            <div className="flex flex-wrap gap-2 mt-1">
              {['All purpose', 'Cactus', 'Acidic', 'Orchid'].map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleFertType(t)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                    form.fertilizer_type.includes(t)
                      ? 'bg-primary text-white border-primary'
                      : 'bg-white text-text-secondary border-border-light hover:border-primary/40'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </FormField>
          <FormField label="Last Fertilized">
            <input type="date" value={form.last_fertilized}
              onChange={e => setField('last_fertilized', e.target.value)} className={INPUT} />
          </FormField>
        </FormSection>

        {/* ── Photo ── */}
        <FormSection title="Photo">
          <label className="relative block border-2 border-dashed border-border-light rounded-2xl p-5 text-center cursor-pointer hover:border-primary/40 transition-colors">
            {photoPreview ? (
              <img src={photoPreview} alt="Preview" className="w-full rounded-xl object-cover max-h-40 mb-2" />
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Camera className="h-8 w-8 text-text-secondary opacity-40" />
                <span className="text-xs font-semibold text-text-secondary">Tap to capture or upload photo</span>
              </div>
            )}
            <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} className="sr-only" />
          </label>
          {photoPreview && (
            <button type="button" onClick={() => { setPhotoFile(null); setPhotoPreview(null); }}
              className="text-[10px] text-red-500 font-semibold hover:underline">
              Remove photo
            </button>
          )}
        </FormSection>

        {/* ── Notes ── */}
        <FormSection title="Field Notes">
          <textarea
            value={form.notes}
            onChange={e => setField('notes', e.target.value)}
            rows={3}
            placeholder="Additional observations, disease signs, replacement notes..."
            className="w-full border border-border-light rounded-xl p-3 text-xs font-medium focus:outline-primary resize-none placeholder:text-gray-300"
          />
        </FormSection>

        {/* ── Submit ── */}
        <button
          type="submit"
          disabled={submitting || !selectedPlant}
          className="w-full bg-primary text-white py-4 rounded-2xl text-sm font-bold hover:bg-primary/90 active:scale-[0.98] transition shadow-md disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {submitting ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Submitting...
            </>
          ) : (
            <>
              <ClipboardCheck className="h-5 w-5" />
              Submit Inspection
            </>
          )}
        </button>
      </form>
    </div>
  );
}

// ─── Small UI helpers ─────────────────────────────────────────
const INPUT = 'w-full border border-border-light rounded-xl p-2.5 text-xs font-semibold focus:outline-primary bg-white';

function FormSection({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-border-light overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-border-light bg-surface/60">
        <span className="text-[9px] uppercase font-bold text-text-secondary tracking-widest flex items-center gap-1.5">
          {icon} {title}
        </span>
      </div>
      <div className="px-4 py-4 space-y-3">{children}</div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1">{label}</label>
      {children}
    </div>
  );
}

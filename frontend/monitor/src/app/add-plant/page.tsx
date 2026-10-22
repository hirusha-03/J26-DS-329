'use client';

import { useState, useEffect, useRef, startTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, Compass, Download, LayoutGrid, QrCode, ShoppingBag, Sprout } from 'lucide-react';
import QRCode from 'qrcode';
import { savePlantOfflineService, saveSlotOfflineService, syncPendingSubmissions } from '../../lib/syncService';
import { PLANTATION } from '../../lib/plantData';
import { getSlot, getPlant } from '../../lib/offline-db';
import { supabase } from '../../lib/supabaseClient';
import { getUserProfile } from '../../lib/authService';
import {
  ACCEPT_CEP95_M,
  ACCEPT_MEDIAN_ACCURACY_M,
  SESSION_FIXES,
  collectFixes,
  recordSession,
  sessionPosition,
  syncObservations,
  type ObsSample,
} from '../../lib/gpsCapture';

const STEPS = [
  { label: 'Basic Info', hint: 'Zone, block & plant details', icon: Sprout },
  { label: 'Purchase details', hint: 'Source, dates & condition', icon: ShoppingBag },
  { label: 'Planting arrangement', hint: 'Spacing, land & support tree', icon: LayoutGrid },
  { label: 'GPS Coordinate', hint: 'Capture plant location', icon: Compass },
  { label: 'Generate QR Code', hint: 'Label for field scanning', icon: QrCode },
];

export default function AddPlantPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');

  // Form Fields State
  const [zone, setZone] = useState('A');
  const [block, setBlock] = useState('01');
  const [plantNo, setPlantNo] = useState<number>(1);

  // Pre-fill query parameters if navigated from Digital Twin sample index
  useEffect(() => {
    const qZone = searchParams.get('zone');
    const qBlock = searchParams.get('block');
    const qPlantNo = searchParams.get('plant_no');

    startTransition(() => {
      if (qZone) setZone(qZone);
      if (qBlock) setBlock(qBlock);
      if (qPlantNo) setPlantNo(Number(qPlantNo));
    });
  }, [searchParams]);
  
  const [commonName, setCommonName] = useState('Vanilla');
  const [latinName, setLatinName] = useState('Vanilla Planifolia');
  const [scientificName, setScientificName] = useState('Vanilla Planifolia / Fragrans');
  const [variety, setVariety] = useState('Local');
  const [plantType, setPlantType] = useState('Cutting');

  const [purchaseDate, setPurchaseDate] = useState('');
  const [plantedDate, setPlantedDate] = useState('');
  const [purchasedFrom, setPurchasedFrom] = useState('Goomaraya, Kandy District');
  const [purchaseCondition, setPurchaseCondition] = useState('>75%');
  const [maxCuttingHeight, setMaxCuttingHeight] = useState<number>(100);

  const [plantingArrangement, setPlantingArrangement] = useState('Contour Pattern');
  const [spacingBetweenHedges, setSpacingBetweenHedges] = useState('1.5 m x 1.5 m');
  const [spacingBetweenRows, setSpacingBetweenRows] = useState('1.5 m x 1.5 m');
  const [landType, setLandType] = useState('Forest Land');
  const [agriculturalLandType, setAgriculturalLandType] = useState('Arable Crop Land');
  const [landformType, setLandformType] = useState('Upland Hillslope');
  const [supportTreeType, setSupportTreeType] = useState('Glyricidia');

  // GPS State
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [altitude, setAltitude] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [gpsSamples, setGpsSamples] = useState<ObsSample[]>([]);
  const [gpsResult, setGpsResult] = useState<ReturnType<typeof sessionPosition> | null>(null);
  const [gpsMessage, setGpsMessage] = useState<string | null>(null);
  const gpsAbortRef = useRef<AbortController | null>(null);

  // Auto-fill plant number based on plantation layout
  useEffect(() => {
    if (PLANTATION[zone]) {
      const selectedBlockInfo = PLANTATION[zone].blocks.find(b => b.id === block);
      if (!selectedBlockInfo && PLANTATION[zone].blocks.length > 0) {
        startTransition(() => setBlock(PLANTATION[zone].blocks[0].id));
      }
    }
  }, [zone, block]);

  // Compute Plant/Slot Code
  const plantId = `${zone}${block.padStart(2, '0')}-P${String(plantNo).padStart(3, '0')}`;

  // Step 4 GPS capture: SESSION_FIXES readings, kept only when they agree (see gpsCapture.ts).
  const captureGPS = async () => {
    setGpsMessage(null);
    setGpsSamples([]);
    setGpsResult(null);
    setLatitude(null);
    setLongitude(null);
    setAccuracy(null);
    setAltitude(null);
    setGpsLoading(true);
    const ac = new AbortController();
    gpsAbortRef.current = ac;
    try {
      const samples = await collectFixes(SESSION_FIXES, setGpsSamples, ac.signal);
      if (!samples.length) {
        setGpsMessage('No GPS readings were received. Step into the open for a moment and try again.');
        return;
      }
      const pos = sessionPosition(samples);
      setGpsSamples(samples);
      setGpsResult(pos);
      if (!pos.acceptable) return; // readings kept for the GPS study, but not used as the position

      setLatitude(pos.latitude);
      setLongitude(pos.longitude);
      setAccuracy(pos.accuracy);
      if (pos.altitude != null) {
        setAltitude(pos.altitude);
      } else {
        // No altitude from the phone: look it up from a free elevation API.
        try {
          const response = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${pos.latitude}&longitude=${pos.longitude}`);
          if (response.ok) {
            const data = await response.json();
            if (data && Array.isArray(data.elevation) && data.elevation.length > 0) setAltitude(data.elevation[0]);
            else if (data && typeof data.elevation === 'number') setAltitude(data.elevation);
          }
        } catch (e) {
          console.error('Failed to fetch elevation from external API:', e);
        }
      }
    } catch (e) {
      setGpsMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setGpsLoading(false);
      gpsAbortRef.current = null;
    }
  };

  // Generate QR Code on Step 5
  useEffect(() => {
    if (step === 5) {
      const qrData = JSON.stringify({
        slot_id: plantId,
        plant_id: plantId, // backward compatibility
        zone: zone,
        block: block,
        plant_no: String(plantNo)
      });

      // Render to canvas
      if (canvasRef.current) {
        QRCode.toCanvas(canvasRef.current, qrData, { width: 220, margin: 2 }, (error) => {
          if (error) console.error(error);
          else {
            // Also save as image url
            if (canvasRef.current) {
              setQrCodeUrl(canvasRef.current.toDataURL('image/png'));
            }
          }
        });
      }
    }
  }, [step, plantId, zone, block, plantNo]);

  const handleSavePlant = async () => {
    setLoading(true);
    try {
      const slotId = plantId; // e.g. "C01-P002"

      // Check if slot already exists and has an active plant (this phone first, then the database)
      let existingSlot = await getSlot(slotId);
      if (!existingSlot && navigator.onLine) {
        const { data } = await supabase.from('slots').select('*').eq('slot_id', slotId).maybeSingle();
        existingSlot = data;
      }
      let oldPlant: any = null;
      let nextGen = 1;
      let oldPlantId = null;

      if (existingSlot) {
        oldPlantId = existingSlot.active_plant_id || existingSlot.activePlantId;
        if (oldPlantId) {
          oldPlant = await getPlant(oldPlantId);
          if (oldPlant) {
            nextGen = (oldPlant.generation || 1) + 1;
          }
        }
      }

      const newPlantId = `${slotId}-G${nextGen}`;

      // A new accepted capture replaces the position; otherwise keep the slot's existing one.
      // 0 = no position yet (filtered out on the map, listed for re-capture).
      const hasNewFix = latitude != null && longitude != null;
      const slotRecord = {
        slot_id: slotId,
        zone,
        block,
        latitude: hasNewFix ? latitude : existingSlot?.latitude ?? 0,
        longitude: hasNewFix ? longitude : existingSlot?.longitude ?? 0,
        altitude: hasNewFix ? altitude : existingSlot?.altitude ?? null,
        accuracy: hasNewFix ? accuracy : existingSlot?.accuracy ?? null,
        active_plant_id: newPlantId,
        qr_value: slotId
      };

      const plantRecord = {
        plant_id: newPlantId,
        slot_id: slotId,
        generation: nextGen,
        status: 'active',
        zone,
        block,
        plant_no: plantNo,
        qr_code: slotId,
        qr_image_url: qrCodeUrl || null,
        common_name: commonName || null,
        latin_name: latinName || null,
        scientific_name: scientificName || null,
        variety: variety || null,
        plant_type: plantType || null,
        purchase_date: purchaseDate || null,
        planted_date: plantedDate || null,
        purchased_from: purchasedFrom || null,
        purchase_condition: purchaseCondition || null,
        max_cutting_height_cm: maxCuttingHeight || null,
        planting_arrangement: plantingArrangement || null,
        spacing_between_hedges: spacingBetweenHedges || null,
        spacing_between_rows: spacingBetweenRows || null,
        land_type: landType || null,
        agricultural_land_type: agriculturalLandType || null,
        landform_type: landformType || null,
        support_tree_type: supportTreeType || null,
        previous_plant_id: oldPlantId || null,
        replaced_by_plant_id: null,
        retired_date: null
      };

      // Save offline
      await saveSlotOfflineService(slotRecord);
      await savePlantOfflineService(plantRecord);

      // Update old plant if it existed
      if (oldPlantId && oldPlant) {
        const updatedOldPlant = {
          ...oldPlant,
          status: 'replaced',
          retired_date: plantedDate ? new Date(plantedDate).toISOString() : new Date().toISOString(),
          replaced_by_plant_id: newPlantId,
          sync_status: 'pending'
        };
        await savePlantOfflineService(updatedOldPlant);
      }

      // Keep this session's raw readings for the GPS study (E1); a replaced slot's old fix is kept too.
      if (gpsSamples.length) {
        const legacy =
          existingSlot?.latitude && existingSlot?.longitude
            ? {
                latitude: existingSlot.latitude,
                longitude: existingSlot.longitude,
                accuracy: existingSlot.accuracy ?? null,
                altitude: existingSlot.altitude ?? null,
                created_at: existingSlot.created_at,
              }
            : null;
        await recordSession(slotId, gpsSamples, legacy, getUserProfile()?.email ?? null);
      }

      // Trigger sync: slot first, then the readings that reference it
      syncPendingSubmissions()
        .then(() => syncObservations())
        .catch(err => console.error('Sync failed:', err));

      alert(oldPlantId
        ? `Plant replacement registered successfully with unique ID at Slot ${slotId} (Gen ${nextGen})!`
        : `Plant registered successfully with unique ID at Slot ${slotId}!`
      );
      router.push('/dashboard');
    } catch (err: any) {
      console.error(err);
      alert('Error saving plant: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const nextStep = () => setStep(prev => prev + 1);
  const prevStep = () => setStep(prev => prev - 1);

  const goBack = () => {
    if (step > 1) prevStep();
    else router.push('/dashboard');
  };

  return (
    <div className="flex flex-col bg-surface min-h-screen pb-24 lg:min-h-0 lg:bg-transparent lg:pb-0">
      {/* Mobile header */}
      <div className="bg-primary text-white px-5 py-4 flex items-center gap-3 lg:hidden">
        <button onClick={goBack} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Add New Plant</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">
            Step {step} of 5 • {STEPS[step - 1].label}
          </p>
        </div>
      </div>

      {/* Mobile progress bar */}
      <div className="w-full bg-border-light h-1.5 flex lg:hidden">
        {[1, 2, 3, 4, 5].map((s) => (
          <div
            key={s}
            className={`flex-1 h-full transition-all duration-300 ${
              s <= step ? 'bg-primary' : 'bg-transparent'
            }`}
          />
        ))}
      </div>

      {/* Desktop header */}
      <header className="hidden lg:flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={goBack}
            title={step > 1 ? 'Previous step' : 'Back to dashboard'}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <Sprout className="h-6 w-6 text-emerald-600" />
              <h1 className="text-xl font-bold text-slate-900">Add New Plant</h1>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              Register a vine, capture its GPS position and generate its QR label
            </p>
          </div>
        </div>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
          Step {step} of 5
        </span>
      </header>

      <div className="flex-1 lg:grid lg:grid-cols-[260px_1fr] lg:items-start lg:gap-4">
        {/* Desktop step list (completed steps can be revisited) */}
        <aside className="hidden lg:block sticky top-20 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <ol className="space-y-1">
            {STEPS.map((st, i) => {
              const n = i + 1;
              const done = n < step;
              const active = n === step;
              const Icon = st.icon;
              return (
                <li key={st.label}>
                  <button
                    onClick={() => done && setStep(n)}
                    disabled={!done}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                      active
                        ? 'border-emerald-200/60 bg-emerald-50'
                        : done
                        ? 'border-transparent hover:bg-slate-50'
                        : 'border-transparent opacity-60'
                    }`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                        done ? 'bg-emerald-600 text-white' : active ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                    </span>
                    <span>
                      <span className={`block text-xs font-semibold ${active ? 'text-emerald-800' : 'text-slate-800'}`}>
                        {n}. {st.label}
                      </span>
                      <span className="block text-[10px] text-slate-500">{st.hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        {/* Form card */}
        <div className="lg:rounded-xl lg:border lg:border-slate-200 lg:bg-white lg:shadow-sm">
      <div className="p-5 flex-1 space-y-6 lg:p-6">
        {/* STEP 1: BASIC INFORMATION */}
        {step === 1 && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">Basic Information</h2>
            
            <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Zone</label>
                  <select
                    value={zone}
                    onChange={(e) => setZone(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary bg-surface"
                  >
                    {Object.keys(PLANTATION).map(z => (
                      <option key={z} value={z}>Zone {z}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Block</label>
                  <select
                    value={block}
                    onChange={(e) => setBlock(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary bg-surface"
                  >
                    {PLANTATION[zone]?.blocks.map(b => (
                      <option key={b.id} value={b.id}>Block {b.id}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Plant Number</label>
                <input
                  type="number"
                  value={plantNo}
                  onChange={(e) => setPlantNo(Number(e.target.value))}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  min={1}
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Common Name</label>
                <input
                  type="text"
                  value={commonName}
                  onChange={(e) => setCommonName(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Latin Name</label>
                <input
                  type="text"
                  value={latinName}
                  onChange={(e) => setLatinName(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Scientific Name</label>
                <input
                  type="text"
                  value={scientificName}
                  onChange={(e) => setScientificName(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Variety</label>
                  <input
                    type="text"
                    value={variety}
                    onChange={(e) => setVariety(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Plant Type</label>
                  <input
                    type="text"
                    value={plantType}
                    onChange={(e) => setPlantType(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: PURCHASE DETAILS */}
        {step === 2 && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">Purchase & Origin</h2>
            
            <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Purchase Date</label>
                  <input
                    type="date"
                    value={purchaseDate}
                    onChange={(e) => setPurchaseDate(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Planting Date</label>
                  <input
                    type="date"
                    value={plantedDate}
                    onChange={(e) => setPlantedDate(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Purchased From</label>
                <input
                  type="text"
                  value={purchasedFrom}
                  onChange={(e) => setPurchasedFrom(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1">Purchase Condition</label>
                <div className="grid grid-cols-4 gap-2">
                  {['<50%', '<75%', '>50%', '>75%'].map((cond) => (
                    <button
                      key={cond}
                      type="button"
                      onClick={() => setPurchaseCondition(cond)}
                      className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                        purchaseCondition === cond
                          ? 'bg-primary text-white border-primary'
                          : 'bg-white text-text-secondary border-border-light hover:bg-surface'
                      }`}
                    >
                      {cond}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Maximum Cutting Height (cm)</label>
                <input
                  type="number"
                  value={maxCuttingHeight}
                  onChange={(e) => setMaxCuttingHeight(Number(e.target.value))}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                />
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: PLANTING CONFIGURATION */}
        {step === 3 && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">Planting Arrangement</h2>
            
            <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1.5">Planting Arrangement</label>
                <div className="grid grid-cols-2 gap-2">
                  {['Contour Pattern', 'Square Pattern', 'Rectangular Pattern', 'Hexagonal Pattern', 'Triangular Pattern', 'Quincunx Pattern'].map((pattern) => (
                    <button
                      key={pattern}
                      type="button"
                      onClick={() => setPlantingArrangement(pattern)}
                      className={`p-2.5 rounded-xl text-xs font-bold border text-left transition-all ${
                        plantingArrangement === pattern
                          ? 'bg-pale-green text-primary border-primary'
                          : 'bg-white text-text-secondary border-border-light hover:bg-surface'
                      }`}
                    >
                      {pattern}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Spacing Hedges</label>
                  <input
                    type="text"
                    value={spacingBetweenHedges}
                    onChange={(e) => setSpacingBetweenHedges(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Spacing Rows</label>
                  <input
                    type="text"
                    value={spacingBetweenRows}
                    onChange={(e) => setSpacingBetweenRows(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Land Type</label>
                <select
                  value={landType}
                  onChange={(e) => setLandType(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary bg-surface"
                >
                  <option value="Forest Land">Forest Land</option>
                  <option value="Acahual Land">Acahual Land</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Agricultural Land Type</label>
                <select
                  value={agriculturalLandType}
                  onChange={(e) => setAgriculturalLandType(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary bg-surface"
                >
                  <option value="Arable Crop Land">Arable Crop Land</option>
                  <option value="Permanent Crop Land">Permanent Crop Land</option>
                  <option value="Permanent Grassland">Permanent Grassland</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Landform Type</label>
                  <input
                    type="text"
                    value={landformType}
                    onChange={(e) => setLandformType(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase">Support Tree Type</label>
                  <input
                    type="text"
                    value={supportTreeType}
                    onChange={(e) => setSupportTreeType(e.target.value)}
                    className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 4: GPS LOCATION CAPTURE */}
        {step === 4 && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">GPS Location</h2>
            
            <div className="bg-white rounded-2xl p-5 border border-border-light text-center space-y-5">
              <div className="h-16 w-16 bg-pale-green text-primary rounded-2xl flex items-center justify-center mx-auto shadow-sm">
                <Compass className="h-8 w-8" />
              </div>
              
              <div>
                <h3 className="text-sm font-bold text-text-primary">Locate Plantation Spot</h3>
                <p className="text-[10px] text-text-secondary mt-1 max-w-xs mx-auto leading-relaxed">
                  Stand beside the newly planted support tree and capture the coordinates. High precision recommended.
                </p>
              </div>

              {gpsLoading ? (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-text-primary">
                    Hold still beside the plant… {gpsSamples.length}/{SESSION_FIXES} readings
                  </p>
                  <div className="h-2 overflow-hidden rounded-full bg-surface">
                    <div className="h-full bg-primary transition-all" style={{ width: `${(gpsSamples.length / SESSION_FIXES) * 100}%` }} />
                  </div>
                  {gpsSamples.at(-1) && (
                    <p className="text-[10px] text-text-secondary">Last reading ±{gpsSamples.at(-1)!.accuracy.toFixed(1)} m</p>
                  )}
                  <button
                    type="button"
                    onClick={() => gpsAbortRef.current?.abort()}
                    disabled={!gpsSamples.length}
                    className="rounded-full border border-border-light px-4 py-2 text-[11px] font-bold text-text-secondary disabled:opacity-40"
                  >
                    Stop and use {gpsSamples.length} readings
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={captureGPS}
                  className="w-full bg-[#1B4332] text-white py-3 rounded-full text-xs font-bold hover:bg-primary transition shadow-md flex items-center justify-center gap-1.5"
                >
                  📍 {gpsResult ? 'Capture Again' : `Capture Location (${SESSION_FIXES} readings)`}
                </button>
              )}

              {gpsMessage && (
                <p className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-left text-[11px] text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {gpsMessage}
                </p>
              )}

              {gpsResult && (
                gpsResult.acceptable ? (
                  <p className="flex items-start gap-2 rounded-xl bg-pale-green p-3 text-left text-[11px] text-primary">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      <strong>Good position.</strong> {gpsResult.dispersion.n} readings within {gpsResult.dispersion.cep95.toFixed(1)} m
                      (phone accuracy ±{gpsResult.dispersion.medianReportedAccuracy.toFixed(1)} m).
                    </span>
                  </p>
                ) : (
                  <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-left text-[11px] text-amber-900">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      <strong>Not accurate enough</strong> — readings spread {gpsResult.dispersion.cep95.toFixed(0)} m, phone accuracy ±
                      {gpsResult.dispersion.medianReportedAccuracy.toFixed(0)} m (need ≤ {ACCEPT_CEP95_M} m and ≤ {ACCEPT_MEDIAN_ACCURACY_M} m).
                      The phone is probably using Wi-Fi / mobile data instead of satellites. Move to a more open spot, wait
                      a minute and capture again, or continue and re-capture later from GPS Re-capture.
                    </span>
                  </p>
                )
              )}

              <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border-light text-left">
                {[
                  ['Latitude', latitude?.toFixed(7)],
                  ['Longitude', longitude?.toFixed(7)],
                  ['Altitude (m)', altitude != null ? altitude.toFixed(1) : undefined],
                  ['Accuracy (m)', accuracy != null ? `±${accuracy}` : undefined],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span className="text-[9px] font-bold text-text-secondary uppercase">{label}</span>
                    <p className="mt-1 rounded-lg border border-border-light bg-surface p-2 text-xs font-semibold text-text-primary">
                      {value ?? '—'}
                    </p>
                  </div>
                ))}
              </div>
              {!gpsResult?.acceptable && (
                <p className="text-[10px] text-text-secondary text-left">
                  Without an accepted position the plant is saved without GPS (a replacement keeps the slot&apos;s
                  existing position) and appears in the re-capture list.
                </p>
              )}
            </div>
          </div>
        )}

        {/* STEP 5: GENERATE QR CODE */}
        {step === 5 && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">Generate QR</h2>
            
            <div className="bg-white rounded-2xl p-5 border border-border-light text-center space-y-4">
              <div>
                <span className="text-[9px] uppercase font-bold px-2 py-0.5 rounded-full bg-pale-green text-primary">
                  Plant ID Generated
                </span>
                <h3 className="text-lg font-black text-text-primary mt-1">{plantId}</h3>
              </div>

              {/* Canvas element for rendering QR Code */}
              <div className="flex justify-center p-3 bg-surface rounded-2xl border border-border-light w-56 h-56 mx-auto items-center">
                <canvas ref={canvasRef} className="max-w-full max-h-full" />
              </div>

              <div className="text-[10px] text-text-secondary leading-relaxed px-4">
                This QR Code sticker contains the unique identifiers and should be affixed to the Glyricidia support tree for scanning during subsequent inspections.
              </div>

              {qrCodeUrl && (
                <a
                  href={qrCodeUrl}
                  download={`QR_Code_${plantId}.png`}
                  className="inline-flex items-center justify-center gap-1.5 text-xs font-bold text-primary hover:underline"
                >
                  <Download className="h-4 w-4" />
                  Download QR Image
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer Navigation Buttons */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light flex gap-3 z-30 lg:static lg:max-w-none lg:justify-end lg:rounded-b-xl lg:px-6">
        {step > 1 && (
          <button
            onClick={prevStep}
            className="flex-1 border border-border-light text-text-secondary py-3.5 rounded-full font-bold text-xs shadow-xs hover:bg-surface lg:flex-none lg:w-40"
          >
            Back
          </button>
        )}
        
        {step < 5 ? (
          <button
            onClick={nextStep}
            disabled={step === 1 && (!zone || !block || !plantNo)}
            className="flex-[2] bg-[#1B4332] text-white py-3.5 rounded-full font-bold text-xs shadow-md hover:bg-primary active:scale-95 disabled:opacity-50 lg:flex-none lg:w-56"
          >
            Next Step
          </button>
        ) : (
          <button
            onClick={handleSavePlant}
            disabled={loading}
            className="flex-[2] bg-primary text-white py-3.5 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50 lg:flex-none lg:w-64"
          >
            {loading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Saving Plant...
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                Finish & Register Plant
              </>
            )}
          </button>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}

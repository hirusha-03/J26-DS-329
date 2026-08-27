'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Camera, Map, List, AlertCircle, Scan,
  RefreshCw, Leaf, ArrowRight
} from 'lucide-react';
import { getSlots, getPlants } from '../../lib/offline-db';
import Link from 'next/link';

export default function InspectSelectionPage() {
  const router = useRouter();
  const [slotsList, setSlotsList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Scanner State
  const [scannerActive, setScannerActive] = useState(false);
  const [scanError, setScanError] = useState('');

  // Manual Select State
  const [selectedPlantId, setSelectedPlantId] = useState('');
  const [manualPlantId, setManualPlantId] = useState('');
  const [manualError, setManualError] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const slots = await getSlots();
      const plants = await getPlants();

      const enriched = slots.map(slot => {
        // Find active plant
        const activePlantId = slot.active_plant_id || slot.activePlantId;
        const plant = plants.find(p => p.plant_id === activePlantId);

        return {
          ...slot,
          plant
        };
      });

      setSlotsList(enriched);
    } catch (err) {
      console.error('Failed to load selection page data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const triggerBackgroundSync = async () => {
    setSyncing(true);
    try {
      const { pullPlantsFromSupabase, syncPendingSubmissions } = await import('../../lib/syncService');
      // Push any offline actions first, then pull
      await syncPendingSubmissions();
      const { plantsCount, slotsCount } = await pullPlantsFromSupabase();
      if (plantsCount > 0 || slotsCount > 0) {
        await loadData();
      }
    } catch (err) {
      console.error('Failed background sync:', err);
    } finally {
      setSyncing(false);
    }
  };

  // Handle Scan Success
  const handleScanSuccess = async (decodedText: string) => {
    try {
      let qrContent = decodedText.trim();
      // Try parsing if it's JSON
      if (decodedText.startsWith('{')) {
        const parsed = JSON.parse(decodedText);
        qrContent = parsed.slot_id || parsed.plant_id || parsed.qr_value;
      }
      
      if (!qrContent) throw new Error("Invalid QR Content");

      // Check if slot exists
      const match = slotsList.find(s => s.slot_id === qrContent || s.qr_value === qrContent || s.active_plant_id === qrContent);
      if (match) {
        if (match.plant) {
          router.push(`/inspect/form?plant_id=${match.plant.plant_id}`);
          setScannerActive(false);
        } else {
          setScanError(`Slot "${qrContent}" does not have an active plant registered.`);
        }
      } else {
        // If not found in slots list, check offline plant db directly
        const { getPlant } = await import('../../lib/offline-db');
        const dbPlant = await getPlant(qrContent);
        if (dbPlant) {
          router.push(`/inspect/form?plant_id=${dbPlant.plant_id}`);
          setScannerActive(false);
        } else {
          setScanError(`QR content "${qrContent}" did not match any registered Slot or Plant ID.`);
        }
      }
    } catch (err) {
      console.error(err);
      setScanError('Invalid QR format. Please scan a valid Vanilla Monitor plant QR code.');
    }
  };

  // Dynamically import and initialize scanner
  useEffect(() => {
    let scanner: any = null;
    if (scannerActive && typeof window !== 'undefined') {
      import('html5-qrcode').then((module) => {
        const Html5QrcodeScanner = module.Html5QrcodeScanner;
        scanner = new Html5QrcodeScanner(
          'qr-reader-container',
          { fps: 10, qrbox: { width: 250, height: 250 } },
          /* verbose= */ false
        );

        scanner.render(
          (text: string) => {
            handleScanSuccess(text);
            scanner.clear();
            setScannerActive(false);
          },
          (err: any) => {
            // silent scan errors
          }
        );
      }).catch((err) => {
        console.error('Failed to load html5-qrcode scanner:', err);
      });
    }

    return () => {
      if (scanner) {
        try {
          scanner.clear();
        } catch (e) {}
      }
    };
  }, [scannerActive]);

  const handleManualInspect = async () => {
    const term = manualPlantId.trim();
    if (!term) return;

    setManualError('');

    // 1. Search in slots list by slot_id or active_plant_id
    const match = slotsList.find(s => s.slot_id.toLowerCase() === term.toLowerCase() || s.active_plant_id === term);
    if (match) {
      if (match.plant) {
        router.push(`/inspect/form?plant_id=${match.plant.plant_id}`);
      } else {
        setManualError(`Slot "${match.slot_id}" does not have an active plant.`);
      }
      return;
    }

    // 2. Search direct plant registry in IndexedDB
    const { getPlant } = await import('../../lib/offline-db');
    const dbPlant = await getPlant(term);
    if (dbPlant) {
      router.push(`/inspect/form?plant_id=${dbPlant.plant_id}`);
      return;
    }

    setManualError(`Plant or Slot ID "${term}" is not registered. Please enter a valid ID.`);
  };

  return (
    <div className="flex flex-col bg-surface min-h-screen pb-32">
      {/* Header */}
      <div className="bg-primary text-white px-5 py-5 rounded-b-3xl shadow-md flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/dashboard')} className="h-9 w-9 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-lg font-black leading-none">Select Plant</h1>
            <p className="text-[10px] text-green-pale/85 font-medium mt-1">Identify or browse registered vanilla vines</p>
          </div>
        </div>
        <button 
          onClick={triggerBackgroundSync}
          disabled={syncing}
          className="h-9 w-9 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20 active:scale-95 transition disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="px-5 pt-5 space-y-5 flex-1">
        {/* OPTION 1: SCAN QR CODE */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-10 w-10 bg-pale-green text-primary rounded-xl flex items-center justify-center">
              <Scan className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-xs font-black text-text-primary uppercase tracking-wider">Option 1: Scan QR Sticker</h3>
              <p className="text-[10px] text-text-secondary mt-0.5">Scans QR label affixed to support tree</p>
            </div>
          </div>

          {scannerActive ? (
            <div className="space-y-3">
              <div id="qr-reader-container" className="overflow-hidden rounded-xl border border-border-light bg-black" />
              {scanError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 text-xs rounded-xl border border-red-100">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{scanError}</span>
                </div>
              )}
              <button
                onClick={() => setScannerActive(false)}
                className="w-full py-2.5 bg-red-100 text-red-700 text-xs font-bold rounded-xl hover:bg-red-200 transition"
              >
                Cancel Scanner
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setScannerActive(true);
                setScanError('');
              }}
              className="w-full bg-primary text-white py-3 rounded-full text-xs font-bold hover:bg-primary/95 active:scale-[0.98] transition shadow-xs flex items-center justify-center gap-2"
            >
              <Camera className="h-4 w-4" />
              Open Camera Scanner
            </button>
          )}
        </div>

        {/* OPTION 2: DIGITAL TWIN MAP LINK */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-pale-green text-primary rounded-xl flex items-center justify-center">
              <Map className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-xs font-black text-text-primary uppercase tracking-wider">Option 2: Digital Twin Map</h3>
              <p className="text-[10px] text-text-secondary mt-0.5">Select plant from plantation coordinate layout</p>
            </div>
          </div>
          <Link
            href="/digital-twin"
            className="px-4 py-2.5 bg-secondary text-white rounded-full text-[11px] font-bold hover:bg-secondary/90 active:scale-95 transition flex items-center gap-1"
          >
            <span>Open Map</span>
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {/* OPTION 3: MANUAL ENTRY / SELECT */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-10 w-10 bg-pale-green text-primary rounded-xl flex items-center justify-center">
              <List className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-xs font-black text-text-primary uppercase tracking-wider">Option 3: Manual Select / Enter ID</h3>
              <p className="text-[10px] text-text-secondary mt-0.5">Type plant or slot ID, or select from the dropdown</p>
            </div>
          </div>

          <div className="space-y-3.5 text-left pt-1">
            <div>
              <label className="text-[9px] font-black text-text-secondary uppercase tracking-wider block mb-1">
                Enter Plant or Slot ID
              </label>
              <input
                type="text"
                placeholder="e.g. A01-P001"
                value={manualPlantId}
                onChange={(e) => {
                  setManualPlantId(e.target.value);
                  setSelectedPlantId('');
                }}
                className="w-full border border-border-light rounded-xl p-2.5 text-xs font-bold focus:outline-none focus:border-primary/50 bg-surface text-text-primary"
              />
            </div>

            {loading ? (
              <div className="h-10 w-full animate-pulse bg-surface rounded-xl border border-border-light" />
            ) : slotsList.length > 0 && (
              <div>
                <label className="text-[9px] font-black text-text-secondary uppercase tracking-wider block mb-1">
                  Or select registered slot
                </label>
                <select
                  value={selectedPlantId}
                  onChange={(e) => {
                    setSelectedPlantId(e.target.value);
                    const slot = slotsList.find(s => s.plant?.plant_id === e.target.value || s.slot_id === e.target.value);
                    if (slot) {
                      setManualPlantId(slot.slot_id);
                    } else {
                      setManualPlantId('');
                    }
                  }}
                  className="w-full border border-border-light rounded-xl p-2.5 text-xs font-bold focus:outline-none focus:border-primary/50 bg-surface text-text-primary"
                >
                  <option value="">-- Choose Slot --</option>
                  {slotsList
                    .filter(s => s.plant)
                    .map((item) => (
                      <option key={item.slot_id} value={item.plant.plant_id}>
                        {item.slot_id} — {item.plant.variety || 'Vanilla planifolia'}
                      </option>
                    ))}
                </select>
              </div>
            )}

            {manualError && (
              <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 text-[10px] rounded-xl border border-red-100 font-bold">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                <span>{manualError}</span>
              </div>
            )}

            <button
              onClick={handleManualInspect}
              disabled={!manualPlantId.trim()}
              className="w-full bg-[#1B4332] text-white py-3 rounded-full text-xs font-bold hover:bg-primary transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Leaf className="h-4 w-4" />
              <span>Start Inspection</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

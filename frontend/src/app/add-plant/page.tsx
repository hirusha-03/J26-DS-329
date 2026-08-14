'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, Compass, Download, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { savePlantOfflineService, saveSlotOfflineService, syncPendingSubmissions } from '../../lib/syncService';
import { PLANTATION } from '../../lib/plantData';
import { getSlot, getPlant } from '../../lib/offline-db';



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

    if (qZone) setZone(qZone);
    if (qBlock) setBlock(qBlock);
    if (qPlantNo) setPlantNo(Number(qPlantNo));
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

  // Auto-fill plant number based on plantation layout
  useEffect(() => {
    if (PLANTATION[zone]) {
      const selectedBlockInfo = PLANTATION[zone].blocks.find(b => b.id === block);
      if (!selectedBlockInfo && PLANTATION[zone].blocks.length > 0) {
        setBlock(PLANTATION[zone].blocks[0].id);
      }
    }
  }, [zone, block]);

  // Compute Plant/Slot Code
  const plantId = `${zone}${block.padStart(2, '0')}-P${String(plantNo).padStart(3, '0')}`;

  // Step 4 Geolocation Capture
  const captureGPS = () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const acc = position.coords.accuracy;
        let alt = position.coords.altitude;

        setLatitude(lat);
        setLongitude(lng);
        setAccuracy(acc);

        if (alt !== null && alt !== undefined) {
          setAltitude(alt);
          setGpsLoading(false);
        } else {
          // If altitude is null/undefined, try to fetch it from a free elevation API
          try {
            const response = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
            if (response.ok) {
              const data = await response.json();
              if (data && Array.isArray(data.elevation) && data.elevation.length > 0) {
                setAltitude(data.elevation[0]);
              } else if (data && typeof data.elevation === 'number') {
                setAltitude(data.elevation);
              }
            }
          } catch (e) {
            console.error('Failed to fetch elevation from external API:', e);
          } finally {
            setGpsLoading(false);
          }
        }
      },
      (error) => {
        console.error('Error fetching GPS:', error);
        alert(`Failed to fetch location: ${error.message}. Please input coordinates manually.`);
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
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

      // Check if slot already exists and has an active plant
      const existingSlot = await getSlot(slotId);
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

      const slotRecord = {
        slot_id: slotId,
        zone,
        block,
        latitude: latitude || 0,
        longitude: longitude || 0,
        altitude: altitude || null,
        accuracy: accuracy || null,
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

      // Trigger sync
      syncPendingSubmissions().catch(err => console.error('Sync failed:', err));

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

  return (
    <div className="flex flex-col bg-surface min-h-screen pb-24">
      {/* Header */}
      <div className="bg-primary text-white px-5 py-4 flex items-center gap-3">
        <button onClick={() => {
          if (step > 1) prevStep();
          else router.push('/dashboard');
        }} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Add New Plant</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">
            Step {step} of 5 • {step === 1 ? 'Basic Info' : step === 2 ? 'Purchase details' : step === 3 ? 'Planting arrangement' : step === 4 ? 'GPS Coordinate' : 'Generate QR Code'}
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-border-light h-1.5 flex">
        {[1, 2, 3, 4, 5].map((s) => (
          <div
            key={s}
            className={`flex-1 h-full transition-all duration-300 ${
              s <= step ? 'bg-primary' : 'bg-transparent'
            }`}
          />
        ))}
      </div>

      <div className="p-5 flex-1 space-y-6">
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

              <button
                type="button"
                onClick={captureGPS}
                disabled={gpsLoading}
                className="w-full bg-[#1B4332] text-white py-3 rounded-full text-xs font-bold hover:bg-primary transition shadow-md flex items-center justify-center gap-1.5"
              >
                {gpsLoading ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Capturing Location...
                  </>
                ) : (
                  <>
                    📍 Capture Current Location
                  </>
                )}
              </button>

              <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border-light text-left">
                <div>
                  <label className="text-[9px] font-bold text-text-secondary uppercase">Latitude</label>
                  <input
                    type="number"
                    step="any"
                    value={latitude || ''}
                    onChange={(e) => setLatitude(Number(e.target.value))}
                    placeholder="Auto-captured"
                    className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-text-secondary uppercase">Longitude</label>
                  <input
                    type="number"
                    step="any"
                    value={longitude || ''}
                    onChange={(e) => setLongitude(Number(e.target.value))}
                    placeholder="Auto-captured"
                    className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-text-secondary uppercase">Altitude (m)</label>
                  <input
                    type="number"
                    step="any"
                    value={altitude || ''}
                    onChange={(e) => setAltitude(Number(e.target.value))}
                    placeholder="Auto-captured"
                    className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-text-secondary uppercase">Accuracy (m)</label>
                  <input
                    type="number"
                    step="any"
                    value={accuracy || ''}
                    onChange={(e) => setAccuracy(Number(e.target.value))}
                    placeholder="Auto-captured"
                    className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                  />
                </div>
              </div>
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
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light flex gap-3 z-30">
        {step > 1 && (
          <button
            onClick={prevStep}
            className="flex-1 border border-border-light text-text-secondary py-3.5 rounded-full font-bold text-xs shadow-xs hover:bg-surface"
          >
            Back
          </button>
        )}
        
        {step < 5 ? (
          <button
            onClick={nextStep}
            disabled={step === 1 && (!zone || !block || !plantNo)}
            className="flex-[2] bg-[#1B4332] text-white py-3.5 rounded-full font-bold text-xs shadow-md hover:bg-primary active:scale-95 disabled:opacity-50"
          >
            Next Step
          </button>
        ) : (
          <button
            onClick={handleSavePlant}
            disabled={loading}
            className="flex-[2] bg-primary text-white py-3.5 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50"
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
  );
}

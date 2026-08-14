'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, Camera, Sparkles, Droplet, Thermometer, Ruler, AlertCircle, Lock, Unlock, XCircle, RefreshCw, AlertTriangle } from 'lucide-react';
import { getPlant, getPreviousHeight, getSetting, saveSetting, savePlantOffline } from '../../../lib/offline-db';
import { saveInspectionOfflineService, syncPendingSubmissions } from '../../../lib/syncService';
import { supabase } from '../../../lib/supabaseClient';
import { processMeterImage, MOCK_OCR_TEMPLATES } from '../../../lib/meterOcr';

export default function InspectFormPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const plantId = searchParams.get('plant_id') || '';

  const [loading, setLoading] = useState(false);
  const [staticDetails, setStaticDetails] = useState<any>(null);
  const [lastHeight, setLastHeight] = useState<number | null>(null);

  // Form states
  const [wateringStatus, setWateringStatus] = useState<string>('Keep moist');
  const [sunlightLevel, setSunlightLevel] = useState<string>('bright_indirect');
  const [shadeLevel, setShadeLevel] = useState<string>('moderate');
  
  const [soilType, setSoilType] = useState<string>('Acidic');
  const [soilPh, setSoilPh] = useState<number>(6.2);
  const [soilEc, setSoilEc] = useState<string>('');
  const [moisture, setMoisture] = useState<string>('');
  const [temperature, setTemperature] = useState<string>('');
  const [humidity, setHumidity] = useState<string>('');

  const [vineHeight, setVineHeight] = useState<string>('');
  const [foliageColor, setFoliageColor] = useState<string>('Green');

  const [fertilizerType, setFertilizerType] = useState<string[]>([]);
  const [fertilizerUsed, setFertilizerUsed] = useState<string>('');
  const [lastFertilized, setLastFertilized] = useState<string>('');

  // Fixed/Editing toggle states
  const [isFixed, setIsFixed] = useState(true);
  const [hasBeenUnlocked, setHasBeenUnlocked] = useState(false);
  const [carriedInfo, setCarriedInfo] = useState<any>(null);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [notes, setNotes] = useState<string>('');

  // OCR Meter Reading States
  const [readingSources, setReadingSources] = useState<Record<string, 'manual' | 'ocr_confirmed' | 'ocr_edited'>>({
    soilPh: 'manual',
    soilEc: 'manual',
    temperature: 'manual',
    humidity: 'manual',
    moisture: 'manual',
    sunlightLevel: 'manual'
  });
  const [ocrModalOpen, setOcrModalOpen] = useState(false);
  const [activeStep, setActiveStep] = useState<'capture' | 'confirm'>('capture');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('perfect');
  const [isOcrAnalyzing, setIsOcrAnalyzing] = useState(false);
  const [ocrPreviewUrl, setOcrPreviewUrl] = useState<string | null>(null);
  const [ocrBinarizedUrl, setOcrBinarizedUrl] = useState<string | null>(null);
  const [meterPhotoFile, setMeterPhotoFile] = useState<File | null>(null);

  // OCR Confirm Form States (prefilled from scan)
  const [modalPh, setModalPh] = useState<string>('');
  const [modalEc, setModalEc] = useState<string>('');
  const [modalTemp, setModalTemp] = useState<string>('');
  const [modalHumid, setModalHumid] = useState<string>('');
  const [modalLight, setModalLight] = useState<string>('');
  const [modalMoist, setModalMoist] = useState<string>('');

  const [ocrUnitError, setOcrUnitError] = useState<string | null>(null);
  const [ocrValidationError, setOcrValidationError] = useState<string | null>(null);

  const handlePhChange = (val: number) => {
    setSoilPh(val);
    setReadingSources(prev => ({
      ...prev,
      soilPh: prev.soilPh === 'ocr_confirmed' ? 'ocr_edited' : prev.soilPh
    }));
  };

  const handleEcChange = (val: string) => {
    setSoilEc(val);
    setReadingSources(prev => ({
      ...prev,
      soilEc: prev.soilEc === 'ocr_confirmed' ? 'ocr_edited' : prev.soilEc
    }));
  };

  const handleMoistureChange = (val: string) => {
    setMoisture(val);
    setReadingSources(prev => ({
      ...prev,
      moisture: prev.moisture === 'ocr_confirmed' ? 'ocr_edited' : prev.moisture
    }));
  };

  const handleTempChange = (val: string) => {
    setTemperature(val);
    setReadingSources(prev => ({
      ...prev,
      temperature: prev.temperature === 'ocr_confirmed' ? 'ocr_edited' : prev.temperature
    }));
  };

  const handleHumidityChange = (val: string) => {
    setHumidity(val);
    setReadingSources(prev => ({
      ...prev,
      humidity: prev.humidity === 'ocr_confirmed' ? 'ocr_edited' : prev.humidity
    }));
  };

  const handleSunlightChange = (val: string) => {
    setSunlightLevel(val);
    setReadingSources(prev => ({
      ...prev,
      sunlightLevel: prev.sunlightLevel === 'ocr_confirmed' ? 'ocr_edited' : prev.sunlightLevel
    }));
  };

  const startScanner = () => {
    setOcrModalOpen(true);
    setActiveStep('capture');
    setSelectedTemplate('custom');
    setOcrPreviewUrl(null);
    setOcrBinarizedUrl(null);
    setOcrUnitError(null);
    setOcrValidationError(null);
    setMeterPhotoFile(null);
  };

  const handleOcrFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setMeterPhotoFile(file);
    setIsOcrAnalyzing(true);
    const preview = URL.createObjectURL(file);
    setOcrPreviewUrl(preview);
    
    const img = new Image();
    img.src = preview;
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
      }
      
      setTimeout(async () => {
        const res = await processMeterImage(canvas);
        setOcrBinarizedUrl(res.binarizedDataUrl);
        setModalPh(res.data.ph !== null ? String(res.data.ph) : '');
        setModalEc(res.data.ec !== null ? String(res.data.ec) : '');
        setModalTemp(res.data.temperature !== null ? String(res.data.temperature) : '');
        setModalHumid(res.data.humidity !== null ? String(res.data.humidity) : '');
        setModalLight(res.data.lightBars !== null ? String(res.data.lightBars) : '');
        setModalMoist(res.data.moistCells !== null ? String(res.data.moistCells) : '');
        
        setOcrUnitError(res.unitError);
        setOcrValidationError(res.validationError);
        setIsOcrAnalyzing(false);
        setActiveStep('confirm');
      }, 1200);
    };
  };

  const handleTemplateScan = async () => {
    setIsOcrAnalyzing(true);
    setTimeout(async () => {
      const dummyCanvas = document.createElement('canvas');
      dummyCanvas.width = 300;
      dummyCanvas.height = 150;
      const res = await processMeterImage(dummyCanvas, selectedTemplate as any);
      
      setOcrPreviewUrl(null);
      setOcrBinarizedUrl(res.binarizedDataUrl);
      setModalPh(res.data.ph !== null ? String(res.data.ph) : '');
      setModalEc(res.data.ec !== null ? String(res.data.ec) : '');
      setModalTemp(res.data.temperature !== null ? String(res.data.temperature) : '');
      setModalHumid(res.data.humidity !== null ? String(res.data.humidity) : '');
      setModalLight(res.data.lightBars !== null ? String(res.data.lightBars) : '');
      setModalMoist(res.data.moistCells !== null ? String(res.data.moistCells) : '');
      
      setOcrUnitError(res.unitError);
      setOcrValidationError(res.validationError);
      setIsOcrAnalyzing(false);
      setActiveStep('confirm');
    }, 1200);
  };

  const getDynamicErrors = () => {
    let uError = ocrUnitError;
    let vError = ocrValidationError;
    
    const phNum = Number(modalPh);
    if (!isNaN(phNum) && modalPh !== '') {
      if (phNum < 3.5 || phNum > 9.0) {
        vError = 'Soil pH is out of bounds (3.5-9.0). Check if the probe is fully inserted in moist soil.';
      } else {
        if (vError && (vError.includes('pH is 0.0') || vError.includes('out of bounds'))) {
          vError = null;
        }
      }
    }
    
    const tempNum = Number(modalTemp);
    if (!isNaN(tempNum) && tempNum > 50) {
      uError = 'Temperature is in °F. Please click unit toggle on the meter to switch to °C.';
    }
    
    return { uError, vError };
  };

  const autoConvertUnits = () => {
    const tempNum = Number(modalTemp);
    if (!isNaN(tempNum) && tempNum > 50) {
      const converted = ((tempNum - 32) * 5) / 9;
      setModalTemp(converted.toFixed(1));
    }
    
    const ecNum = Number(modalEc);
    if (!isNaN(ecNum) && ecNum > 10) {
      const converted = ecNum / 1000;
      setModalEc(converted.toFixed(2));
    }

    setOcrUnitError(null);
  };

  const confirmOcrValues = () => {
    const { uError, vError } = getDynamicErrors();
    if (uError) {
      alert('Cannot confirm with unit errors. Please switch the units and retake the photo.');
      return;
    }
    if (vError) {
      alert('Cannot confirm with validation errors. Please correct the out-of-bounds soil pH or retake the photo.');
      return;
    }
    
    if (modalPh !== '') {
      setSoilPh(Number(modalPh));
      setReadingSources(prev => ({ ...prev, soilPh: 'ocr_confirmed' }));
    }
    if (modalEc !== '') {
      setSoilEc(modalEc);
      setReadingSources(prev => ({ ...prev, soilEc: 'ocr_confirmed' }));
    }
    if (modalTemp !== '') {
      setTemperature(modalTemp);
      setReadingSources(prev => ({ ...prev, temperature: 'ocr_confirmed' }));
    }
    if (modalHumid !== '') {
      setHumidity(modalHumid);
      setReadingSources(prev => ({ ...prev, humidity: 'ocr_confirmed' }));
    }
    if (modalMoist !== '') {
      setMoisture(modalMoist);
      setReadingSources(prev => ({ ...prev, moisture: 'ocr_confirmed' }));
      
      const moistVal = Number(modalMoist);
      if (moistVal <= 2) setWateringStatus('Dry out');
      else if (moistVal <= 5) setWateringStatus('Partially dry');
      else if (moistVal <= 8) setWateringStatus('Keep moist');
      else setWateringStatus('High humidity');
    }
    if (modalLight !== '') {
      const lightVal = Number(modalLight);
      let level = 'bright_indirect';
      if (lightVal <= 1) level = 'low';
      else if (lightVal <= 3) level = 'medium';
      else if (lightVal <= 6) level = 'bright_indirect';
      else level = 'bright';
      
      setSunlightLevel(level);
      setReadingSources(prev => ({ ...prev, sunlightLevel: 'ocr_confirmed' }));
    }
    
    setOcrModalOpen(false);
  };

  useEffect(() => {
    if (!plantId) {
      alert('No plant specified for inspection.');
      router.push('/inspect');
      return;
    }

    const loadPlantDetails = async () => {
      let details = await getPlant(plantId);
      
      if (!details && navigator.onLine) {
        try {
          const { data, error } = await supabase
            .from('plants')
            .select('*')
            .eq('plant_id', plantId)
            .maybeSingle();
          if (!error && data) {
            details = { ...data, sync_status: 'synced' };
            await savePlantOffline(details);
          }
        } catch (e) {
          console.error('Failed to fetch individual plant from Supabase:', e);
        }
      }

      if (details) {
        setStaticDetails(details);
      } else {
        // Fallback placeholder if plant is not registered yet
        const parts = plantId.split('-');
        const zoneChar = parts[0]?.charAt(0) || 'A';
        const blockVal = parts[0]?.substring(1) || '01';
        const plantNo = parseInt(parts[1]?.substring(1) || '1');

        setStaticDetails({
          plant_id: plantId,
          zone: zoneChar,
          block: blockVal,
          plant_no: plantNo,
          common_name: 'Vanilla (Unregistered)',
          variety: 'Local',
          plant_type: 'Cutting'
        });
      }

      const prevH = await getPreviousHeight(plantId);
      setLastHeight(prevH);

      // Load carried fertilizer settings offline-first
      try {
        if (navigator.onLine) {
          try {
            const { data, error } = await supabase
              .from('carried_fertilizer')
              .select('*')
              .eq('id', 'default')
              .maybeSingle();
            if (!error && data) {
              await saveSetting('carried_fertilizer', {
                fertilizer_types: data.fertilizer_types || [],
                fertilizer_description: data.fertilizer_description || '',
                last_fertilized_date: data.last_fertilized_date || '',
                updated_at: data.updated_at,
                updated_by: data.updated_by || 'unknown'
              });
            }
          } catch (e) {
            console.error('Failed to pre-fetch carried fertilizer:', e);
          }
        }

        const carried = await getSetting('carried_fertilizer');
        if (carried) {
          setFertilizerType(carried.fertilizer_types || []);
          setFertilizerUsed(carried.fertilizer_description || '');
          setLastFertilized(carried.last_fertilized_date || '');
          setCarriedInfo(carried);
        }
      } catch (err) {
        console.error('Failed to load carried fertilizer:', err);
      }
    };

    loadPlantDetails();
  }, [plantId]);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
    }
  };

  const handleFertilizerToggle = (type: string) => {
    if (isFixed) return;
    setFertilizerType(prev => 
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const handleToggleFixed = async () => {
    if (isFixed) {
      setIsFixed(false);
      setHasBeenUnlocked(true);
    } else {
      setIsFixed(true);

      // Commit to local cache and Supabase
      let supervisorEmail = 'supervisor@sapori.lk';
      if (typeof window !== 'undefined') {
        const profileStr = localStorage.getItem('google_user_profile');
        if (profileStr) {
          try {
            const profile = JSON.parse(profileStr);
            supervisorEmail = profile.email || 'supervisor@sapori.lk';
          } catch {}
        }
      }

      const carried = {
        fertilizer_types: fertilizerType,
        fertilizer_description: fertilizerUsed,
        last_fertilized_date: lastFertilized,
        updated_at: new Date().toISOString(),
        updated_by: supervisorEmail
      };

      await saveSetting('carried_fertilizer', carried);
      setCarriedInfo(carried);

      if (navigator.onLine) {
        try {
          await supabase
            .from('carried_fertilizer')
            .upsert({
              id: 'default',
              fertilizer_types: fertilizerType,
              fertilizer_description: fertilizerUsed,
              last_fertilized_date: lastFertilized,
              updated_at: carried.updated_at,
              updated_by: supervisorEmail
            });
        } catch (e) {
          console.error('Failed to sync carried fertilizer on lock:', e);
        }
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plantId) return;
    setLoading(true);

    try {
      const mapSunlightToLux = (val: string | null) => {
        switch (val) {
          case 'bright': return '>20,000 lux';
          case 'bright_indirect': return '10,000-20,000 lux';
          case 'medium': return '1,000-10,000 lux';
          case 'low': return '<1,000 lux';
          default: return null;
        }
      };

      const mapShadeToPercentage = (val: string | null) => {
        switch (val) {
          case 'light': return '0-25%';
          case 'partial': return '25-50%';
          case 'moderate': return '50-70%';
          case 'heavy': return '>70%';
          default: return null;
        }
      };

      const inspectionData = {
        plant_id: plantId,
        watering_status: wateringStatus,
        sunlight_level: sunlightLevel,
        shade_level: shadeLevel,
        sunlight_lux: mapSunlightToLux(sunlightLevel),
        shade_percentage: mapShadeToPercentage(shadeLevel),
        soil_type: soilType,
        soil_ph: soilPh ? Number(soilPh) : null,
        soil_ec: soilEc ? Number(soilEc) : null,
        moisture: moisture ? Number(moisture) : null,
        temperature: temperature ? Number(temperature) : null,
        humidity: humidity ? Number(humidity) : null,
        fertilizer_type: fertilizerType,
        fertilizer_used: fertilizerUsed || null,
        last_fertilized: lastFertilized || null,
        vine_height_cm: vineHeight ? Number(vineHeight) : null,
        foliage_color: foliageColor,
        notes: notes || null,
        fertilizer_source: hasBeenUnlocked ? 'edited' : 'carried',
        reading_source: readingSources
      };

      // Save offline
      const inspectionId = await saveInspectionOfflineService(inspectionData, photoFile, meterPhotoFile);

      // Trigger background synchronization
      syncPendingSubmissions().catch(err => console.error('Sync failed:', err));

      router.push(`/inspect/success?id=${inspectionId}`);
    } catch (err: any) {
      console.error(err);
      alert('Failed to log inspection: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const isStale = (() => {
    if (!carriedInfo || !carriedInfo.updated_at) return false;
    const diffTime = Math.abs(new Date().getTime() - new Date(carriedInfo.updated_at).getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 30;
  })();

  if (!staticDetails) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-surface min-h-screen pb-24">
      {/* Header */}
      <div className="bg-primary text-white px-5 py-4 flex items-center gap-3">
        <button onClick={() => router.push('/inspect')} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Log Inspection</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">Dynamic periodic observation record</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-6 flex-1">
        {/* static plant details card */}
        <div className="bg-white/80 border border-border-light rounded-2xl p-4 shadow-xs flex justify-between items-center">
          <div>
            <span className="text-[9px] font-bold text-primary px-2 py-0.5 rounded-full bg-pale-green">
              Active Plant ID
            </span>
            <h2 className="text-lg font-black text-text-primary mt-1">
              {staticDetails.slot_id ? `${staticDetails.slot_id} · G${staticDetails.generation || 1}` : staticDetails.plant_id}
            </h2>
            <p className="text-[10px] text-text-secondary mt-0.5">
              {staticDetails.common_name} ({staticDetails.variety}) • Zone {staticDetails.zone} • Block {staticDetails.block}
            </p>
            {staticDetails.slot_id && (
              <p className="text-[9px] text-text-secondary mt-0.5">
                Plant ID: {staticDetails.plant_id}
              </p>
            )}
          </div>
          <div className="text-right">
            <span className="text-[9px] font-bold text-text-secondary block">Last Height</span>
            <span className="text-xs font-black text-primary block mt-0.5">
              {lastHeight ? `${lastHeight} cm` : 'None logged'}
            </span>
          </div>
        </div>

        {/* SECTION 1: CARE */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
            <Droplet className="h-3.5 w-3.5 text-primary" />
            Care Information
          </h3>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1.5">Watering Status</label>
              <div className="grid grid-cols-2 gap-2">
                {['Keep moist', 'Partially dry', 'Dry out', 'High humidity'].map(w => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWateringStatus(w)}
                    className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                      wateringStatus === w
                        ? 'bg-primary text-white border-primary'
                        : 'bg-white text-text-secondary border-border-light hover:bg-surface'
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase mb-1.5 flex items-center justify-between">
                <span>Sunlight Level</span>
                {readingSources.sunlightLevel !== 'manual' && (
                  <span className={`text-[8.5px] font-bold px-2 py-0.5 rounded-full ${
                    readingSources.sunlightLevel === 'ocr_confirmed' 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-amber-100 text-amber-700'
                  }`}>
                    {readingSources.sunlightLevel === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                  </span>
                )}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'bright', name: 'Bright', bars: '7-9 bars', lux: '>20,000 lux' },
                  { value: 'bright_indirect', name: 'Bright indirect', bars: '4-6 bars', lux: '10,000-20,000 lux' },
                  { value: 'medium', name: 'Medium', bars: '2-3 bars', lux: '1,000-10,000 lux' },
                  { value: 'low', name: 'Low', bars: '0-1 bars', lux: '<1,000 lux' }
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSunlightChange(opt.value)}
                    className={`py-3 px-2 rounded-xl text-center border transition-all duration-200 ${
                      sunlightLevel === opt.value
                        ? 'bg-primary text-white border-primary shadow-xs'
                        : 'bg-white text-text-secondary border-border-light hover:bg-surface hover:border-primary/20'
                    }`}
                  >
                    <span className="text-xs tracking-tight block truncate">
                      <span className="font-bold">{opt.name}</span>
                      <span className={`text-[10px] font-normal ${sunlightLevel === opt.value ? 'text-white/80' : 'text-text-secondary/80'}`}>
                        {' • '}{opt.bars}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1.5">Shade Level</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'light', name: 'Light', range: '0-25%' },
                  { value: 'partial', name: 'Partial', range: '25-50%' },
                  { value: 'moderate', name: 'Moderate', range: '50-70%' },
                  { value: 'heavy', name: 'Heavy', range: '>70%' }
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setShadeLevel(opt.value)}
                    className={`py-3 px-2 rounded-xl text-center border transition-all duration-200 ${
                      shadeLevel === opt.value
                        ? 'bg-primary text-white border-primary shadow-xs'
                        : 'bg-white text-text-secondary border-border-light hover:bg-surface hover:border-primary/20'
                    }`}
                  >
                    <span className="text-xs tracking-tight block truncate">
                      <span className="font-bold">{opt.name}</span>
                      <span className={`text-[10px] font-normal ${shadeLevel === opt.value ? 'text-white/80' : 'text-text-secondary/80'}`}>
                        {' • '}{opt.range}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 2: ENVIRONMENT */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
              <Thermometer className="h-3.5 w-3.5 text-primary" />
              Environment & Soil
            </h3>
            
            {/* Scan Meter Button */}
            <button
              type="button"
              onClick={startScanner}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-bold bg-primary text-white border-primary hover:bg-primary/95 shadow-xs transition-all"
            >
              <Camera className="h-3.5 w-3.5" />
              <span>Scan Meter</span>
            </button>
          </div>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Soil Type</label>
                <select
                  value={soilType}
                  onChange={(e) => setSoilType(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary bg-surface"
                >
                  <option value="Acidic">Acidic</option>
                  <option value="Standard">Standard</option>
                  <option value="Cactus">Cactus</option>
                  <option value="Orchid">Orchid</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Soil pH</span>
                  {readingSources.soilPh !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.soilPh === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.soilPh === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={soilPh}
                  onChange={(e) => handlePhChange(Number(e.target.value))}
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Soil EC (dS/m)</span>
                  {readingSources.soilEc !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.soilEc === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.soilEc === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={soilEc}
                  onChange={(e) => handleEcChange(e.target.value)}
                  placeholder="e.g. 1.2"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Moisture (Gauge/%)</span>
                  {readingSources.moisture !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.moisture === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.moisture === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  value={moisture}
                  onChange={(e) => handleMoistureChange(e.target.value)}
                  placeholder="e.g. 7"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
                <p className="text-[8px] text-text-secondary/70 mt-0.5">Note: OCR scans input a raw 0-10 relative gauge reading.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Temperature (°C)</span>
                  {readingSources.temperature !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.temperature === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.temperature === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => handleTempChange(e.target.value)}
                  placeholder="e.g. 28.5"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Humidity (%)</span>
                  {readingSources.humidity !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.humidity === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.humidity === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  value={humidity}
                  onChange={(e) => handleHumidityChange(e.target.value)}
                  placeholder="e.g. 80"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 3: MEASUREMENTS & DISEASE */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
            <Ruler className="h-3.5 w-3.5 text-primary" />
            Measurements & Disease
          </h3>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase">Vine Height (cm)</label>
              <input
                type="number"
                value={vineHeight}
                onChange={(e) => setVineHeight(e.target.value)}
                placeholder="e.g. 150"
                className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                required
              />
            </div>

            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase block mb-2">Foliage Color</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Green', bg: '#16A34A' },
                  { label: 'Yellow', bg: '#F59E0B' },
                  { label: 'Brown', bg: '#78350F' },
                  { label: 'Red', bg: '#EF4444' },
                  { label: 'Mixed', bg: 'linear-gradient(135deg, #16A34A 0%, #78350F 100%)', fullWidth: true }
                ].map(opt => {
                  const isSelected = foliageColor === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => setFoliageColor(opt.label)}
                      className={`flex items-center gap-3 w-full p-2.5 rounded-xl border text-left transition-all ${
                        opt.fullWidth ? 'col-span-2' : ''
                      } ${
                        isSelected
                          ? 'border-primary bg-pale-green font-bold text-primary shadow-xs'
                          : 'border-border-light bg-white text-text-secondary hover:border-primary/10'
                      }`}
                    >
                      <div 
                        className="h-4.5 w-4.5 rounded-full border border-black/10 shrink-0" 
                        style={{ background: opt.bg }}
                      />
                      <span className="text-xs font-semibold">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 4: FERTILIZER & OBSERVATIONS */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Fertilizer & Notes
            </h3>
            
            {/* Toggle Button */}
            <button
              type="button"
              onClick={handleToggleFixed}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-bold transition-all shadow-xs ${
                isFixed
                  ? 'bg-pale-green border-primary/20 text-primary hover:bg-pale-green/80'
                  : 'bg-orange-50 border-orange-200 text-orange-600 hover:bg-orange-100'
              }`}
            >
              {isFixed ? (
                <>
                  <Lock className="h-3.5 w-3.5" />
                  <span>Fixed</span>
                </>
              ) : (
                <>
                  <Unlock className="h-3.5 w-3.5 animate-pulse" />
                  <span>Editing</span>
                </>
              )}
            </button>
          </div>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            {isStale && (
              <div className="flex items-start gap-2.5 p-3 rounded-xl bg-orange-50 border border-orange-200/60 text-orange-700">
                <AlertCircle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="text-xs font-bold">Fertilizer settings stale</p>
                  <p className="text-[10px] leading-relaxed text-orange-600/90 font-medium">
                    These settings have not been verified/updated for over 30 days. Please click &apos;Editing&apos; to verify or update them.
                  </p>
                </div>
              </div>
            )}

            {/* Fertilizer inputs container (dimmed/disabled in Fixed state) */}
            <div 
              className={`space-y-4 transition-all duration-200 ${isFixed ? 'opacity-70 pointer-events-none' : ''}`}
              style={{ cursor: isFixed ? 'not-allowed' : 'auto' }}
            >
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1.5">Fertilizer Types Applied</label>
                <div className="grid grid-cols-2 gap-2">
                  {['All purpose', 'Cactus', 'Acidic', 'Orchid'].map(ft => {
                    const active = fertilizerType.includes(ft);
                    return (
                      <button
                        key={ft}
                        type="button"
                        onClick={() => handleFertilizerToggle(ft)}
                        disabled={isFixed}
                        className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                          isFixed ? 'cursor-not-allowed' : ''
                        } ${
                          active
                            ? 'bg-primary text-white border-primary'
                            : 'bg-white text-text-secondary border-border-light hover:bg-surface'
                        }`}
                      >
                        {ft}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Fertilizer Used (Description)</label>
                <input
                  type="text"
                  value={fertilizerUsed}
                  onChange={(e) => setFertilizerUsed(e.target.value)}
                  disabled={isFixed}
                  placeholder="e.g. Compost tea, Organic fertilizer"
                  className={`w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary ${
                    isFixed ? 'cursor-not-allowed bg-gray-50 text-gray-400' : ''
                  }`}
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Last Fertilized Date</label>
                <input
                  type="date"
                  value={lastFertilized}
                  onChange={(e) => setLastFertilized(e.target.value)}
                  disabled={isFixed}
                  className={`w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary ${
                    isFixed ? 'cursor-not-allowed bg-gray-50 text-gray-400' : ''
                  }`}
                />
              </div>
            </div>

            {/* Notes / Observations remains fully interactive */}
            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase">Notes / Observations</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Any special remarks or details regarding vine shape, pest infestation..."
                className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary placeholder:text-gray-300"
              />
            </div>
          </div>
        </div>

        {/* SECTION 5: PHOTO */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
            <Camera className="h-3.5 w-3.5 text-primary" />
            Upload Photo
          </h3>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div className="flex flex-col items-center gap-3">
              {photoPreview ? (
                <div className="relative w-full h-48 rounded-2xl overflow-hidden border border-border-light bg-black">
                  <img src={photoPreview} alt="Preview" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => {
                      setPhotoFile(null);
                      setPhotoPreview(null);
                    }}
                    className="absolute top-2 right-2 bg-red-600 text-white rounded-full p-1.5 shadow-md hover:bg-red-700 text-[10px] font-bold"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="w-full h-32 border-2 border-dashed border-border-light rounded-2xl flex flex-col items-center justify-center text-text-secondary">
                  <Camera className="h-8 w-8 opacity-45" />
                  <span className="text-[10px] mt-1.5">No photo selected</span>
                </div>
              )}

              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoChange}
                className="w-full text-xs text-text-secondary file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-pale-green file:text-primary hover:file:bg-pale-green/80"
              />
            </div>
          </div>
        </div>

        {/* Submit */}
        <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light z-30">
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-white py-3.5 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {loading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Logging Inspection...
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                Submit Inspection Report
              </>
            )}
          </button>
        </div>
      </form>

      {/* OCR Scanner Modal */}
      {ocrModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-md overflow-hidden border border-border-light shadow-2xl flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-4 border-b border-border-light flex justify-between items-center bg-pale-green/30">
              <div className="flex items-center gap-2">
                <Camera className="h-5 w-5 text-primary animate-pulse" />
                <h2 className="font-bold text-sm text-secondary uppercase tracking-wider text-left">Scan LCD Meter Display</h2>
              </div>
              <button
                type="button"
                onClick={() => setOcrModalOpen(false)}
                className="text-text-secondary hover:text-red-500 transition-all p-1"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto flex-1 space-y-4">
              {isOcrAnalyzing ? (
                /* Analyzing State */
                <div className="flex flex-col items-center justify-center py-12 space-y-4">
                  <div className="relative h-16 w-16">
                    <div className="absolute inset-0 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                    <RefreshCw className="absolute inset-0 m-auto h-6 w-6 text-primary animate-pulse" />
                  </div>
                  <div className="text-center space-y-1">
                    <p className="text-xs font-bold text-secondary uppercase tracking-wider">Analyzing LCD Display...</p>
                    <p className="text-[10px] text-text-secondary">On-device seven-segment OCR parser running</p>
                  </div>
                </div>
              ) : activeStep === 'capture' ? (
                /* Capture / Select Template Step */
                <div className="space-y-4">
                  <div className="space-y-1.5 text-center">
                    <p className="text-xs font-bold text-secondary">Select Meter Test Image or Camera Capture</p>
                    <p className="text-[10px] text-text-secondary leading-relaxed">
                      Capture a crisp, frame-filling, square-on shot of the LCD display under bright lighting.
                    </p>
                  </div>

                  {/* Camera guides preview */}
                  <div className="relative border-2 border-dashed border-border-light rounded-2xl bg-surface p-4 flex flex-col items-center justify-center min-h-[140px] text-center overflow-hidden">
                    <div className="absolute inset-0 bg-primary/2 opacity-[0.02]" />
                    {/* Visual box guides */}
                    <div className="absolute border border-primary/40 rounded-lg w-5/6 h-5/6 pointer-events-none flex flex-col justify-between p-2">
                      <div className="flex justify-between">
                        <div className="border-t-2 border-l-2 border-primary h-3 w-3" />
                        <div className="border-t-2 border-r-2 border-primary h-3 w-3" />
                      </div>
                      <span className="text-[9px] font-bold text-primary/45 uppercase select-none tracking-widest">Align Meter Screen Here</span>
                      <div className="flex justify-between">
                        <div className="border-b-2 border-l-2 border-primary h-3 w-3" />
                        <div className="border-b-2 border-r-2 border-primary h-3 w-3" />
                      </div>
                    </div>
                    <Camera className="h-10 w-10 text-text-secondary opacity-30 mb-2" />
                    <span className="text-[10px] font-bold text-text-secondary">Align LCD within the box frame</span>
                  </div>

                  <div className="bg-orange-50 border border-orange-200 rounded-xl p-2.5 text-left text-orange-700 text-[10px] space-y-1">
                    <p className="font-bold flex items-center gap-1">⚠️ Capture Guide & Safety Fallback</p>
                    <ul className="list-disc pl-3.5 space-y-0.5 font-semibold text-orange-600/90">
                      <li>The screen must be square-on, flat, and fully fill the guide box.</li>
                      <li>Implausible readings (like pH outside 3.5–9.0 range) will be rejected to prevent bad data.</li>
                      <li>Any unreadable digit cells can be easily filled in manually afterward.</li>
                    </ul>
                  </div>

                  {/* Actions for Capture */}
                  <div className="space-y-2 pt-2">
                    <div className="flex flex-col items-center">
                      <input
                        id="ocr-file-upload"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handleOcrFileSelect}
                        className="hidden"
                      />
                      <label
                        htmlFor="ocr-file-upload"
                        className="w-full bg-primary text-white py-3 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer text-center transition-all"
                      >
                        <Camera className="h-4 w-4" />
                        Snap / Choose Meter Photo
                      </label>
                    </div>
                  </div>
                </div>
              ) : (
                /* Confirm Step */
                <div className="space-y-4">
                  {/* Dynamic Rejection / Verification Warnings */}
                  {(() => {
                    const { uError, vError } = getDynamicErrors();
                    const isAllFailed = modalPh === '' && modalEc === '' && modalTemp === '' && modalHumid === '';
                    const isPartialRead = modalPh === '' || modalEc === '' || modalTemp === '' || modalHumid === '';
                    return (
                      <>
                        {uError && (
                          <div className="flex flex-col gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-left">
                            <div className="flex items-start gap-2.5">
                              <AlertTriangle className="h-4 w-4 shrink-0 text-red-500 mt-0.5" />
                              <div className="space-y-0.5">
                                <p className="text-xs font-bold">Incorrect Units Detected</p>
                                <p className="text-[10px] leading-relaxed text-red-600/90 font-semibold">{uError}</p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={autoConvertUnits}
                              className="mt-1 self-start px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-bold shadow-xs transition-all"
                            >
                              Auto-Convert to Metric (°C / mS/cm)
                            </button>
                          </div>
                        )}
                        {!uError && vError && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-orange-50 border border-orange-200 text-orange-700 text-left">
                            <AlertCircle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">Impossible Reading Rejected</p>
                              <p className="text-[10px] leading-relaxed text-orange-600/90 font-semibold">{vError}</p>
                            </div>
                          </div>
                        )}
                        {!uError && !vError && isAllFailed && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-left">
                            <AlertCircle className="h-4 w-4 shrink-0 text-red-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">LCD Display Read Failed</p>
                              <p className="text-[10px] leading-relaxed text-red-600/90">Could not confidently parse any digit fields. Please verify and manually input values or retake the photo.</p>
                            </div>
                          </div>
                        )}
                        {!uError && !vError && !isAllFailed && isPartialRead && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-orange-50 border border-orange-200 text-orange-700 text-left">
                            <AlertCircle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">LCD Display Partial Read</p>
                              <p className="text-[10px] leading-relaxed text-orange-600/90">Some digits were unreadable and left blank. Please review the highlighted fields and fill them in manually.</p>
                            </div>
                          </div>
                        )}
                        {!uError && !vError && !isAllFailed && !isPartialRead && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-left">
                            <Check className="h-4 w-4 shrink-0 text-green-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">LCD Display Read Success</p>
                              <p className="text-[10px] leading-relaxed text-green-600/90">Please verify the detected digital readings before filling the form.</p>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* Dual Image Visualizer (Original Cropped / Binarized Segment Layout) */}
                  <div className="grid grid-cols-2 gap-3.5">
                    <div className="space-y-1">
                      <p className="text-[9px] font-bold text-text-secondary uppercase text-center">Original Cropped LCD</p>
                      <div className="border border-border-light rounded-xl h-28 overflow-hidden bg-black flex items-center justify-center">
                        {ocrPreviewUrl ? (
                          <img src={ocrPreviewUrl} alt="Cropped" className="max-w-full max-h-full object-contain" />
                        ) : (
                          <div className="flex flex-col items-center justify-center text-white/55">
                            <Camera className="h-6 w-6" />
                            <span className="text-[8px] mt-1">YIERYI Meter</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[9px] font-bold text-text-secondary uppercase text-center">CV Segment Binarization</p>
                      <div className="border border-border-light rounded-xl h-28 overflow-hidden bg-black flex items-center justify-center">
                        {ocrBinarizedUrl ? (
                          <img src={ocrBinarizedUrl} alt="Binarized" className="max-w-full max-h-full object-contain filter invert" />
                        ) : (
                          <div className="text-[8px] text-white/50">Processing...</div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Readings Input list */}
                  <div className="space-y-3 pt-2 text-left">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Soil pH</span>
                          {modalPh === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          value={modalPh}
                          onChange={(e) => setModalPh(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalPh === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Soil EC (mS/cm)</span>
                          {modalEc === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          value={modalEc}
                          onChange={(e) => setModalEc(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalEc === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Temp (°C)</span>
                          {modalTemp === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          value={modalTemp}
                          onChange={(e) => setModalTemp(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalTemp === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Humidity (%)</span>
                          {modalHumid === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          value={modalHumid}
                          onChange={(e) => setModalHumid(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalHumid === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Light (Bars)</span>
                          {modalLight === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          value={modalLight}
                          onChange={(e) => setModalLight(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalLight === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Moist (Gauge)</span>
                          {modalMoist === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          value={modalMoist}
                          onChange={(e) => setModalMoist(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalMoist === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Actions for Confirm */}
                  <div className="grid grid-cols-2 gap-3 pt-3">
                    <button
                      type="button"
                      onClick={() => setActiveStep('capture')}
                      className="bg-white text-text-secondary border border-border-light py-3 rounded-full font-bold text-xs hover:bg-surface active:scale-95 transition-all"
                    >
                      Retake / Back
                    </button>
                    
                    <button
                      type="button"
                      onClick={confirmOcrValues}
                      disabled={!!getDynamicErrors().uError || (!!getDynamicErrors().vError && Number(modalPh) === 0.0)}
                      className="bg-primary text-white py-3 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 transition-all"
                    >
                      <Check className="h-4 w-4" />
                      Confirm & Fill
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

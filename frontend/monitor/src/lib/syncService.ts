import {
  saveSubmissionOffline as saveDBOffline,
  getPendingSubmissions,
  markAsSyncedInDB,
  getMortalityReports,
  getPendingPlants,
  getPendingInspections,
  markPlantAsSynced,
  markInspectionAsSynced,
  getPlant,
  savePlantOffline as saveLocalPlant,
  saveInspectionOffline as saveLocalInsp,
  getSetting,
  saveSetting,
  getPendingSlots,
  markSlotAsSynced,
  saveSlotOffline as saveLocalSlot,
  getSlot
} from './offline-db';
import { appendToSheets, buildSheetRow } from './sheetsService';
import { supabase } from './supabaseClient';
import { getGoogleAccessToken } from './authService';

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


/**
 * Converts a Blob to a Base64-encoded string.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Converts a Base64 string back to a Blob.
 */
export function base64ToBlob(base64: string, contentType = 'image/jpeg'): Blob {
  const byteCharacters = atob(base64);
  const byteArrays = [];

  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }

  return new Blob(byteArrays, { type: contentType });
}

/**
 * Saves a new plant static information offline in IndexedDB.
 */
export async function savePlantOfflineService(plantData: any): Promise<void> {
  const plant = {
    ...plantData,
    sync_status: 'pending',
    created_at: plantData.created_at || new Date().toISOString()
  };
  await saveLocalPlant(plant);
}



/**
 * Saves a new slot offline in IndexedDB.
 */
export async function saveSlotOfflineService(slotData: any): Promise<void> {
  const slot = {
    ...slotData,
    sync_status: 'pending',
    created_at: slotData.created_at || new Date().toISOString()
  };
  await saveLocalSlot(slot);
}

/**
 * Saves an inspection submission locally in IndexedDB.
 */
export async function saveInspectionOfflineService(
  inspData: any,
  photoBlob: Blob | null,
  meterPhotoBlob: Blob | null = null
): Promise<string> {
  const now = new Date();
  
  // Format inspection unique ID
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, '');
  const inspectionId = `${inspData.plant_id}-${dateStr}-${timeStr}`;

  // Get supervisor info
  let supervisorName = 'Field Supervisor';
  let supervisorEmail = 'supervisor@sapori.lk';
  if (typeof window !== 'undefined') {
    const profileStr = localStorage.getItem('google_user_profile');
    if (profileStr) {
      try {
        const profile = JSON.parse(profileStr);
        supervisorName = profile.name;
        supervisorEmail = profile.email;
      } catch {}
    }
  }

  const photoBase64 = photoBlob ? await blobToBase64(photoBlob) : null;
  const photoFilename = photoBlob
    ? `Inspection_${inspData.plant_id}_${now.toISOString().slice(0, 10)}.jpg`
    : null;

  const meterPhotoBase64 = meterPhotoBlob ? await blobToBase64(meterPhotoBlob) : null;
  const meterPhotoFilename = meterPhotoBlob
    ? `Meter_${inspData.plant_id}_${now.toISOString().slice(0, 10)}_${timeStr}.jpg`
    : null;

  const inspection = {
    ...inspData,
    id: inspectionId,
    sync_status: 'pending',
    sync_attempts: 0,
    inspection_date: now.toISOString().slice(0, 10),
    created_at: now.toISOString(),
    supervisor_name: supervisorName,
    supervisor_email: supervisorEmail,
    photo_blob: photoBase64,
    photo_filename: photoFilename,
    meter_photo_blob: meterPhotoBase64,
    meter_photo_filename: meterPhotoFilename
  };

  await saveLocalInsp(inspection);
  return inspectionId;
}

/**
 * Saves an inspection submission locally in IndexedDB (Legacy compatibility wrapper).
 */
export async function saveInspectionOffline(formData: any, photoBlob: Blob | null): Promise<string> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, '');
  const submissionId = `${formData.zone}-${formData.block}-${formData.plant_number}-${dateStr}-${timeStr}`;

  let supervisorName = 'Field Supervisor';
  let supervisorEmail = 'supervisor@sapori.lk';
  if (typeof window !== 'undefined') {
    const profileStr = localStorage.getItem('google_user_profile');
    if (profileStr) {
      try {
        const profile = JSON.parse(profileStr);
        supervisorName = profile.name;
        supervisorEmail = profile.email;
      } catch {}
    }
  }

  const photoBase64 = photoBlob ? await blobToBase64(photoBlob) : null;
  const photoFilename = photoBlob
    ? `Plant_${formData.zone}_${formData.block}_${formData.plant_number}_${now.toISOString().slice(0, 10)}.jpg`
    : null;

  const submission = {
    ...formData,
    id: submissionId,
    status: 'pending',
    sync_status: 'pending',
    sync_attempts: 0,
    submitted_at: now.toISOString(),
    created_at: now.toISOString(),
    supervisor_name: supervisorName,
    supervisor_email: supervisorEmail,
    photo_blob: photoBase64,
    photo_filename: photoFilename
  };

  await saveDBOffline(submission);
  return submissionId;
}

/**
 * Uploads all pending plants, plant locations, inspections, and legacy submissions
 * directly to Supabase & Google Sheets (no backend required).
 */
export async function syncPendingSubmissions(): Promise<{ synced: number; failed: number }> {
  if (typeof window === 'undefined') return { synced: 0, failed: 0 };

  const isMockOffline = localStorage.getItem('mock_offline') === 'true';
  if (isMockOffline || !navigator.onLine) {
    console.warn('Sync aborted: Currently offline.');
    return { synced: 0, failed: 0 };
  }

  const token = await getGoogleAccessToken();
  const sheetId = localStorage.getItem('spreadsheet_id') || process.env.NEXT_PUBLIC_SPREADSHEET_ID || '';

  let synced = 0;
  let failed = 0;

  // 0. Sync Pending Slots → Supabase directly
  try {
    const pendingSlots = await getPendingSlots();
    for (const slot of pendingSlots) {
      try {
        const payload = { ...slot };
        delete payload.sync_status;

        // Ensure camelCase keys map to snake_case if any client created them that way
        const formattedPayload = {
          slot_id: payload.slot_id || payload.slotId,
          zone: payload.zone,
          block: payload.block,
          latitude: payload.latitude || payload.gps?.lat || null,
          longitude: payload.longitude || payload.gps?.lng || null,
          altitude: payload.altitude || null,
          accuracy: payload.accuracy || null,
          active_plant_id: payload.active_plant_id || payload.activePlantId || null,
          qr_value: payload.qr_value || payload.qrValue || null,
          created_at: payload.created_at || new Date().toISOString()
        };

        const { error } = await supabase
          .from('slots')
          .upsert(formattedPayload, { onConflict: 'slot_id' });

        if (error) {
          throw new Error(error.message);
        }

        await markSlotAsSynced(slot.slot_id);
        synced++;
      } catch (err) {
        console.error(`Sync failed for slot ${slot.slot_id}:`, err);
        failed++;
      }
    }
  } catch (err) {
    console.error('Error syncing slots:', err);
  }

  // 1. Sync Pending Plants → Supabase directly
  try {
    const pendingPlants = await getPendingPlants();
    for (const plant of pendingPlants) {
      try {
        const payload = { ...plant };
        delete payload.sync_status;

        const { error } = await supabase
          .from('plants')
          .upsert(payload, { onConflict: 'plant_id' });

        if (error) {
          throw new Error(error.message);
        }

        await markPlantAsSynced(plant.plant_id);
        synced++;
      } catch (err) {
        console.error(`Sync failed for plant ${plant.plant_id}:`, err);
        failed++;
      }
    }
  } catch (err) {
    console.error('Error syncing plants:', err);
  }



  // 3. Sync Pending Inspections (New Structure) → Supabase directly
  try {
    const pendingInspections = await getPendingInspections();
    for (const inspection of pendingInspections) {
      try {
        // Join static plant details to reconstruct a unified submission for Google Sheets
        const plant = await getPlant(inspection.plant_id);
        let zoneChar = plant?.zone;
        let blockVal = plant?.block;

        if (!zoneChar || !blockVal) {
          const match = inspection.plant_id.match(/^([A-Z])([0-9]+)-P[0-9]+$/i);
          if (match) {
            zoneChar = zoneChar || match[1].toUpperCase();
            blockVal = blockVal || match[2];
          }
        }
        
        // Final fallbacks
        zoneChar = zoneChar || inspection.plant_id.charAt(0) || 'Unknown';
        blockVal = blockVal || inspection.plant_id.substring(1, 3) || 'Unknown_Block';

        const zoneFolder = zoneChar.toUpperCase();
        const blockFolder = String(blockVal).startsWith('Block') ? blockVal : `Block ${String(blockVal).padStart(2, '0')}`;
        const plantNo = plant?.plant_no || 1;

        let supabasePhotoUrl = null;

        // Upload photo to Supabase Storage first if present
        if (inspection.photo_blob && inspection.photo_filename) {
          try {
            const blob = base64ToBlob(inspection.photo_blob);
            const filePath = `${zoneFolder}/${blockFolder}/${inspection.photo_filename}`;
            
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('inspection-photos')
              .upload(filePath, blob, {
                contentType: 'image/jpeg',
                upsert: true
              });
              
            if (uploadError) {
              console.error('Error uploading photo to Supabase Storage:', uploadError);
            } else {
              const { data: publicUrlData } = supabase.storage
                .from('inspection-photos')
                .getPublicUrl(filePath);
              supabasePhotoUrl = publicUrlData.publicUrl;
            }
          } catch (photoErr: any) {
            console.error('Failed to upload photo for inspection:', photoErr);
          }
        }

        let supabaseMeterPhotoUrl = null;

        // Upload meter photo to Supabase Storage first if present
        if (inspection.meter_photo_blob && inspection.meter_photo_filename) {
          try {
            const blob = base64ToBlob(inspection.meter_photo_blob);
            const filePath = `Meter_Readings/${zoneFolder}/${blockFolder}/${inspection.meter_photo_filename}`;
            
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('inspection-photos')
              .upload(filePath, blob, {
                contentType: 'image/jpeg',
                upsert: true
              });
              
            if (uploadError) {
              console.error('Error uploading meter photo to Supabase Storage:', uploadError);
            } else {
              const { data: publicUrlData } = supabase.storage
                .from('inspection-photos')
                .getPublicUrl(filePath);
              supabaseMeterPhotoUrl = publicUrlData.publicUrl;
            }
          } catch (photoErr: any) {
            console.error('Failed to upload meter photo for inspection:', photoErr);
          }
        }

        const unifiedSubmission = {
          id: inspection.id,
          submitted_at: inspection.created_at,
          supervisor_name: inspection.supervisor_name,
          supervisor_email: inspection.supervisor_email,
          zone: zoneChar,
          block: blockVal,
          plant_number: plantNo,
          plant_id: inspection.plant_id,
          common_name: plant?.common_name || 'Vanilla',
          latin_name: plant?.latin_name || 'Vanilla Planifolia',
          variety: plant?.variety || 'Local',
          plant_type: plant?.plant_type || 'Cutting',
          purchase_date: plant?.purchase_date || '',
          planted_date: plant?.planted_date || '',
          purchased_from: plant?.purchased_from || '',
          purchase_condition: plant?.purchase_condition || '',
          watering_status: inspection.watering_status || '',
          sunlight_level: inspection.sunlight_level || '',
          shade_level: inspection.shade_level || '',
          soil_pH: inspection.soil_ph ?? '',
          soil_pH_recorded_at: inspection.created_at,
          temperature_c: inspection.temperature ?? '',
          temperature_recorded_at: inspection.created_at,
          humidity_pct: inspection.humidity ?? '',
          humidity_recorded_at: inspection.created_at,
          soil_type: inspection.soil_type || 'Acidic',
          fertiliser_type: inspection.fertilizer_type || [],
          last_fertilised: inspection.last_fertilized || '',
          fertiliser_used: inspection.fertilizer_used || '',
          vine_height_cm: inspection.vine_height_cm || '',
          height_delta_cm: 0,
          foliage_color: inspection.foliage_color || '',
          planting_arrangement: plant?.planting_arrangement || '',
          photo_filename: inspection.photo_filename || '',
          photo_drive_url: supabasePhotoUrl || ''
        };

        if (token) {
          const rowData = buildSheetRow(unifiedSubmission, null);
          await appendToSheets(token, sheetId, rowData);
        }

        // Insert into Supabase inspections table directly
        const payload = {
          id: inspection.id,
          plant_id: inspection.plant_id,
          inspection_date: inspection.inspection_date,
          supervisor_name: inspection.supervisor_name,
          supervisor_email: inspection.supervisor_email,
          watering_status: inspection.watering_status,
          sunlight_level: inspection.sunlight_level,
          sunlight_lux: inspection.sunlight_lux,
          shade_level: inspection.shade_level,
          shade_percentage: inspection.shade_percentage,
          soil_type: inspection.soil_type,
          soil_ph: inspection.soil_ph,
          soil_ec: inspection.soil_ec,
          moisture: inspection.moisture,
          temperature: inspection.temperature,
          humidity: inspection.humidity,
          fertilizer_type: inspection.fertilizer_type,
          fertilizer_used: inspection.fertilizer_used,
          last_fertilized: inspection.last_fertilized,
          vine_height_cm: inspection.vine_height_cm,
          foliage_color: inspection.foliage_color,
          notes: inspection.notes,
          photo_url: supabasePhotoUrl || inspection.photo_url,
          fertilizer_source: inspection.fertilizer_source || 'carried',
          reading_source: {
            ...(inspection.reading_source || {}),
            ...(supabaseMeterPhotoUrl ? { meter_photo_url: supabaseMeterPhotoUrl } : {})
          },
          sync_status: 'synced'
        };

        const { error } = await supabase
          .from('inspections')
          .upsert(payload, { onConflict: 'id' });

        if (error) {
          throw new Error(error.message);
        }

        await markInspectionAsSynced(inspection.id, supabasePhotoUrl || undefined, supabaseMeterPhotoUrl || undefined);
        synced++;
      } catch (err) {
        console.error(`Sync failed for inspection ${inspection.id}:`, err);
        failed++;
      }
    }
  } catch (err) {
    console.error('Error syncing inspections:', err);
  }

  // 4. Sync Pending Submissions (Legacy) → Supabase inspections table
  try {
    const pendingSubmissions = await getPendingSubmissions();
    for (const submission of pendingSubmissions) {
      try {
        let supabasePhotoUrl = null;

        if (submission.photo_blob && submission.photo_filename) {
          try {
            const blob = base64ToBlob(submission.photo_blob);
            const zoneFolder = submission.zone ? submission.zone.toUpperCase() : 'Unknown';
            const blockFolder = submission.block ? (String(submission.block).startsWith('Block') ? submission.block : `Block ${String(submission.block).padStart(2, '0')}`) : 'Unknown_Block';
            const filePath = `${zoneFolder}/${blockFolder}/${submission.photo_filename}`;
            
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('inspection-photos')
              .upload(filePath, blob, {
                contentType: 'image/jpeg',
                upsert: true
              });
              
            if (!uploadError) {
              const { data: publicUrlData } = supabase.storage
                .from('inspection-photos')
                .getPublicUrl(filePath);
              supabasePhotoUrl = publicUrlData.publicUrl;
            }
          } catch {}
        }

        if (token) {
          const rowData = buildSheetRow(submission, null);
          await appendToSheets(token, sheetId, rowData);
        }

        // Upsert legacy submission as an inspection record in Supabase
        // Derive the plant_id in the canonical format used by the plants table
        const derivedPlantId = submission.plant_id ||
          `${submission.zone}${String(submission.block).padStart(2, '0')}-P${String(submission.plant_number || '001').padStart(3, '0')}`;

        // Verify the plant exists in Supabase before inserting (prevents FK constraint violations)
        const { data: plantCheck, error: plantCheckError } = await supabase
          .from('plants')
          .select('plant_id')
          .eq('plant_id', derivedPlantId)
          .maybeSingle();

        if (plantCheckError) {
          console.warn(`Could not verify plant ${derivedPlantId} in Supabase:`, plantCheckError.message);
        }

        if (!plantCheck) {
          // Plant doesn't exist in Supabase yet — skip DB insert but mark as synced
          // so it doesn't keep retrying. Google Sheets was already appended above.
          console.warn(`Skipping Supabase insert for legacy submission ${submission.id}: plant "${derivedPlantId}" not found in plants table.`);
          await markAsSyncedInDB(submission.id, supabasePhotoUrl || undefined);
          synced++;
          continue;
        }

        const payload = {
          id: submission.id,
          plant_id: derivedPlantId,
          inspection_date: submission.submitted_at || new Date().toISOString(),
          supervisor_name: submission.supervisor_name || null,
          supervisor_email: submission.supervisor_email || null,
          watering_status: submission.watering_status || null,
          sunlight_level: submission.sunlight_level || null,
          sunlight_lux: submission.sunlight_lux || mapSunlightToLux(submission.sunlight_level),
          shade_level: submission.shade_level || null,
          shade_percentage: submission.shade_percentage || mapShadeToPercentage(submission.shade_level),
          soil_type: submission.soil_type || null,
          soil_ph: submission.soil_pH !== undefined && submission.soil_pH !== null ? Number(submission.soil_pH) : null,
          temperature: submission.temperature_c !== undefined && submission.temperature_c !== null ? Number(submission.temperature_c) : null,
          humidity: submission.humidity_pct !== undefined && submission.humidity_pct !== null ? Number(submission.humidity_pct) : null,
          fertilizer_type: Array.isArray(submission.fertiliser_type) ? submission.fertiliser_type : (submission.fertiliser_type ? [submission.fertiliser_type] : null),
          fertilizer_used: submission.fertiliser_used || null,
          last_fertilized: submission.last_fertilised || null,
          vine_height_cm: submission.vine_height_cm !== undefined && submission.vine_height_cm !== null ? Number(submission.vine_height_cm) : null,
          foliage_color: submission.foliage_color || null,
          notes: submission.field_notes || submission.notes || null,
          photo_url: supabasePhotoUrl || submission.photo_url || null,
          fertilizer_source: submission.fertilizer_source || 'edited',
          sync_status: 'synced'
        };

        const { error } = await supabase
          .from('inspections')
          .upsert(payload, { onConflict: 'id' });

        if (error) {
          throw new Error(error.message);
        }

        await markAsSyncedInDB(submission.id, supabasePhotoUrl || undefined);
        synced++;
      } catch (err: any) {
        console.error(`Sync failed for legacy submission ${submission.id}:`, err);
        failed++;
        if (err.message === 'UNAUTHORIZED') {
          localStorage.removeItem('google_access_token');
          window.dispatchEvent(new Event('auth-status-change'));
          break;
        }
      }
    }
  } catch (err) {
    console.error('Error syncing legacy submissions:', err);
  }

  // 5. Sync Mortality Reports → Supabase directly
  try {
    const mortalityReports = await getMortalityReports();
    for (const report of mortalityReports) {
      try {
        const payload = {
          id: report.id,
          zone: report.zone,
          block: report.block,
          dead_support_trees: Number(report.dead_support_trees || 0),
          dead_vines: Number(report.dead_vines || 0),
          notes: report.notes || null,
          reported_at: report.reportedAt || report.reported_at || new Date().toISOString()
        };
        
        await supabase
          .from('mortality_reports')
          .upsert(payload, { onConflict: 'id' });
      } catch {}
    }
  } catch (err) {
    console.error('Error syncing mortality reports:', err);
  }

  // 6. Sync Carried Fertilizer Settings
  try {
    await syncCarriedFertilizer();
  } catch (err) {
    console.error('Error syncing carried fertilizer:', err);
  }

  // 7. Pull any new plants registered elsewhere
  try {
    await pullPlantsFromSupabase();
  } catch (err) {
    console.error('Error pulling plants on sync:', err);
  }

  window.dispatchEvent(new Event('sync-complete'));
  return { synced, failed };
}

/**
 * Synchronizes carried fertilizer preferences offline-first.
 */
export async function syncCarriedFertilizer(): Promise<void> {
  if (typeof window === 'undefined') return;
  const isMockOffline = localStorage.getItem('mock_offline') === 'true';
  if (isMockOffline || !navigator.onLine) {
    return;
  }

  try {
    const localCarried = await getSetting('carried_fertilizer');
    
    // Fetch from Supabase
    const { data: remoteData, error: fetchError } = await supabase
      .from('carried_fertilizer')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();

    if (fetchError) {
      console.error('Error fetching carried_fertilizer from Supabase:', fetchError.message);
      return;
    }

    if (remoteData) {
      const remoteTime = remoteData.updated_at ? new Date(remoteData.updated_at).getTime() : 0;
      const localTime = (localCarried && localCarried.updated_at) ? new Date(localCarried.updated_at).getTime() : 0;

      if (!localCarried || remoteTime > localTime) {
        // Server is newer or local is missing: update local
        await saveSetting('carried_fertilizer', {
          fertilizer_types: remoteData.fertilizer_types || [],
          fertilizer_description: remoteData.fertilizer_description || '',
          last_fertilized_date: remoteData.last_fertilized_date || '',
          updated_at: remoteData.updated_at,
          updated_by: remoteData.updated_by || 'unknown'
        });
        return;
      }
    }

    // Server is empty or local is newer: push local to server if we have local
    if (localCarried) {
      const { error: upsertError } = await supabase
        .from('carried_fertilizer')
        .upsert({
          id: 'default',
          fertilizer_types: localCarried.fertilizer_types,
          fertilizer_description: localCarried.fertilizer_description,
          last_fertilized_date: localCarried.last_fertilized_date,
          updated_at: localCarried.updated_at || new Date().toISOString(),
          updated_by: localCarried.updated_by || 'unknown'
        });

      if (upsertError) {
        console.error('Error upserting carried_fertilizer to Supabase:', upsertError.message);
      }
    }
  } catch (err) {
    console.error('Error syncing carried fertilizer:', err);
  }
}
/**
 * Fetches all registered plants and their locations from Supabase and saves them
 * to the local IndexedDB database. This ensures they are available offline.
 */
export async function pullPlantsFromSupabase(): Promise<{ slotsCount: number; plantsCount: number; locationsCount: number }> {
  if (typeof window === 'undefined') return { slotsCount: 0, plantsCount: 0, locationsCount: 0 };
  const isMockOffline = localStorage.getItem('mock_offline') === 'true';
  if (isMockOffline || !navigator.onLine) {
    return { slotsCount: 0, plantsCount: 0, locationsCount: 0 };
  }

  let slotsCount = 0;
  let plantsCount = 0;
  let locationsCount = 0;

  try {
    // 0. Fetch slots
    const { data: slotsData, error: slotsError } = await supabase
      .from('slots')
      .select('*');

    if (slotsError) {
      throw new Error(slotsError.message);
    }

    if (slotsData && slotsData.length > 0) {
      for (const slot of slotsData) {
        const existingLocal = await getSlot(slot.slot_id);
        if (existingLocal?.sync_status === 'pending') {
          continue;
        }
        await saveLocalSlot({
          ...slot,
          sync_status: 'synced'
        });
        slotsCount++;
      }
    }

    // 1. Fetch plants
    const { data: plantsData, error: plantsError } = await supabase
      .from('plants')
      .select('*');

    if (plantsError) {
      throw new Error(plantsError.message);
    }

    if (plantsData && plantsData.length > 0) {
      for (const plant of plantsData) {
        // Keep pending items in local DB if there are any conflicts,
        // otherwise save remote plant as 'synced'
        const existingLocal = await getPlant(plant.plant_id);
        if (existingLocal?.sync_status === 'pending') {
          // Keep local pending edits
          continue;
        }
        await saveLocalPlant({
          ...plant,
          sync_status: 'synced'
        });
        plantsCount++;
      }
    }


  } catch (err) {
    console.error('Error pulling plants/locations from Supabase:', err);
  }

  return { slotsCount, plantsCount, locationsCount };
}

// Auto-sync
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    syncPendingSubmissions()
      .then(results => {
        if (results.synced > 0) {
          console.log(`Auto-sync complete: ${results.synced} items synced.`);
        }
      })
      .catch(err => console.error('Auto-sync error:', err));
  });
}

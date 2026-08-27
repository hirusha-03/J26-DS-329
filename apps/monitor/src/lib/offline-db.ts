import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'vanilla-monitor';
const DB_VERSION = 3;

interface VanillaMonitorDB {
  submissions: {
    key: string;
    value: any;
    indexes: { status: string; zone: string; submittedAt: string; plant_id: string };
  };
  plant_gps: {
    key: string;
    value: { plant_id: string; lat: number; lng: number };
  };
  mortality_reports: {
    key: string;
    value: { id: string; zone: string; block: string; dead_support_trees: number; dead_vines: number; notes?: string; reportedAt: string };
  };
  settings: {
    key: string;
    value: { key: string; value: any };
  };
  plants: {
    key: string;
    value: any;
    indexes: { sync_status: string };
  };
  plant_locations: {
    key: string;
    value: any;
    indexes: { sync_status: string };
  };
  inspections: {
    key: string;
    value: any;
    indexes: { sync_status: string; plant_id: string };
  };
  slots: {
    key: string;
    value: any;
    indexes: { sync_status: string };
  };
}

let dbPromise: Promise<IDBPDatabase<any>> | null = null;

function getDB() {
  if (typeof window === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion) {
        // Version 1 stores
        if (oldVersion < 1) {
          const submissionsStore = db.createObjectStore('submissions', {
            keyPath: 'id',
            autoIncrement: false
          });
          submissionsStore.createIndex('status', 'status');
          submissionsStore.createIndex('zone', 'zone');
          submissionsStore.createIndex('submittedAt', 'submittedAt');
          submissionsStore.createIndex('plant_id', 'plant_id');

          db.createObjectStore('plant_gps', {
            keyPath: 'plant_id'
          });

          db.createObjectStore('mortality_reports', {
            keyPath: 'id',
            autoIncrement: false
          });

          db.createObjectStore('settings', {
            keyPath: 'key'
          });
        }

        // Version 2 stores (Plants, Plant Locations, Inspections)
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('plants')) {
            const plantsStore = db.createObjectStore('plants', { keyPath: 'plant_id' });
            plantsStore.createIndex('sync_status', 'sync_status');
          }
          if (!db.objectStoreNames.contains('plant_locations')) {
            const locStore = db.createObjectStore('plant_locations', { keyPath: 'plant_id' });
            locStore.createIndex('sync_status', 'sync_status');
          }
          if (!db.objectStoreNames.contains('inspections')) {
            const inspStore = db.createObjectStore('inspections', { keyPath: 'id' });
            inspStore.createIndex('sync_status', 'sync_status');
            inspStore.createIndex('plant_id', 'plant_id');
          }
        }

        // Version 3 stores (Slots)
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('slots')) {
            const slotsStore = db.createObjectStore('slots', { keyPath: 'slot_id' });
            slotsStore.createIndex('sync_status', 'sync_status');
          }
        }
      },
    });
  }
  return dbPromise;
}

// Submissions functions (Backward Compatibility)
export async function saveSubmissionOffline(submission: any): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('submissions', submission);
}

export async function getSubmission(id: string): Promise<any> {
  const db = await getDB();
  if (!db) return null;
  return db.get('submissions', id);
}

export async function getSubmissions(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('submissions');
}

export async function getPendingSubmissions(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAllFromIndex('submissions', 'status', 'pending');
}

export async function getPendingCount(): Promise<number> {
  const db = await getDB();
  if (!db) return 0;
  const pendingSubmissions = await getPendingSubmissions();
  const pendingPlants = await getPendingPlants();
  const pendingInspections = await getPendingInspections();
  const pendingSlots = await getPendingSlots();
  
  return pendingSubmissions.length + pendingPlants.length + pendingInspections.length + pendingSlots.length;
}

export async function markAsSyncedInDB(id: string, photoUrl?: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const submission = await db.get('submissions', id);
  if (submission) {
    submission.status = 'synced';
    submission.sync_status = 'synced';
    if (photoUrl) {
      submission.photo_url = photoUrl;
    }
    submission.synced_at = new Date().toISOString();
    await db.put('submissions', submission);
  }
}

export async function getPreviousHeight(plantId: string): Promise<number | null> {
  const db = await getDB();
  if (!db) return null;
  
  // Try new inspections table first
  const newInspections = await db.getAllFromIndex('inspections', 'plant_id', plantId);
  if (newInspections.length > 0) {
    const sorted = newInspections.sort((a, b) => new Date(b.inspection_date || b.created_at).getTime() - new Date(a.inspection_date || a.created_at).getTime());
    return sorted[0].vine_height_cm || null;
  }
  
  // Fallback to legacy submissions table
  const submissions = await db.getAllFromIndex('submissions', 'plant_id', plantId);
  if (submissions.length === 0) return null;
  const sorted = submissions.sort((a, b) => new Date(b.submitted_at || b.created_at).getTime() - new Date(a.submitted_at || a.created_at).getTime());
  return sorted[0].vine_height_cm || null;
}

// GPS functions (Backward Compatibility)
export async function savePlantGPS(plantId: string, lat: number, lng: number): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('plant_gps', { plant_id: plantId, lat, lng });
}

export async function getPlantGPS(plantId: string): Promise<{ lat: number; lng: number } | null> {
  const db = await getDB();
  if (!db) return null;
  
  const plant = await db.get('plants', plantId);
  if (plant && plant.slot_id) {
    const slot = await db.get('slots', plant.slot_id);
    if (slot && slot.latitude !== undefined && slot.longitude !== undefined) {
      return { lat: Number(slot.latitude), lng: Number(slot.longitude) };
    }
  }
  
  const record = await db.get('plant_gps', plantId);
  return record ? { lat: record.lat, lng: record.lng } : null;
}

export async function getAllPlantGPS(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('plant_gps');
}

// ----------------- NEW ENTITY DB OPERATIONS -----------------

// Slots Store
export async function saveSlotOffline(slot: any): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('slots', slot);
}

export async function getSlot(slotId: string): Promise<any | null> {
  const db = await getDB();
  if (!db) return null;
  return db.get('slots', slotId);
}

export async function getSlots(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('slots');
}

export async function getPendingSlots(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAllFromIndex('slots', 'sync_status', 'pending');
}

export async function markSlotAsSynced(slotId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const slot = await db.get('slots', slotId);
  if (slot) {
    slot.sync_status = 'synced';
    await db.put('slots', slot);
  }
}

export async function registerReplacement(slotId: string, newPlantData: any): Promise<string> {
  const db = await getDB();
  if (!db) throw new Error('IndexedDB not initialized');

  const tx = db.transaction(['slots', 'plants'], 'readwrite');
  const slotsStore = tx.objectStore('slots');
  const plantsStore = tx.objectStore('plants');

  // 1. Read the slot and its current active plant
  const slot = await slotsStore.get(slotId);
  if (!slot) throw new Error(`Slot with ID ${slotId} not found`);

  const oldPlantId = slot.active_plant_id || slot.activePlantId;
  let oldPlant: any = null;
  if (oldPlantId) {
    oldPlant = await plantsStore.get(oldPlantId);
  }

  // 2. Generate a new plant ID using the understandable slot_id and generation format
  const nextGen = (oldPlant?.generation || 0) + 1;
  const newPlantId = `${slotId}-G${nextGen}`;

  // 3. Create the NEW plant
  const newPlant = {
    plant_id: newPlantId,
    slot_id: slotId,
    variety: newPlantData.variety || oldPlant?.variety || 'Vanilla planifolia',
    plant_type: newPlantData.plant_type || oldPlant?.plant_type || 'Cutting',
    planting_arrangement: newPlantData.planting_arrangement || oldPlant?.planting_arrangement || 'Contour Pattern',
    spacing_between_hedges: newPlantData.spacing_between_hedges || oldPlant?.spacing_between_hedges || '1.5 m x 1.5 m',
    spacing_between_rows: newPlantData.spacing_between_rows || oldPlant?.spacing_between_rows || '1.5 m x 1.5 m',
    land_type: newPlantData.land_type || oldPlant?.land_type || 'Forest Land',
    agricultural_land_type: newPlantData.agricultural_land_type || oldPlant?.agricultural_land_type || 'Arable Crop Land',
    landform_type: newPlantData.landform_type || oldPlant?.landform_type || 'Upland Hillslope',
    support_tree_type: newPlantData.support_tree_type || oldPlant?.support_tree_type || 'Glyricidia',
    planted_date: newPlantData.planted_date || new Date().toISOString().split('T')[0],
    status: 'active',
    generation: (oldPlant?.generation || 0) + 1,
    previous_plant_id: oldPlantId || null,
    replaced_by_plant_id: null,
    retired_date: null,
    created_at: new Date().toISOString(),
    sync_status: 'pending'
  };

  // 4. Update the OLD plant if exists
  if (oldPlantId && oldPlant) {
    oldPlant.status = 'replaced';
    oldPlant.retired_date = new Date().toISOString().split('T')[0];
    oldPlant.replaced_by_plant_id = newPlantId;
    oldPlant.sync_status = 'pending';
    await plantsStore.put(oldPlant);
  }

  // 5. Update the slot
  slot.active_plant_id = newPlantId;
  slot.sync_status = 'pending';

  await plantsStore.put(newPlant);
  await slotsStore.put(slot);

  await tx.done;
  return newPlantId;
}

// Plants Store
export async function savePlantOffline(plant: any): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('plants', plant);
}

export async function getPlant(plantId: string): Promise<any | null> {
  const db = await getDB();
  if (!db) return null;
  return db.get('plants', plantId);
}

export async function getPlants(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('plants');
}

export async function getPendingPlants(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAllFromIndex('plants', 'sync_status', 'pending');
}

export async function markPlantAsSynced(plantId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const plant = await db.get('plants', plantId);
  if (plant) {
    plant.sync_status = 'synced';
    await db.put('plants', plant);
  }
}



// Inspections Store
export async function saveInspectionOffline(inspection: any): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('inspections', inspection);
}

export async function getInspection(id: string): Promise<any | null> {
  const db = await getDB();
  if (!db) return null;
  return db.get('inspections', id);
}

export async function getInspections(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('inspections');
}

export async function getPendingInspections(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAllFromIndex('inspections', 'sync_status', 'pending');
}

export async function markInspectionAsSynced(id: string, photoUrl?: string, meterPhotoUrl?: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const insp = await db.get('inspections', id);
  if (insp) {
    insp.sync_status = 'synced';
    if (photoUrl) {
      insp.photo_url = photoUrl;
    }
    if (meterPhotoUrl) {
      if (!insp.reading_source) insp.reading_source = {};
      insp.reading_source.meter_photo_url = meterPhotoUrl;
    }
    await db.put('inspections', insp);
  }
}

// Mortality reports functions
export async function saveMortalityReport(report: any): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('mortality_reports', report);
}

export async function getMortalityReports(): Promise<any[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('mortality_reports');
}

export async function getMortalityStats(): Promise<{ deadVines: number; deadTrees: number }> {
  const reports = await getMortalityReports();
  return reports.reduce(
    (acc, curr) => {
      acc.deadVines += curr.dead_vines || 0;
      acc.deadTrees += curr.dead_support_trees || 0;
      return acc;
    },
    { deadVines: 0, deadTrees: 0 }
  );
}

// Settings functions
export async function saveSetting(key: string, value: any): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('settings', { key, value });
}

export async function getSetting(key: string): Promise<any> {
  const db = await getDB();
  if (!db) return null;
  const record = await db.get('settings', key);
  return record ? record.value : null;
}

// Database stats counters
export async function getSubmissionsCount(): Promise<number> {
  const db = await getDB();
  if (!db) return 0;
  const legacyCount = await db.count('submissions');
  const inspCount = await db.count('inspections');
  return legacyCount + inspCount;
}

export async function getMortalityCount(): Promise<number> {
  const db = await getDB();
  if (!db) return 0;
  return db.count('mortality_reports');
}

export async function deleteSubmission(id: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.delete('submissions', id);
}

export async function deleteInspection(id: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.delete('inspections', id);
}

// Clear all database tables
export async function clearAllTables(): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const tx = db.transaction(['submissions', 'mortality_reports', 'plant_gps', 'settings', 'plants', 'plant_locations', 'inspections', 'slots'], 'readwrite');
  await Promise.all([
    tx.objectStore('submissions').clear(),
    tx.objectStore('mortality_reports').clear(),
    tx.objectStore('plant_gps').clear(),
    tx.objectStore('settings').clear(),
    tx.objectStore('plants').clear(),
    tx.objectStore('plant_locations').clear(),
    tx.objectStore('inspections').clear(),
    tx.objectStore('slots').clear(),
    tx.done
  ]);
}

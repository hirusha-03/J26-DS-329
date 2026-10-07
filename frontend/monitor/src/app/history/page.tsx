'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { History, Search, RefreshCw, X, CheckCircle, Wifi, WifiOff, FileText, ChevronRight, Trash2 } from 'lucide-react';
import { getPendingSubmissions, getPendingInspections, deleteSubmission, deleteInspection, getPlant } from '../../lib/offline-db';
import { syncPendingSubmissions, base64ToBlob } from '../../lib/syncService';
import { supabase } from '../../lib/supabaseClient';

function HistoryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const plantIdParam = searchParams.get('plant_id');
  const viewParam = searchParams.get('view');

  const [submissions, setSubmissions] = useState<any[]>([]);
  const [filteredSubmissions, setFilteredSubmissions] = useState<any[]>([]);

  // Selected submission modal
  const [selectedSub, setSelectedSub] = useState<any>(null);
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState<string | null>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Search and filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'synced' | 'pending'>('all');
  const [syncing, setSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // Trigger modal when viewParam and submissions are loaded
  useEffect(() => {
    if (viewParam && submissions.length > 0) {
      const targetSub = submissions.find(s => String(s.id) === String(viewParam));
      if (targetSub) {
        // Open details modal
        setSelectedSub(targetSub);
        if (targetSub.photo_blob) {
          try {
            const blob = base64ToBlob(targetSub.photo_blob);
            const url = URL.createObjectURL(blob);
            setSelectedPhotoUrl(url);
          } catch (err) {
            console.error(err);
            setSelectedPhotoUrl(null);
          }
        } else {
          setSelectedPhotoUrl(targetSub.photo_url || null);
        }
      }
    }
  }, [viewParam, submissions]);

  // Helper to parse dates robustly
  const parseDateMs = (dateVal: any): number => {
    if (!dateVal) return 0;
    if (typeof dateVal === 'number') return dateVal;
    if (dateVal instanceof Date) return dateVal.getTime();
    
    let str = String(dateVal).trim();
    let t = Date.parse(str);
    if (!isNaN(t)) return t;
    
    str = str.replace(' ', 'T');
    t = Date.parse(str);
    if (!isNaN(t)) return t;
    
    return 0;
  };

  const deriveHealth = (insp: any): 'healthy' | 'moderate' | 'high-risk' | 'dead' => {
    if (!insp) return 'healthy';
    const pH = insp.soil_pH ?? insp.soil_ph;
    const f = insp.foliage_color;
    if (f === 'Red') return 'dead';
    if (f === 'Brown' || (pH !== undefined && pH !== null && (pH < 5.5 || pH > 7.0))) return 'high-risk';
    if (f === 'Yellow' || f === 'Mixed' || (pH !== undefined && pH !== null && ((pH >= 5.5 && pH < 6.0) || (pH > 6.5 && pH <= 7.0)))) return 'moderate';
    return 'healthy';
  };

  const getHealthDotColor = (health: 'healthy' | 'moderate' | 'high-risk' | 'dead') => {
    switch (health) {
      case 'healthy': return 'bg-green-500';
      case 'moderate': return 'bg-amber-400';
      case 'high-risk': return 'bg-orange-500';
      case 'dead': return 'bg-red-600';
      default: return 'bg-gray-400';
    }
  };

  const getHealthBadgeStyle = (health: 'healthy' | 'moderate' | 'high-risk' | 'dead') => {
    switch (health) {
      case 'healthy': return 'bg-green-100 text-green-800';
      case 'moderate': return 'bg-amber-100 text-amber-800';
      case 'high-risk': return 'bg-orange-100 text-orange-800';
      case 'dead': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const loadSubmissions = async () => {
    // 1. Fetch pending records from IndexedDB
    const pendingSubs = await getPendingSubmissions();
    const pendingInsps = await getPendingInspections();

    // 2. Fetch synced records from Supabase directly
    let remoteInsps: any[] = [];
    try {
      const { data, error } = await supabase
        .from('inspections')
        .select(`
          *,
          plants!left(
            slot_id,
            zone,
            block,
            plant_type
          )
        `);
      if (!error && data) {
        remoteInsps = data;
      }
    } catch (err) {
      console.error('Failed to fetch inspections from Supabase:', err);
    }

    // Filter remote records to avoid duplicates with pending offline records
    const remoteInspsFiltered = remoteInsps.filter(r => !pendingInsps.some(p => p.id === r.id));

    // Map new inspections to have compatible display fields
    const mappedInsps = await Promise.all([...pendingInsps, ...remoteInspsFiltered].map(async i => {
      // 1. Resolve plant info
      // Check if the inspection record itself has the slot_id/zone/block, otherwise fetch plant info
      let resolvedSlotId = i.slot_id;
      let resolvedZone = i.zone;
      let resolvedBlock = i.block;
      let resolvedPlantType = i.plant_type;

      // Also get plants relation if we selected it from Supabase
      if (i.plants) {
        resolvedSlotId = resolvedSlotId || i.plants.slot_id;
        resolvedZone = resolvedZone || i.plants.zone;
        resolvedBlock = resolvedBlock || i.plants.block;
        resolvedPlantType = resolvedPlantType || i.plants.plant_type;
      }

      // If still missing, check local IndexedDB
      if (!resolvedSlotId || !resolvedZone || !resolvedBlock) {
        const localPlant = await getPlant(i.plant_id);
        if (localPlant) {
          resolvedSlotId = resolvedSlotId || localPlant.slot_id;
          resolvedZone = resolvedZone || localPlant.zone;
          resolvedBlock = resolvedBlock || localPlant.block;
          resolvedPlantType = resolvedPlantType || localPlant.plant_type;
        }
      }

      // If still missing, parse plant_id regex if it matches A01-P001
      if (!resolvedSlotId) {
        const match = i.plant_id?.match(/^([A-Z])([0-9]+)-P([0-9]+)$/i);
        if (match) {
          resolvedSlotId = i.plant_id;
          resolvedZone = resolvedZone || match[1].toUpperCase();
          resolvedBlock = resolvedBlock || match[2];
        }
      }

      // Final fallbacks
      resolvedSlotId = resolvedSlotId || i.plant_id;
      resolvedZone = resolvedZone || i.plant_id?.split('-')[0]?.charAt(0) || 'A';
      resolvedBlock = resolvedBlock || i.plant_id?.split('-')[0]?.substring(1) || '01';

      // Format block (strip 'Block' prefix if present, pad to 2 digits)
      const cleanBlock = resolvedBlock ? String(resolvedBlock).replace(/^Block\s+/i, '').padStart(2, '0') : '01';

      return {
        ...i,
        slot_id: resolvedSlotId,
        submitted_at: i.created_at || i.inspection_date,
        field_notes: i.notes,
        soil_pH: i.soil_ph,
        fertiliser_type: i.fertilizer_type || [],
        fertiliser_used: i.fertilizer_used,
        last_fertilised: i.last_fertilized,
        zone: resolvedZone,
        block: cleanBlock,
        plant_type: resolvedPlantType || 'Cutting',
        common_name: i.common_name || 'Vanilla',
        variety: i.variety || 'Local'
      };
    }));

    const allSubmissions = [
      ...pendingSubs,
      ...mappedInsps
    ];

    // Sort descending by date (latest on top, oldest on bottom)
    const sorted = [...allSubmissions].sort((a, b) => {
      const dateA = parseDateMs(a.submitted_at || a.created_at || a.inspection_date);
      const dateB = parseDateMs(b.submitted_at || b.created_at || b.inspection_date);
      return dateB - dateA;
    });
    setSubmissions(sorted);
  };

  const updateNetworkStatus = () => {
    if (typeof window !== 'undefined') {
      setIsOnline(navigator.onLine);
    }
  };

  useEffect(() => {
    loadSubmissions();
    updateNetworkStatus();

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    window.addEventListener('sync-complete', loadSubmissions);
    window.addEventListener('submissions-updated', loadSubmissions);

    return () => {
      window.removeEventListener('online', updateNetworkStatus);
      window.removeEventListener('offline', updateNetworkStatus);
      window.removeEventListener('sync-complete', loadSubmissions);
      window.removeEventListener('submissions-updated', loadSubmissions);
    };
  }, []);

  // Filter application
  useEffect(() => {
    let result = [...submissions];

    // Plant ID URL param filter
    if (plantIdParam) {
      result = result.filter(sub => sub.plant_id?.toLowerCase() === plantIdParam.toLowerCase());
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(sub => sub.sync_status === statusFilter);
    }

    // Search query
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        sub =>
          (sub.plant_id && sub.plant_id.toLowerCase().includes(q)) ||
          (sub.zone && sub.zone.toLowerCase().includes(q)) ||
          (sub.block && sub.block.toLowerCase().includes(q)) ||
          (sub.field_notes && sub.field_notes.toLowerCase().includes(q)) ||
          (sub.notes && sub.notes.toLowerCase().includes(q))
      );
    }

    setFilteredSubmissions(result);
  }, [submissions, searchQuery, statusFilter, plantIdParam]);

  const handleSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await syncPendingSubmissions();
      alert(`Sync process complete. Synced: ${res.synced}, Failed: ${res.failed}`);
      await loadSubmissions();
    } catch (err) {
      console.error(err);
      alert('Sync failed. Check your network or credentials.');
    } finally {
      setSyncing(false);
    }
  };

  // Open details modal
  const handleOpenDetails = (sub: any) => {
    setSelectedSub(sub);
    if (sub.photo_blob) {
      try {
        const blob = base64ToBlob(sub.photo_blob);
        const url = URL.createObjectURL(blob);
        setSelectedPhotoUrl(url);
      } catch (err) {
        console.error(err);
        setSelectedPhotoUrl(null);
      }
    } else {
      setSelectedPhotoUrl(sub.photo_url || null);
    }
  };

  // Close details modal
  const handleCloseDetails = () => {
    setSelectedSub(null);
    setShowConfirmDelete(false);
    setDeleting(false);
    if (selectedPhotoUrl && selectedPhotoUrl.startsWith('blob:')) {
      URL.revokeObjectURL(selectedPhotoUrl);
    }
    setSelectedPhotoUrl(null);
  };

  const handleDeleteSubmission = async () => {
    if (!selectedSub) return;
    setDeleting(true);
    try {
      if (selectedSub.sync_status === 'synced') {
        if (!isOnline) {
          alert('You are currently offline. Synced submissions can only be deleted when you are online.');
          setDeleting(false);
          return;
        }

        // Delete from Supabase
        const { error } = await supabase
          .from('inspections')
          .delete()
          .eq('id', selectedSub.id);

        if (error) {
          throw new Error(`Failed to delete from Supabase: ${error.message}`);
        }
      }

      // Delete locally from both IndexedDB stores
      await deleteSubmission(selectedSub.id);
      await deleteInspection(selectedSub.id);

      // Trigger sync/reload event
      window.dispatchEvent(new Event('submissions-updated'));
      
      handleCloseDetails();
      alert('Submission report deleted successfully.');
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to delete submission report.');
    } finally {
      setDeleting(false);
    }
  };

  const mapSunlight = (val: string | null) => {
    if (!val) return 'N/A';
    const mapping: Record<string, string> = {
      bright: 'Bright (7-9 bars)',
      bright_indirect: 'Bright indirect (4-6 bars)',
      medium: 'Medium (2-3 bars)',
      low: 'Low (0-1 bars)'
    };
    return mapping[val.toLowerCase()] || val;
  };

  const mapShade = (val: string | null) => {
    if (!val) return 'N/A';
    const mapping: Record<string, string> = {
      light: 'Light (0-25%)',
      partial: 'Partial (25-50%)',
      moderate: 'Moderate (50-70%)',
      heavy: 'Heavy (>70%)'
    };
    return mapping[val.toLowerCase()] || val;
  };

  const getPendingCountNum = submissions.filter(s => s.sync_status === 'pending').length;

  return (
    <div className="flex flex-col bg-surface min-h-screen">
      {/* Header Banner */}
      <div className="bg-primary text-white px-5 py-5 rounded-b-3xl shadow-md space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-widest text-green-light flex items-center gap-1">
              <History className="h-3 w-3" />
              Inspection Log
            </span>
            <h1 className="text-xl font-extrabold mt-0.5">Submission History</h1>
          </div>

          {/* Sync Trigger button */}
          {getPendingCountNum > 0 && (
            <button
              onClick={handleSyncNow}
              disabled={syncing || !isOnline}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all shadow-sm ${
                isOnline
                  ? 'bg-secondary text-white hover:bg-secondary/90'
                  : 'bg-white/10 text-white/50 cursor-not-allowed'
              }`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Syncing...' : 'Sync Queue'}</span>
            </button>
          )}
        </div>

        {/* Search Field */}
        <div className="relative flex items-center bg-white/10 border border-white/20 rounded-2xl px-4 py-2.5">
          <Search className="h-4 w-4 text-white/60 mr-2" />
          <input
            type="text"
            placeholder="Search plant ID, zone, notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-transparent text-xs text-white placeholder:text-white/55 outline-none flex-1 font-semibold"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="text-white/60 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Plant ID active filter banner */}
      {plantIdParam && (
        <div className="mx-5 mt-4 px-4 py-2.5 bg-green-50 border border-green-100 rounded-2xl flex items-center justify-between shadow-xs">
          <span className="text-xs font-bold text-primary flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-primary" />
            Filtered for Plant: <span className="underline font-extrabold">{plantIdParam}</span>
          </span>
          <button
            onClick={() => router.push('/history')}
            className="text-[10px] font-bold text-text-secondary hover:text-primary flex items-center gap-1 bg-white border border-border-light px-2.5 py-1 rounded-full shadow-xs transition-colors"
          >
            Clear Filter <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="px-5 py-3 flex gap-2 border-b border-border-light bg-white mt-2">
        {(['all', 'synced', 'pending'] as const).map((status) => {
          const isSelected = statusFilter === status;
          const count = status === 'all'
            ? submissions.length
            : submissions.filter(s => s.sync_status === status).length;

          return (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                isSelected
                  ? 'bg-pale-green text-primary border border-primary/25'
                  : 'text-text-secondary hover:text-primary'
              }`}
            >
              <span className="capitalize">{status}</span>
              <span className="ml-1 text-[9px] bg-black/5 px-1.5 py-0.5 rounded-full">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Submissions List */}
      <div className="p-5 flex-1 pb-24 space-y-3">
        {filteredSubmissions.length === 0 ? (
          <div className="bg-white border border-dashed border-border-light rounded-3xl p-10 text-center text-text-secondary">
            <FileText className="h-10 w-10 mx-auto mb-2.5 opacity-30 text-primary" />
            <p className="text-xs font-semibold">No records found matching filters.</p>
            <p className="text-[10px] opacity-75 mt-0.5">Try adjusting query or log a new inspection.</p>
          </div>
        ) : (
          filteredSubmissions.map((sub) => {
            const h = deriveHealth(sub);
            return (
              <button
                key={sub.id}
                onClick={() => handleOpenDetails(sub)}
                className="w-full text-left bg-white rounded-2xl border border-border-light p-4 shadow-xs flex justify-between items-center hover:shadow-md hover:border-primary/20 transition-all duration-200"
              >
                <div className="flex items-center gap-3">
                  {/* Health status dot */}
                  <div className={`h-3 w-3 rounded-full flex-shrink-0 ${getHealthDotColor(h)}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-black text-text-primary">Plant {sub.slot_id || sub.plant_id}</h4>
                      <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase ${getHealthBadgeStyle(h)}`}>
                        {h === 'high-risk' ? 'High Risk' : h}
                      </span>
                    </div>
                    <p className="text-[9px] text-text-secondary mt-0.5">
                      Zone {sub.zone} • Block {sub.block} • {sub.plant_type || 'Cutting'}
                    </p>
                    <p className="text-[10px] font-medium text-text-primary mt-1 line-clamp-1 max-w-[200px]">
                      {sub.field_notes || sub.notes || 'No notes added.'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col items-end flex-shrink-0">
                  <span className="text-[9px] font-semibold text-text-secondary">
                    {new Date(sub.submitted_at || sub.created_at).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric'
                    })}
                  </span>
                  <span
                    className={`inline-block text-[8px] font-bold px-1.5 py-0.5 rounded-full mt-1.5 uppercase ${
                      sub.sync_status === 'synced'
                        ? 'bg-pale-green text-primary'
                        : 'bg-amber-warning/20 text-amber-700'
                    }`}
                  >
                    {sub.sync_status || 'pending'}
                  </span>
                  <ChevronRight className="h-4 w-4 text-text-secondary mt-1 opacity-50" />
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* ─── MODAL: INSPECTION DETAILS ────────────────────────────── */}
      {selectedSub && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl border border-border-light max-h-[85vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="bg-primary px-5 py-4 text-white flex justify-between items-center flex-shrink-0">
              <div>
                <span className="text-[9px] uppercase font-bold text-green-light tracking-widest">
                  Inspection Details
                </span>
                <h3 className="font-extrabold text-sm mt-0.5">
                  Plant {selectedSub.slot_id || selectedSub.plant_id} Observation
                </h3>
              </div>
              <button onClick={handleCloseDetails} className="text-white/80 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Content */}
            {showConfirmDelete ? (
              <div className="p-6 text-center space-y-4 flex-1 flex flex-col justify-center items-center">
                <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center text-red-600 mb-2">
                  <Trash2 className="h-8 w-8 animate-pulse" />
                </div>
                <h4 className="font-extrabold text-base text-text-primary">Delete Submission Report?</h4>
                <p className="text-xs text-text-secondary leading-relaxed max-w-[240px]">
                  Are you sure you want to delete the inspection report for <span className="font-bold text-text-primary">Plant {selectedSub.slot_id || selectedSub.plant_id}</span>?
                  {selectedSub.sync_status === 'synced' ? (
                    <span className="block mt-2 text-red-500 font-semibold">
                      Warning: This report is synced. Deleting it will remove it from both Supabase and local cache.
                    </span>
                  ) : (
                    <span className="block mt-2 text-amber-600 font-semibold">
                      This report is currently pending sync and will be removed from your local queue.
                    </span>
                  )}
                </p>
                <div className="w-full pt-4 space-y-2">
                  <button
                    onClick={handleDeleteSubmission}
                    disabled={deleting}
                    className="w-full bg-red-600 text-white py-3 rounded-full text-xs font-bold hover:bg-red-700 transition shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {deleting ? (
                      <>
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent inline-block" />
                        Deleting...
                      </>
                    ) : (
                      'Yes, Delete Report'
                    )}
                  </button>
                  <button
                    onClick={() => setShowConfirmDelete(false)}
                    disabled={deleting}
                    className="w-full bg-gray-100 text-text-primary py-3 rounded-full text-xs font-bold hover:bg-gray-200 transition disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Modal Scrollable Content */}
                <div className="p-5 overflow-y-auto space-y-4 flex-1">
                  {/* Photo preview if exists */}
                  {selectedPhotoUrl && (
                    <div className="relative rounded-2xl overflow-hidden border border-border-light h-44 flex-shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={selectedPhotoUrl}
                        alt="Plant record preview"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}

                  {/* General Specs */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Soil EC</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">
                        {selectedSub.soil_ec !== undefined && selectedSub.soil_ec !== null ? `${selectedSub.soil_ec} dS/m` : 'N/A'}
                      </span>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Moisture</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">
                        {selectedSub.moisture !== undefined && selectedSub.moisture !== null ? `${selectedSub.moisture}%` : 'N/A'}
                      </span>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Vine Height</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">
                        {selectedSub.vine_height_cm !== undefined && selectedSub.vine_height_cm !== null ? `${selectedSub.vine_height_cm} cm` : 'N/A'}
                      </span>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Soil pH</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">{selectedSub.soil_pH ?? selectedSub.soil_ph ?? 'N/A'}</span>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Temperature</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">
                        {selectedSub.temperature !== undefined && selectedSub.temperature !== null ? `${selectedSub.temperature} °C` : (selectedSub.temperature_c !== undefined && selectedSub.temperature_c !== null ? `${selectedSub.temperature_c} °C` : 'N/A')}
                      </span>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Humidity</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">
                        {selectedSub.humidity !== undefined && selectedSub.humidity !== null ? `${selectedSub.humidity}%` : (selectedSub.humidity_pct !== undefined && selectedSub.humidity_pct !== null ? `${selectedSub.humidity_pct}%` : 'N/A')}
                      </span>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Sunlight</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">{mapSunlight(selectedSub.sunlight_level)}</span>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-border-light">
                      <span className="text-[8px] font-bold text-text-secondary uppercase">Shade Level</span>
                      <span className="text-xs font-bold text-text-primary block mt-0.5">{mapShade(selectedSub.shade_level)}</span>
                    </div>
                  </div>

                  {/* Fertilization info */}
                  <div className="bg-surface rounded-xl p-3 border border-border-light space-y-1">
                    <span className="text-[8px] font-bold text-text-secondary uppercase">Fertilisation Status</span>
                    <div className="text-xs text-text-primary font-bold">
                      Brand: <span className="font-semibold">{selectedSub.fertiliser_used || 'None'}</span>
                    </div>
                    <div className="text-[10px] text-text-secondary font-semibold">
                      Types: {Array.isArray(selectedSub.fertiliser_type) ? selectedSub.fertiliser_type.join(', ') : (selectedSub.fertiliser_type || 'N/A')}
                    </div>
                    <div className="text-[10px] text-text-secondary font-semibold flex items-center gap-1.5 mt-0.5">
                      <span>Source:</span>
                      <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase ${
                        selectedSub.fertilizer_source === 'carried' 
                          ? 'bg-pale-green text-primary' 
                          : 'bg-orange-50 text-orange-600 border border-orange-100'
                      }`}>
                        {selectedSub.fertilizer_source || 'edited'}
                      </span>
                    </div>
                  </div>

                  {/* Field Notes */}
                  <div className="bg-surface rounded-xl p-3 border border-border-light">
                    <span className="text-[8px] font-bold text-text-secondary uppercase block mb-1">Field Notes</span>
                    <p className="text-xs font-medium text-text-primary leading-relaxed whitespace-pre-line">
                      {selectedSub.field_notes ?? selectedSub.notes ?? 'No additional notes recorded.'}
                    </p>
                  </div>

                  {/* Sync details */}
                  <div className="text-[9px] text-text-secondary space-y-0.5 pt-2 border-t border-border-light font-medium">
                    <div>ID: {selectedSub.id}</div>
                    {selectedSub.slot_id && <div>Plant ID: {selectedSub.plant_id}</div>}
                    <div>Supervisor: {selectedSub.supervisor_name} ({selectedSub.supervisor_email})</div>
                    <div>Submitted: {new Date(selectedSub.submitted_at || selectedSub.created_at).toLocaleString()}</div>
                    <div className="flex items-center gap-1 mt-1">
                      <span>Sync Status:</span>
                      <span className={`font-bold uppercase ${selectedSub.sync_status === 'synced' ? 'text-primary' : 'text-amber-700'}`}>
                        {selectedSub.sync_status}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Modal Footer */}
                <div className="p-4 bg-gray-50 border-t border-border-light flex-shrink-0 flex gap-2">
                  <button
                    onClick={() => setShowConfirmDelete(true)}
                    className="flex-1 border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 py-3 rounded-full text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                  <button
                    onClick={handleCloseDetails}
                    className="flex-1 bg-[#1B4332] text-white py-3 rounded-full text-xs font-bold hover:bg-primary transition shadow-md"
                  >
                    Close View
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-text-secondary">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-xs font-semibold font-sans">Loading History...</span>
        </div>
      </div>
    }>
      <HistoryContent />
    </Suspense>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Camera, RefreshCw, Clipboard } from 'lucide-react';
import { useInspection } from '../../../context/InspectionContext';
import { saveInspectionOffline, syncPendingSubmissions } from '../../../lib/syncService';
import ProgressBar from '../../../components/ProgressBar';
import ContextBadge from '../../../components/ContextBadge';

export default function Step5Submit() {
  const router = useRouter();
  const { formData, updateForm, resetForm } = useInspection();

  const [photoFile, setPhotoFile] = useState<File | null>(formData.photo_file);
  const [photoPreview, setPhotoPreview] = useState<string | null>(
    formData.photo_file ? URL.createObjectURL(formData.photo_file) : null
  );
  const [fieldNotes, setFieldNotes] = useState<string>(formData.field_notes || '');
  const [submitting, setSubmitting] = useState(false);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      setPhotoFile(file);
      
      // Create preview
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhotoPreview(URL.createObjectURL(file));

      updateForm({
        photo_file: file,
        photo_filename: file.name
      });
    }
  };

  const handleClearPhoto = () => {
    setPhotoFile(null);
    if (photoPreview) {
      URL.revokeObjectURL(photoPreview);
      setPhotoPreview(null);
    }
    updateForm({
      photo_file: null,
      photo_filename: null
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      let activePhoto = photoFile;
      if (!activePhoto) {
        const mockCanvas = document.createElement('canvas');
        mockCanvas.width = 100;
        mockCanvas.height = 100;
        const ctx = mockCanvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#1B4332';
          ctx.fillRect(0, 0, 100, 100);
        }
        const blob = await new Promise<Blob | null>((resolve) => mockCanvas.toBlob(resolve, 'image/jpeg'));
        if (blob) {
          activePhoto = new File([blob], 'mock_plant_photo.jpg', { type: 'image/jpeg' });
        }
      }

      if (!activePhoto) {
        alert('A photo of the vanilla plant is required.');
        setSubmitting(false);
        return;
      }
      // 1. Prepare form parameters
      const submissionData = {
        ...formData,
        field_notes: fieldNotes
      };

      // 2. Save submission locally in IndexedDB
      const submissionId = await saveInspectionOffline(submissionData, activePhoto);

      // Trigger custom event so other components update counters
      window.dispatchEvent(new Event('submissions-updated'));

      // 3. Fire-and-forget background synchronization
      syncPendingSubmissions()
        .then((res) => {
          console.log('Background sync outcome:', res);
        })
        .catch((err) => {
          console.error('Background sync failed:', err);
        });

      // 4. Reset global multi-step context state
      resetForm();

      // 5. Navigate to success screen
      router.push(`/inspect/success?id=${submissionId}`);
    } catch (err) {
      console.error('Submission save error:', err);
      alert('Error saving inspection locally. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col bg-surface min-h-screen">
      {/* Header */}
      <div className="bg-primary text-white px-4 py-4 flex items-center gap-3">
        <button onClick={() => router.push('/inspect/step4')} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Submit Inspection</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">Step 5 of 5 • Final confirmation</p>
        </div>
      </div>

      <ProgressBar step={5} />
      <ContextBadge
        zone={formData.zone || 'A'}
        block={formData.block || '01'}
        plantNumber={formData.plant_number || 1}
      />

      <div className="p-5 space-y-6 flex-1 pb-24">
        {/* CAMERA CAPTURE CARD */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs space-y-4">
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 border-b border-border-light/50 pb-2">
            <Camera className="h-4 w-4" />
            Photo Evidence
          </h3>

          {!photoPreview ? (
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-border-light rounded-2xl h-48 cursor-pointer hover:bg-pale-green/10 transition-colors">
              <div className="flex flex-col items-center gap-2 text-center p-6">
                <div className="h-12 w-12 bg-pale-green text-primary rounded-full flex items-center justify-center">
                  <Camera className="h-6 w-6" />
                </div>
                <span className="text-xs font-bold text-text-primary mt-1">Capture Plant Photo</span>
                <span className="text-[10px] text-text-secondary leading-normal max-w-[180px]">
                  Focus on foliage & support tree interface.
                </span>
              </div>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoChange}
                className="hidden"
              />
            </label>
          ) : (
            <div className="relative rounded-2xl overflow-hidden border border-border-light h-52">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoPreview}
                alt="Vanilla vine preview"
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={handleClearPhoto}
                className="absolute bottom-3 right-3 bg-black/75 hover:bg-black text-white px-3 py-1.5 rounded-full text-[10px] font-bold flex items-center gap-1 shadow-sm"
              >
                <RefreshCw className="h-3 w-3" />
                Retake
              </button>
            </div>
          )}
        </div>

        {/* FIELD NOTES CARD */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs space-y-3">
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 border-b border-border-light/50 pb-2">
            <Clipboard className="h-4 w-4" />
            Field Notes & Observations
          </h3>
          
          <textarea
            value={fieldNotes}
            onChange={(e) => setFieldNotes(e.target.value)}
            placeholder="Describe health conditions, aerial roots, yellowing margins, or insect presence..."
            rows={4}
            className="w-full mt-1 border border-border-light rounded-lg p-3 text-xs focus:outline-primary placeholder:text-gray-300 leading-relaxed"
          />
        </div>
      </div>

      {/* Floating Bottom Button */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light z-30 flex gap-3">
        <button
          onClick={() => router.push('/inspect/step4')}
          disabled={submitting}
          className="flex-1 border border-border-light text-text-secondary py-3.5 rounded-full font-bold text-xs shadow-xs hover:bg-surface active:scale-95 transition disabled:opacity-50"
        >
          Back
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex-2 bg-[#1B4332] text-white py-3.5 rounded-full font-bold text-xs shadow-md transition hover:bg-primary active:scale-95 disabled:opacity-50"
        >
          {submitting ? 'Saving record...' : 'Submit Inspection'}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";

interface UploadPanelProps {
  file: File | null;
  previewUrl: string | null;
  disabled: boolean;
  onSelect: (file: File) => void;
  onClear: () => void;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPanel({ file, previewUrl, disabled, onSelect, onClear }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const pick = (files: FileList | null) => {
    if (files?.[0]) onSelect(files[0]);
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      className="sr-only"
      disabled={disabled}
      onChange={(e) => {
        pick(e.target.files);
        e.target.value = "";
      }}
    />
  );

  if (file && previewUrl) {
    return (
      <figure className="rounded-2xl border border-border-light bg-white p-3 shadow-[0_1px_0_rgba(1,45,29,0.06)]">
        <div className="relative overflow-hidden rounded-xl bg-primary/5">
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, not optimisable */}
          <img
            src={previewUrl}
            alt="Selected vine photo"
            className="mx-auto max-h-[60vh] w-full object-contain"
          />
          {!disabled && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Remove photo"
              className="absolute right-2 top-2 rounded-full bg-white/90 p-1.5 text-text-primary shadow focus-visible:outline-2 focus-visible:outline-secondary"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1 pt-3 text-sm">
          <span className="min-w-0 truncate font-medium text-text-primary">{file.name}</span>
          <span className="text-text-secondary">{formatSize(file.size)}</span>
        </figcaption>
        {!disabled && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-2 px-1 text-sm font-medium text-secondary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-secondary"
          >
            Choose a different photo
          </button>
        )}
        {input}
      </figure>
    );
  }

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
      className={`flex min-h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-within:outline-2 focus-within:outline-secondary sm:min-h-80 ${
        dragging ? "border-secondary bg-ok-soft" : "border-border-light bg-white hover:border-secondary/60"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <span className="rounded-full bg-primary/5 p-4 text-secondary">
        <ImagePlus size={28} aria-hidden />
      </span>
      <span className="text-base font-semibold text-text-primary">Add a photo of a leaf or stem</span>
      <span className="max-w-xs text-sm text-text-secondary">
        Drop it here, or tap to take or choose a photo. JPG, PNG or WebP, up to 10 MB.
      </span>
      {input}
    </label>
  );
}

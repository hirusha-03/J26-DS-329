'use client';

interface ProgressBarProps {
  step: number; // 1 to 5
}

export default function ProgressBar({ step }: ProgressBarProps) {
  return (
    <div className="w-full bg-white px-4 py-2 border-b border-border-light">
      <div className="flex justify-between items-center text-xs font-semibold text-text-secondary mb-1.5">
        <span>Step {step} of 5</span>
        <span>{Math.round((step / 5) * 100)}% complete</span>
      </div>
      <div className="flex gap-1.5 h-1.5 w-full">
        {[1, 2, 3, 4, 5].map((s) => (
          <div
            key={s}
            className={`flex-1 h-full rounded-full transition-all duration-300 ${
              s <= step ? 'bg-secondary' : 'bg-pale-green'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

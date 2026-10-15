import { ShieldAlert } from "lucide-react";
import type { ReviewState } from "@/lib/disease/types";

export default function ReviewBanner({ review }: { review: ReviewState }) {
  if (review.status !== "needs_review") return null;

  return (
    <div role="status" className="flex gap-3 rounded-xl border-l-4 border-warn bg-warn-soft p-4">
      <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-text-primary">Needs expert review</p>
        <p className="mt-1 text-text-secondary">
          The model isn&apos;t confident enough for this result to be acted on alone.
        </p>
        {review.reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-text-primary">
            {review.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

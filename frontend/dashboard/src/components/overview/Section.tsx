import type { ReactNode } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

export type Load<T> = { kind: "loading" } | { kind: "ok"; data: T } | { kind: "error"; message: string };

interface Props {
  id: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

export default function Section({ id, title, subtitle, action, className = "", children }: Props) {
  return (
    <section aria-labelledby={id} className={`min-w-0 rounded-xl border border-border-light bg-white p-4 sm:p-5 ${className}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold text-text-primary">{title}</h2>
          {subtitle && <p className="text-xs text-text-secondary sm:text-sm">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function SectionLoading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-text-secondary" role="status">
      <Loader2 size={16} className="animate-spin" aria-hidden /> {label}
    </p>
  );
}

export function SectionError({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-text-primary" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden /> {message}
    </p>
  );
}

export function SectionEmpty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-surface p-3 text-sm text-text-secondary">{children}</p>;
}

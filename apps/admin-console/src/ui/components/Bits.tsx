import type { ComponentChildren } from "preact";
import { Alert } from "./Alert";

/** A labelled value in a summary grid. */
export function KV({ label, children }: { label: string; children?: ComponentChildren }) {
  return (
    <div class="min-w-0">
      <dt class="text-xs font-medium text-muted">{label}</dt>
      <dd class="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

export function SummaryGrid({ children }: { children?: ComponentChildren }) {
  return <dl class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-6 gap-y-4">{children}</dl>;
}

export function Loading({ label = "Carregando…" }: { label?: string }) {
  return (
    <div role="status" class="flex items-center gap-3 p-6 text-muted">
      <span class="size-4 animate-spin rounded-full border-2 border-line border-t-primary" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorAlert({ message }: { message: string }) {
  return <Alert tone="bad">{message}</Alert>;
}

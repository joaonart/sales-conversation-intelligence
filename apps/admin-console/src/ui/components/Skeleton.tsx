import type { ComponentChildren } from "preact";
import { cx } from "../lib/cx";
import { Card } from "./Card";

/**
 * Placeholders for what is being fetched: the same shapes as the content (table rows, cards, a chart, a page), so the page does not jump when the
 * data arrives. They are decoration (`aria-hidden`); the region that holds them announces "Carregando…" once, for a screen reader.
 */

/** One block of a placeholder: a quiet pulsing bar or box. Size it with classes. */
export function Skeleton({ class: className }: { class?: string }) {
  return <div aria-hidden="true" class={cx("animate-pulse rounded bg-divider", className)} />;
}

/** The region of a placeholder: announced as busy, with the label only a screen reader reads. */
export function SkeletonRegion({ label = "Carregando…", class: className, children }: { label?: string; class?: string; children?: ComponentChildren }) {
  return (
    <div role="status" aria-busy="true" class={className}>
      <span class="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Widths that vary from cell to cell, so the rows look like text and not like a grid of identical bars. */
const CELL = ["w-24", "w-32", "w-16", "w-28", "w-20", "w-36"];

/** The rows of a table, under the real column headers (so the person already sees what is being loaded). */
export function TableSkeleton({ headers, rows = 6, label }: { headers: string[]; rows?: number; label?: string }) {
  return (
    <SkeletonRegion label={label} class="overflow-x-auto">
      <table class="w-full border-collapse text-left text-sm" aria-hidden="true">
        <thead>
          <tr class="border-b border-line">
            {headers.map((h) => (
              <th key={h} scope="col" class="px-4 py-2.5 text-xs font-medium tracking-wide text-muted uppercase">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} class="border-b border-divider last:border-0">
              {headers.map((h, c) => (
                <td key={h} class="px-4 py-3.5">
                  <Skeleton class={cx("h-3.5", CELL[(r + c * 2) % CELL.length])} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </SkeletonRegion>
  );
}

/** Lines of text (the last one shorter, like a paragraph). */
export function TextSkeleton({ lines = 3, class: className }: { lines?: number; class?: string }) {
  return (
    <div class={cx("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} class={cx("h-3.5", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** The row of figures at the top of the Painel. */
export function CardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div class="mb-4 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} class="rounded-card border border-line bg-surface p-4 shadow-card">
          <Skeleton class="h-3 w-24" />
          <Skeleton class="mt-3 h-8 w-20" />
          <Skeleton class="mt-2 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

/** A chart: a title bar and a big area. */
export function ChartSkeleton({ height = "h-64" }: { height?: string }) {
  return (
    <SkeletonRegion>
      <Skeleton class={cx("w-full", height)} />
    </SkeletonRegion>
  );
}

/** A list of cards (the rubrics): a row per item with a title and a line under it. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <SkeletonRegion class="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 shadow-card" aria-hidden="true">
          <Skeleton class="size-4" />
          <div class="flex flex-1 flex-col gap-2">
            <Skeleton class="h-4 w-48" />
            <Skeleton class="h-3 w-28" />
          </div>
          <Skeleton class="h-5 w-20 rounded-full" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** The page of a record (a run, a session, an event): figures, then a card of text. */
export function DetailSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <SkeletonRegion>
      <div class="mb-4 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3" aria-hidden="true">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} class="rounded-card border border-line bg-surface p-4 shadow-card">
            <Skeleton class="h-3 w-20" />
            <Skeleton class="mt-3 h-6 w-28" />
          </div>
        ))}
      </div>
      <Card>
        <Skeleton class="mb-4 h-4 w-40" />
        <TextSkeleton lines={5} />
      </Card>
    </SkeletonRegion>
  );
}

/** A whole page of the Painel while its numbers load. */
export function DashboardSkeleton() {
  return (
    <SkeletonRegion>
      <CardsSkeleton />
      <Card class="mb-4">
        <Skeleton class="mb-4 h-4 w-48" />
        <Skeleton class="h-64 w-full" />
      </Card>
      <Card>
        <Skeleton class="mb-4 h-4 w-40" />
        <TextSkeleton lines={4} />
      </Card>
    </SkeletonRegion>
  );
}

import { fmtInt } from "../lib/format";
import type { PagedList } from "../lib/usePagedList";
import { cx } from "../lib/cx";
import { Button, IconButton } from "./Button";

interface PagerProps {
  list: PagedList<unknown>;
  /** What the list holds ("análises", "eventos"): "1–50 de 1.234 análises". */
  unit: string;
  /** The label of the page-size select. */
  noun?: string;
  bare?: boolean;
}

/** Always says where you are: the range, the total and the page of how many, in words a screen reader gets too. */
export function Pager({ list, unit, noun = "Linhas por página", bare }: PagerProps) {
  const { first, last, total, pages, page } = list;
  const summary = `Mostrando ${fmtInt(first)} a ${fmtInt(last)}${total !== null ? ` de ${fmtInt(total)} ${unit}` : ""}. Página ${page + 1}${pages !== null ? ` de ${fmtInt(pages)}` : ""}.`;
  return (
    <nav aria-label="Paginação" class={cx("sticky bottom-0 z-[5] flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface px-4 py-2.5", bare ? "rounded-card border" : "")}>
      <label class="flex items-center gap-2 text-sm text-muted">
        <span class="max-sm:sr-only">{noun}</span>
        <select class="h-8 w-[4.5rem] rounded-control border border-line bg-surface px-2 text-sm text-fg" value={list.size} onChange={(e) => list.setSize(Number(e.currentTarget.value))}>
          {list.sizes.map((n) => (
            <option key={n} value={n} selected={n === list.size}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span class="flex-1" />
      <div aria-live="polite" aria-label={summary} class="flex flex-wrap items-baseline gap-x-3.5 text-sm tabular-nums">
        <span>
          <strong class="font-semibold">
            {fmtInt(first)}–{fmtInt(last)}
          </strong>
          {total !== null ? (
            <>
              {" de "}
              <strong class="font-semibold">{fmtInt(total)}</strong> {unit}
            </>
          ) : null}
          {list.totalNote ? <span class="text-muted"> ({list.totalNote})</span> : null}
        </span>
        <span class="border-l border-divider pl-3.5 text-muted">
          Página <strong class="font-semibold text-fg">{page + 1}</strong>
          {pages !== null ? (
            <>
              {" de "}
              <strong class="font-semibold text-fg">{fmtInt(pages)}</strong>
            </>
          ) : null}
        </span>
      </div>
      {total === null && list.status !== "loading" ? (
        list.counting ? (
          <span role="status" class="text-xs text-muted">
            Contando o total…
          </span>
        ) : (
          <Button variant="text" small onClick={list.countNow} title="Conta todos os itens para mostrar o total e o número de páginas">
            {list.countFailed ? "Tentar contar de novo" : "Contar total"}
          </Button>
        )
      ) : null}
      <div class="flex items-center">
        <IconButton icon="refresh" label="Atualizar esta página" class="!size-8" onClick={list.reload} />
        <IconButton icon="first" label="Primeira página" class="!size-8" disabled={page === 0} onClick={list.goFirst} />
        <IconButton icon="prev" label="Página anterior" class="!size-8" disabled={page === 0} onClick={list.goPrev} />
        <IconButton icon="chevron" label="Próxima página" class="!size-8" disabled={!list.hasNext} onClick={list.goNext} />
      </div>
    </nav>
  );
}

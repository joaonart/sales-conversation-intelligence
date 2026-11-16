import { addsUp, sortLines, stepLabel, STEP_HELP, totalOf, type CostLine } from "../lib/costSteps";
import { fmtInt, fmtUsd } from "../lib/format";

interface CostLinesProps {
  lines: readonly CostLine[];
  /** The total recorded on the analysis (or run): when the lines do not add up to it, the page says so instead of hiding the difference. */
  recorded?: number | null;
  /** What to say when there are no lines (an analysis made before the cost was recorded by step). */
  emptyNote?: string;
}

/**
 * What an analysis cost, line by line: each paid call with the step it paid for, the model that was paid and its tokens, then the total. The lines come
 * from the spend ledger (one row per paid call), so the evidence and the general evaluation are never hidden inside the analysis.
 */
export function CostLines({ lines, recorded, emptyNote }: CostLinesProps) {
  if (!lines.length) return emptyNote ? <p class="text-xs text-muted">{emptyNote}</p> : null;
  const sorted = sortLines(lines);
  const ok = addsUp(lines, recorded);
  return (
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-left text-sm">
        <caption class="sr-only">Custo por etapa</caption>
        <thead>
          <tr class="border-b border-line text-xs font-medium tracking-wide text-muted uppercase">
            <th scope="col" class="py-1.5 pr-4">Etapa</th>
            <th scope="col" class="py-1.5 pr-4">Modelo</th>
            <th scope="col" class="py-1.5 pr-4 text-right">Chamadas</th>
            <th scope="col" class="py-1.5 pr-4 text-right">Tokens (entrada / saída)</th>
            <th scope="col" class="py-1.5 text-right">Custo</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((l) => (
            <tr key={`${l.kind}|${l.model}`} class="border-b border-divider">
              <td class="py-1.5 pr-4 font-medium" title={STEP_HELP[l.kind]}>{stepLabel(l.kind)}</td>
              <td class="py-1.5 pr-4 font-mono text-xs">{l.model || "—"}</td>
              <td class="py-1.5 pr-4 text-right tabular-nums">{fmtInt(l.calls)}</td>
              <td class="py-1.5 pr-4 text-right text-muted tabular-nums">{l.input_tokens === null ? "—" : fmtInt(l.input_tokens)} / {l.output_tokens === null ? "—" : fmtInt(l.output_tokens)}</td>
              <td class="py-1.5 text-right tabular-nums">{fmtUsd(l.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr class="font-semibold">
            <td class="py-1.5 pr-4" colSpan={4}>Total</td>
            <td class="py-1.5 text-right tabular-nums">{fmtUsd(totalOf(lines))}</td>
          </tr>
        </tfoot>
      </table>
      {!ok ? <p class="mt-1 text-xs text-warn">O total registrado na análise é {fmtUsd(recorded ?? null)}; a diferença é de chamadas que o livro de gastos não tem (análise anterior ao registro por etapa).</p> : null}
    </div>
  );
}

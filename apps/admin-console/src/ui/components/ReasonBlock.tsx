import type { ComponentChildren } from "preact";
import { fmtNum } from "../lib/format";
import { parseJson } from "../lib/score";

interface Reasons {
  minimum?: number;
  overall?: number;
  reasons?: Array<{ code: string; criterion_id?: string; score?: number; required?: boolean }>;
}

/** Why the engine approved, rejected or held an analysis (codes persisted in approval_reason; the server already sanitised them). */
export function reasonItems(a: { approval_reason?: unknown } | null | undefined): ComponentChildren[] {
  const raw = a?.approval_reason;
  const rs = (typeof raw === "string" ? parseJson(raw) : raw) as Reasons | null | undefined;
  if (!rs?.reasons?.length) return [];
  const min = fmtNum(rs.minimum, 0);
  const id = (r: { criterion_id?: string }) => <strong class="font-mono">{r.criterion_id ?? "?"}</strong>;
  const items: ComponentChildren[] = [];
  for (const r of rs.reasons) {
    switch (r.code) {
      case "REQUIRED_CRITERION_BELOW_MINIMUM":
        items.push(<>Critério obrigatório {id(r)} obteve <strong>{fmtNum(r.score, 0)}</strong>, abaixo do mínimo de {min}. Um obrigatório abaixo do mínimo reprova mesmo com a nota geral acima dele.</>);
        break;
      case "OVERALL_BELOW_MINIMUM":
        items.push(<>Nota geral <strong>{fmtNum(rs.overall)}</strong> abaixo do mínimo de {min}.</>);
        break;
      case "MEETS_MINIMUM":
        items.push(<>Nota geral <strong>{fmtNum(rs.overall)}</strong> atinge o mínimo de {min} e nenhum critério obrigatório ficou abaixo dele.</>);
        break;
      case "INSUFFICIENT_EVIDENCE":
        items.push(<>Sem evidência suficiente no critério {id(r)}{r.required ? " (obrigatório)" : ""}.</>);
        break;
      case "NO_APPLICABLE_CRITERIA":
        items.push(<>Nenhum critério da rubrica se aplica a esta conversa.</>);
        break;
      default:
        break;
    }
  }
  return items;
}

export function ReasonBlock({ a }: { a: { approval_reason?: unknown } }) {
  const items = reasonItems(a);
  if (!items.length) return null;
  return (
    <div class="mt-3">
      <div class="text-xs font-medium tracking-wide text-muted uppercase">Motivo do resultado</div>
      <ul class="mt-1 list-disc space-y-1 pl-5">{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
    </div>
  );
}

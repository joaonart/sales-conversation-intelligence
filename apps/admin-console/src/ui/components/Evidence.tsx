import { badgeText, sortCited, type Cited } from "../lib/evidence";
import { fmtNum } from "../lib/format";
import type { SessionMessage } from "../lib/types";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

interface CriteriaBadgesProps {
  list: Cited[];
  /** The badge says the criterion's name (the rubric's) or its identifier (what the data and the API use). */
  showNames: boolean;
  /** Jumps to the row of the criterion in the list above, when it has one. */
  onJump?: (key: string) => void;
}

/** The criteria whose evidence is a message, with the weight each has in the rubric and what it contributed to the grade. */
export function CriteriaBadges({ list, showNames, onJump }: CriteriaBadgesProps) {
  return (
    <div class="mt-2 flex flex-wrap gap-1.5" aria-label="Critérios evidenciados nesta mensagem">
      {sortCited(list).map((c) => {
        const named = Boolean(c.name) && c.name !== c.id; // without a name the id is all there is
        const ans = c.answer && c.answer.answer !== undefined && c.answer.answer !== null ? String(c.answer.answer) : null;
        const tip =
          `Critério ${named ? `${c.name} (${c.id})` : c.id} · peso ${fmtNum(c.weight)}` +
          (c.score !== null && c.score !== undefined ? ` · nota ${fmtNum(c.score, 0)}` : "") +
          (c.contrib !== null && c.contrib !== undefined ? ` · contribuição ${fmtNum(c.contrib, 2)}` : "") +
          (ans ? ` · resposta ${ans}` : "") +
          (c.rubric ? ` · ${c.rubric}` : "");
        const said = badgeText(c);
        const inner = (
          <>
            <span class={cx(showNames && named ? "font-medium" : "font-mono text-[11px]")}>{showNames && named ? c.name : c.id}</span>
            {said ? <span class="rounded bg-surface px-1 text-[11px] text-fg">{said}</span> : null}
          </>
        );
        const cls = "inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-0.5 text-xs text-warn";
        return onJump ? (
          <button key={c.key} type="button" class={cx(cls, "hover:brightness-95")} title={`${tip} · clique para ver na lista de critérios`} aria-label={`Ver o critério ${named ? c.name : c.id} na lista de critérios`} onClick={() => onJump(c.key)}>{inner}</button>
        ) : (
          <span key={c.key} class={cls} title={tip}>{inner}</span>
        );
      })}
    </div>
  );
}

/** Evidence of a criterion as badges; each one scrolls to its message in the conversation below and flashes it. */
export function EvidenceLinks({ ids, messages, onGo }: { ids: string[] | null | undefined; messages: SessionMessage[]; onGo: (id: string) => void }) {
  if (!ids?.length) return <>—</>;
  const byId = new Map(messages.map((m) => [m.message_id, m]));
  return (
    <div class="flex flex-wrap gap-1">
      {ids.map((id) => {
        const m = byId.get(id);
        const label = m && m.sequence_number !== null && m.sequence_number !== undefined ? `#${m.sequence_number}` : String(id);
        if (!m) return <span key={id} class="inline-flex h-6 items-center rounded-full bg-surface-2 px-2 text-xs text-muted" title={`Mensagem ${id} fora do trecho carregado da conversa`}>{label}</span>;
        return (
          <button key={id} type="button" title={`Ir para a mensagem ${id}`} aria-label={`Ir para a mensagem ${label}`} onClick={() => onGo(id)} class="inline-flex h-6 items-center gap-1 rounded-full bg-primary-soft px-2 text-xs font-medium text-on-primary-soft hover:brightness-95">
            <Icon name="review" size="sm" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

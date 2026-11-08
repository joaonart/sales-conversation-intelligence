import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { EvidenceLinks } from "../../components/Evidence";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../components/icons";
import { RubricBadge } from "../../components/RubricBadge";
import { cx } from "../../lib/cx";
import { parseJson } from "../../lib/score";
import type { SessionAnalysis, SessionMessage, SummaryRow } from "../../lib/types";

interface Item {
  text?: string;
  message_ids?: string[];
}

function Section({ title, icon, tone, raw, messages, onGo }: { title: string; icon: IconName; tone: string; raw: string | null; messages: SessionMessage[]; onGo: (id: string) => void }) {
  const parsed = parseJson(raw);
  const items: Item[] = Array.isArray(parsed) ? (parsed as Item[]) : [];
  return (
    <section aria-label={title} class="rounded-control border border-line p-3">
      <h3 class={cx("mb-2 flex items-center gap-2 font-semibold", tone)}>
        <Icon name={icon} size="sm" />
        {title}
        <Badge>{String(items.length)}</Badge>
      </h3>
      {items.length ? (
        <ul class="flex flex-col gap-2.5">
          {items.map((it, i) => (
            <li key={i} class="flex flex-col gap-1">
              <span class="whitespace-pre-wrap">{String(it.text ?? "")}</span>
              {it.message_ids?.length ? <EvidenceLinks ids={it.message_ids} messages={messages} onGo={onGo} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p class="text-xs text-muted">Nenhum ponto identificado.</p>
      )}
    </section>
  );
}

/**
 * The general evaluation of an analysis: what the model wrote after the score was final (positives, negatives, opportunities, each with the messages that
 * support it). Text only: it comes from a model, so it is never markup. It says what produced it and that it did not take part in the grade.
 */
export function GeneralCard({ analysis: a, summary: sm, messages, several, onGo }: { analysis: SessionAnalysis; summary: SummaryRow; messages: SessionMessage[]; several: boolean; onGo: (id: string) => void }) {
  const meta = [sm.model ? `escrita por ${sm.model}` : null, sm.summary_prompt_hash ? `prompt ${String(sm.summary_prompt_hash).slice(0, 8)}` : null].filter(Boolean).join(" · ");
  return (
    <Card title="Avaliação geral" aside={<span class="flex items-center gap-2">{several ? <RubricBadge rubricId={a.rubric_id} version={a.rubric_version} /> : null}{meta}</span>}>
      <p class="mb-4 whitespace-pre-wrap">{String(sm.overall_summary ?? "")}</p>
      <div class="grid gap-3 lg:grid-cols-3">
        <Section title="Pontos positivos" icon="ok" tone="text-ok" raw={sm.strengths} messages={messages} onGo={onGo} />
        <Section title="Pontos negativos" icon="warn" tone="text-warn" raw={sm.weaknesses} messages={messages} onGo={onGo} />
        <Section title="Oportunidades" icon="review" tone="text-info" raw={sm.opportunities} messages={messages} onGo={onGo} />
      </div>
      <p class="mt-3 text-xs text-muted">Escrita por IA depois que a nota ficou fechada: não entra no cálculo da nota nem na aprovação.</p>
    </Card>
  );
}

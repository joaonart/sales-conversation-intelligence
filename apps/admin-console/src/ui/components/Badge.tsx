import type { ComponentChildren } from "preact";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "primary";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
  primary: "bg-primary-soft text-on-primary-soft",
};

const TONE_ICON: Partial<Record<Tone, IconName>> = { ok: "ok", warn: "warn", bad: "bad", info: "info" };

interface BadgeProps {
  tone?: Tone;
  /** Show the tone's icon (a colour alone must not be the only signal). */
  withIcon?: boolean;
  mono?: boolean;
  children?: ComponentChildren;
  class?: string;
}

export function Badge({ tone = "neutral", withIcon, mono, children, class: className }: BadgeProps) {
  const icon = withIcon ? TONE_ICON[tone] : undefined;
  return (
    <span class={cx("inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", TONE[tone], mono && "font-mono", className)}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </span>
  );
}

/** What each status the server can send reads as, and in which tone (the same words the console has always used). */
export const STATUS: Record<string, [label: string, tone: Tone]> = {
  COMPLETED: ["Concluída", "ok"], NEEDS_REVIEW: ["Revisão necessária", "warn"], NOT_EVALUABLE: ["Não avaliável", "neutral"], FAILED: ["Falha", "bad"],
  APPROVED: ["Aprovada", "ok"], REJECTED: ["Reprovada", "bad"], DRAFT: ["Rascunho", "warn"], PUBLISHED: ["Publicada", "ok"],
  RUNNING: ["Em andamento", "info"], BUDGET_STOPPED: ["Parada por orçamento", "warn"], COMPLETED_WITH_FAILURES: ["Concluída com falhas", "warn"],
  SESSION_GATE_STOPPED: ["Parada por limite", "warn"], SUCCESS: ["Sucesso", "ok"], DENIED: ["Negado", "bad"], ERROR: ["Erro", "bad"],
  ACTIVE: ["Ativo", "ok"], DISABLED: ["Desativado", "neutral"], APPLICABLE: ["Aplicável", "ok"], NOT_APPLICABLE: ["Não aplicável", "neutral"],
  INSUFFICIENT_EVIDENCE: ["Evidência insuficiente", "warn"], PENDING: ["Pendente", "warn"], N_A: ["Não se aplica", "neutral"],
  REQUESTED: ["Aguardando worker", "warn"], CANCELLED: ["Cancelada", "neutral"], PENDING_REVIEW: ["Aguardando revisão", "warn"],
  CONFIRMED: ["Resultado confirmado", "ok"], DISAGREED: ["Revisor discordou", "bad"], REANALYSIS: ["Reanálise recomendada", "info"],
  EVALUATED: ["Analisada", "ok"], DUPLICATE_CONTENT: ["Conteúdo repetido", "neutral"], NO_MESSAGES: ["Sem mensagens", "neutral"],
  SESSION_NOT_FOUND: ["Sessão não encontrada", "warn"], RATE_LIMITED: ["Limite por sessão", "warn"], BUDGET_BLOCKED: ["Teto mensal", "warn"],
  TOKEN_LIMIT: ["Acima do limite de tokens", "warn"], ROUTED_SKIP: ["Sem rubrica (roteador)", "neutral"],
};

/** A status as a badge; a code that is not known is shown as it came, never dropped. */
export function StatusBadge({ code }: { code: string | null | undefined }) {
  if (!code) return <span class="text-faint">—</span>;
  const [label, tone] = STATUS[code] ?? [code, "neutral" as Tone];
  return (
    <Badge tone={tone} withIcon>
      {label}
    </Badge>
  );
}

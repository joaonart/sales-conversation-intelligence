import { Icon } from "./Icon";

/** The rubric an analysis used, as a badge that opens that exact version. It sits inside clickable rows too: its click and Enter must not reach the row. */
export function RubricBadge({ rubricId, version }: { rubricId: string; version: number | string }) {
  const href = `#/rubrics/${encodeURIComponent(rubricId)}/${encodeURIComponent(String(version))}`;
  return (
    <a
      href={href}
      title={`Abrir o detalhe da rubrica ${rubricId} v${version}`}
      aria-label={`Rubrica ${rubricId} versão ${version}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      class="inline-flex h-6 items-center gap-1 rounded-full bg-primary-soft px-2.5 text-xs font-medium whitespace-nowrap text-on-primary-soft hover:no-underline"
    >
      <Icon name="rubrics" size="sm" />
      {rubricId} v{version}
    </a>
  );
}

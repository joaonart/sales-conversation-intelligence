import type { ComponentChildren } from "preact";

interface PageHeadProps {
  title: string;
  subtitle?: string;
  /** [label, hash] pairs; the last one (no hash) is the current page. */
  trail?: Array<[label: string, href?: string]>;
  actions?: ComponentChildren;
}

export function PageHead({ title, subtitle, trail, actions }: PageHeadProps) {
  return (
    <div class="mb-5 flex flex-wrap items-start gap-x-4 gap-y-2">
      <div class="min-w-0">
        {trail && trail.length > 1 ? (
          <nav aria-label="Você está em" class="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {trail.map(([label, href], i) => (
              <span key={label} class="inline-flex items-center gap-1.5">
                {i > 0 ? <span aria-hidden="true">›</span> : null}
                {href ? <a href={href}>{label}</a> : <span aria-current="page">{label}</span>}
              </span>
            ))}
          </nav>
        ) : null}
        <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p class="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div class="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

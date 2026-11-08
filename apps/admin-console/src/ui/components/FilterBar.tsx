import type { ComponentChildren } from "preact";
import { Button } from "./Button";

interface FilterBarProps {
  children?: ComponentChildren;
  /** True while some field differs from its default: only then can "Limpar" be pressed. */
  dirty: boolean;
  onClear: () => void;
  /** With it the bar has a "Buscar" button and Enter in a field submits; without it the caller applies each change itself. */
  onSubmit?: () => void;
}

export function FilterBar({ children, dirty, onClear, onSubmit }: FilterBarProps) {
  return (
    <form
      role="search"
      aria-label="Filtros"
      class="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-card border border-line bg-surface p-4 shadow-card [&>label]:w-40"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
      <span class="flex-1" />
      <Button variant="text" onClick={onClear} disabled={!dirty} title="Limpar filtros" aria-label="Limpar filtros">
        Limpar
      </Button>
      {onSubmit ? (
        <Button variant="primary" type="submit">
          Buscar
        </Button>
      ) : null}
    </form>
  );
}

/**
 * The look every text control shares (input, combo, textarea): a thin outline, a darker one on hover, a primary outline when focused and a red one
 * when invalid (`aria-invalid`), as in the Google Cloud console. Written once so no screen draws its own field.
 */
export const CONTROL_BASE =
  "w-full min-w-0 rounded-control border border-line bg-surface text-sm text-fg placeholder:text-faint transition-colors " +
  "hover:border-faint focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary " +
  "aria-[invalid=true]:border-bad aria-[invalid=true]:ring-bad disabled:cursor-default disabled:opacity-60 disabled:hover:border-line";

/** One line controls are 36 px tall; the compact ones (`!h-8`) are set by the caller. */
export const CONTROL = `h-9 px-3 ${CONTROL_BASE}`;

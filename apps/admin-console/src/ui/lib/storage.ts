/**
 * Per-browser conveniences (theme, collapsed menu, remembered page). The Apps Script iframe may block storage, so every read and write is guarded and the
 * page always works without it: a failed read is "nothing stored", a failed write is ignored.
 */
type Kind = "local" | "session";

function area(kind: Kind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStore(kind: Kind, key: string): string | null {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStore(kind: Kind, key: string, value: string | null): void {
  try {
    const s = area(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* a convenience, never a requirement */
  }
}

import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

export interface PanelBox {
  left: number;
  top?: number;
  bottom?: number;
  /** The most the panel may grow to, in px. */
  max: number;
}

/**
 * Where a panel that hangs from `r` goes: under it, or over it when there is no room below and more above. Fixed to the viewport (it is drawn in the
 * page body, so no card or dialog clips it); `want` is the height it would like.
 */
export function placePanel(r: DOMRect, want: number): PanelBox {
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  const up = below < Math.min(want, 180) && above > below;
  const room = up ? above : below;
  return { left: Math.max(8, Math.min(r.left, window.innerWidth - 8)), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }), max: Math.max(120, Math.min(want, room)) };
}

/** While `open`: a press outside the panel and its button, a resize, or a scroll of the page (not inside the panel) closes it. */
export function useDismiss(open: boolean, panel: RefObject<HTMLElement>, button: RefObject<HTMLElement>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event): void => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const moved = (e: Event): void => {
      if (!panel.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Scrolls an element into view, moves focus to it and flashes it (used both ways: criterion -> message and message -> criterion). */
export function jumpTo(el: HTMLElement | null | undefined): void {
  if (!el) return;
  let calm = false;
  try {
    calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    /* no matchMedia */
  }
  el.scrollIntoView?.({ behavior: calm ? "auto" : "smooth", block: "center" });
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* focus is a nicety */
  }
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 2000);
}

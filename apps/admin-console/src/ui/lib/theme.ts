import { readStore, writeStore } from "./storage";

export type ThemeMode = "auto" | "light" | "dark";
const KEY = "sci.theme";

export function themeMode(): ThemeMode {
  const t = readStore("local", KEY);
  return t === "light" || t === "dark" ? t : "auto";
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function setThemeMode(mode: ThemeMode): void {
  writeStore("local", KEY, mode === "auto" ? null : mode);
  applyTheme(mode);
}

/** The header button: from what is showing now to the other one (and from then on pinned). */
export function toggleTheme(): void {
  const dark = document.documentElement.getAttribute("data-theme") === "dark" || (themeMode() === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  setThemeMode(dark ? "light" : "dark");
}

import { useEffect, useState } from "preact/hooks";

export interface Route {
  name: string;
  parts: string[];
}

/** `#/sessions/abc` -> { name: "sessions", parts: ["abc"] }; an empty hash is the dashboard. */
export function parseHash(hash: string): Route {
  const parts = (hash.replace(/^#\/?/, "") || "dashboard").split("/");
  return { name: parts.shift() ?? "dashboard", parts };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** The Apps Script iframe must never navigate the top window with a plain link: every internal move only sets the hash. */
export function go(hash: string): void {
  location.hash = hash;
}

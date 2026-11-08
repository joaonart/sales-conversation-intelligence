import { useEffect, useState } from "preact/hooks";

export type Async<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** Runs `load` when `deps` change; a response that arrives after a newer request (or after leaving the screen) is dropped. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    load().then(
      (data) => live && setState({ status: "ready", data }),
      (e: unknown) => live && setState({ status: "error", message: e instanceof Error ? e.message : "Erro inesperado." }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

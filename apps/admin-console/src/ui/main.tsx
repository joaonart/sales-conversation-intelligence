import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./app/App";
import { NoAccess, SignInError, Splash } from "./app/AuthScreens";
import { ConfirmProvider } from "./components/Modal";
import { ToastProvider, useToast } from "./components/Toasts";
import { ApiError, call, onBusy } from "./lib/api";
import type { Me } from "./lib/types";
import { SessionProvider } from "./state/session";

/** The thin bar at the top that moves while any request is in flight. */
function Progress() {
  const [n, setN] = useState(0);
  useEffect(() => onBusy(setN), []);
  return <div role="progressbar" aria-hidden={n === 0} aria-label="Carregando" class={n ? "fixed top-0 right-0 left-0 z-[100] h-0.5 animate-pulse bg-primary" : "hidden"} />;
}

/** Errors nobody caught still reach the person as a message (and the console), never silence. */
function GlobalErrors() {
  const toast = useToast();
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      console.error("window_error", e.message);
      toast(`Erro na tela: ${e.message || "desconhecido"}`, true);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const m = e.reason instanceof Error ? e.reason.message : "desconhecido";
      console.error("unhandled_rejection", m);
      toast(`Erro inesperado: ${m}`, true);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [toast]);
  return null;
}

/** Warns before leaving the page while a screen holds unsaved edits (a screen sets and clears `window.__sciDirty`). */
declare global {
  interface Window {
    __sciDirty?: (() => boolean) | null;
  }
}

function Boot() {
  const [state, setState] = useState<{ me: Me } | { error: ApiError } | null>(null);
  useEffect(() => {
    call("me").then(
      (me) => setState({ me }),
      (e: unknown) => setState({ error: e instanceof ApiError ? e : new ApiError("INTERNAL", e instanceof Error ? e.message : "Erro inesperado.") }),
    );
    const onUnload = (e: BeforeUnloadEvent) => {
      if (window.__sciDirty?.()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
  if (!state) return <Splash />;
  if ("error" in state) return <SignInError error={state.error} />;
  if (!state.me.memberships.length) return <NoAccess me={state.me} />;
  return (
    <SessionProvider me={state.me}>
      <App />
    </SessionProvider>
  );
}

const root = document.getElementById("app");
if (root) {
  root.textContent = "";
  render(
    <ToastProvider>
      <ConfirmProvider>
        <Progress />
        <GlobalErrors />
        <Boot />
      </ConfirmProvider>
    </ToastProvider>,
    root,
  );
}

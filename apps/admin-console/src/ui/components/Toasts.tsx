import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useMemo, useState } from "preact/hooks";
import { cx } from "../lib/cx";

interface ToastItem {
  id: number;
  message: string;
  bad: boolean;
}
type Notify = (message: string, bad?: boolean) => void;

const Ctx = createContext<Notify>(() => undefined);
let seq = 0;

/** Short messages in the corner (an error stays longer). Text only: a message can never become markup. */
export function ToastProvider({ children }: { children?: ComponentChildren }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const notify = useCallback<Notify>((message, bad = false) => {
    const id = ++seq;
    setItems((cur) => [...cur, { id, message, bad }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), bad ? 7000 : 3500);
  }, []);
  const value = useMemo(() => notify, [notify]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" class="pointer-events-none fixed right-4 bottom-4 z-[90] flex max-w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} class={cx("pointer-events-auto rounded-control px-4 py-3 text-sm shadow-pop", t.bad ? "bg-bad text-on-primary" : "bg-fg text-bg")}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = (): Notify => useContext(Ctx);

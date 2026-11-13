import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./Button";
import { cx } from "../lib/cx";

interface ModalProps {
  title: string;
  onClose: () => void;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  wide?: boolean;
}

/** How many dialogs are open: the page behind stays locked until the last one closes (a confirmation opens on top of a form). */
let openDialogs = 0;

/** A dialog: Escape closes it, focus goes in when it opens and back to where it was when it closes, and the page behind does not scroll. */
export function Modal({ title, onClose, children, actions, wide }: ModalProps) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    openDialogs++;
    document.body.classList.add("overflow-hidden");
    box.current?.querySelector<HTMLElement>("[data-autofocus], button, input, select, textarea")?.focus();
    return () => {
      if (--openDialogs <= 0) {
        openDialogs = 0;
        document.body.classList.remove("overflow-hidden");
      }
      before?.focus?.();
    };
  }, []);
  return (
    <div
      class="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} class={cx("flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-card bg-surface p-6 shadow-pop", wide ? "max-w-3xl" : "max-w-lg")}>
        <h2 class="mb-4 text-xl font-semibold tracking-tight">{title}</h2>
        <div class="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {actions ? <div class="mt-6 flex justify-end gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmOptions {
  title: string;
  body: ComponentChildren;
  okLabel: string;
  danger?: boolean;
}
type Confirm = (o: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<Confirm>(() => Promise.resolve(false));

/** `await confirm({...})`: resolves true on the confirming button and false on Cancel or Escape. Nothing irreversible runs without it. */
export function ConfirmProvider({ children }: { children?: ComponentChildren }) {
  const [pending, setPending] = useState<{ o: ConfirmOptions; done: (v: boolean) => void } | null>(null);
  const confirm = useCallback<Confirm>((o) => new Promise((done) => setPending({ o, done })), []);
  const finish = (v: boolean) => {
    pending?.done(v);
    setPending(null);
  };
  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending ? (
        <Modal
          title={pending.o.title}
          onClose={() => finish(false)}
          actions={
            <>
              <Button onClick={() => finish(false)} data-autofocus>
                Cancelar
              </Button>
              <Button variant={pending.o.danger ? "danger" : "primary"} onClick={() => finish(true)}>
                {pending.o.okLabel}
              </Button>
            </>
          }
        >
          {pending.o.body}
        </Modal>
      ) : null}
    </Ctx.Provider>
  );
}

export const useConfirm = (): Confirm => useContext(Ctx);

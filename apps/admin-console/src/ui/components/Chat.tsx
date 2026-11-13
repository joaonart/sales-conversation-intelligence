import type { ComponentChildren } from "preact";
import { cx } from "../lib/cx";
import { dayKey, fmtLongDay, fmtTime } from "../lib/format";
import type { SessionMessage } from "../lib/types";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

const SENDER: Record<string, [label: string, icon: IconName]> = { customer: ["Cliente", "person"], seller: ["Vendedor", "headset"], bot: ["Bot", "bot"], system: ["Sistema", "info"] };

interface ChatProps {
  messages: SessionMessage[];
  /** Under a message: the criteria badges, the evidence... */
  extra?: (m: SessionMessage) => ComponentChildren;
  /** Whether a message is evidence of something (it gets a marker). */
  marked?: (m: SessionMessage) => boolean;
  /** Called with the element of each message, so a link elsewhere can scroll to it. */
  rowRef?: (id: string, el: HTMLElement | null) => void;
}

/** The messages of a conversation as a chat: a separator at each new day, who spoke, the sequence number, the time and the id. Text only. */
export function Chat({ messages, extra, marked, rowRef }: ChatProps) {
  let lastDay: string | null = null;
  return (
    <div role="log" aria-label="Mensagens da conversa" class="flex flex-col gap-3">
      {messages.map((m) => {
        const day = dayKey(m.created_at);
        const sep = day && day !== lastDay ? <div role="separator" class="my-1 text-center text-xs text-muted">{fmtLongDay(m.created_at)}</div> : null;
        if (day) lastDay = day;
        const known = SENDER[m.sender_type];
        const [who, icon] = known ?? [m.sender_type || "Desconhecido", "person" as IconName];
        const seller = m.sender_type === "seller" || m.sender_type === "bot";
        const time = fmtTime(m.created_at);
        return (
          <div key={m.message_id}>
            {sep}
            <div class={cx("flex gap-2.5", seller && "flex-row-reverse")}>
              <span title={who} aria-hidden="true" class="mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"><Icon name={icon} size="sm" /></span>
              <div ref={(el) => rowRef?.(m.message_id, el)} tabIndex={-1} class={cx("max-w-[min(46rem,85%)] rounded-card border px-3.5 py-2.5 outline-none", seller ? "border-transparent bg-primary-soft text-on-primary-soft" : "border-line bg-surface", marked?.(m) && "ring-2 ring-primary/40")}>
                <div class="mb-1 flex flex-wrap items-center gap-x-2 text-xs opacity-80">
                  <span class="font-semibold">{who}</span>
                  <span>#{m.sequence_number ?? "?"}</span>
                  {time ? <span>{time}</span> : null}
                  <span class="font-mono" title="ID da mensagem">{m.message_id}</span>
                </div>
                <div class="break-words whitespace-pre-wrap">{m.content}</div>
                {extra?.(m)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

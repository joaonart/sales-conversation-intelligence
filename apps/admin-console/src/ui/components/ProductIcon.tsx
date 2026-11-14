import { PRODUCT_ICONS } from "../lib/productIcons";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { cx } from "../lib/cx";

/** Which official mark a component or a resource group wears; anything else gets a generic glyph. */
const MARK: Record<string, string> = { bigquery: "bigquery", cloudrun: "cloudrun", pubsub: "pubsub", appsscript: "appsscript", python: "python", openai: "openai" };

export function ProductIcon({ mark, glyph, class: className }: { mark?: string; glyph?: IconName; class?: string }) {
  const m = mark ? MARK[mark] : undefined;
  if (m === "openai") {
    // OpenAI ships a black and a white mark: the one that contrasts with the theme is shown (see .pi-light / .pi-dark in the stylesheet).
    return (
      <span class={cx("inline-flex size-6 shrink-0", className)}>
        <img class="pi-light size-6" src={PRODUCT_ICONS.openai} alt="" width={24} height={24} draggable={false} />
        <img class="pi-dark size-6" src={PRODUCT_ICONS.openaidark} alt="" width={24} height={24} draggable={false} />
      </span>
    );
  }
  if (m && PRODUCT_ICONS[m]) return <img class={cx("size-6 shrink-0", className)} src={PRODUCT_ICONS[m]} alt="" width={24} height={24} draggable={false} />;
  return <span class={cx("inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted", className)}>{glyph ? <Icon name={glyph} size="sm" /> : null}</span>;
}

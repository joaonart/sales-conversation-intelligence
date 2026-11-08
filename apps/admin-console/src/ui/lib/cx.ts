/** Joins class names, skipping anything falsy: `cx("a", cond && "b")`. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

describe("form controls come from the component set", () => {
  it("no screen draws its own input, select or textarea: views and the shell use Input, Select, Textarea, Checkbox, Radio, Switch or SearchField", () => {
    // Only the components that ARE the controls may use the native tags; everything else goes through them.
    const own = ["Controls.tsx", "Field.tsx", "Select.tsx", "Switch.tsx"];
    const offenders = [...files("src/ui/views"), ...files("src/ui/app"), ...files("src/ui/components")]
      .filter((f) => f.endsWith(".tsx") && !own.some((o) => f.endsWith(`/${o}`)))
      .filter((f) => /<(input|select|textarea)\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

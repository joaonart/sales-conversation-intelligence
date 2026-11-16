import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

describe("form controls come from the component set", () => {
  it("no screen draws its own input, select or textarea: views and the shell use Input, Select, DatePicker, Textarea, Checkbox, Radio, Switch or SearchField", () => {
    // Only the components that ARE the controls may use the native tags; everything else goes through them.
    const own = ["Controls.tsx", "DatePicker.tsx", "Field.tsx", "Select.tsx", "Switch.tsx"];
    const offenders = [...files("src/ui/views"), ...files("src/ui/app"), ...files("src/ui/components")]
      .filter((f) => f.endsWith(".tsx") && !own.some((o) => f.endsWith(`/${o}`)))
      .filter((f) => /<(input|select|textarea)\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no screen draws its own button: it uses Button, IconButton, ToggleGroup, ChipButton, DisclosureButton, StepButton, BareButton or Tabs", () => {
    const own = ["Button.tsx", "Tabs.tsx", "Select.tsx", "DatePicker.tsx"];
    const offenders = [...files("src/ui/views"), ...files("src/ui/app"), ...files("src/ui/components")]
      .filter((f) => f.endsWith(".tsx") && !own.some((o) => f.endsWith(`/${o}`)))
      .filter((f) => /<button\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no screen uses a native number input: numbers go through NumberInput (a native one rewrites '0,' as '0', so '0,08' could not be typed)", () => {
    const offenders = [...files("src/ui/views"), ...files("src/ui/app"), ...files("src/ui/components")]
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /type="number"/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no screen uses a native date input: dates go through DatePicker", () => {
    const offenders = [...files("src/ui/views"), ...files("src/ui/app"), ...files("src/ui/components")]
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /type="(date|datetime-local|time|month)"/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

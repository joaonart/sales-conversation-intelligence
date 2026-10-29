import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const js = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");

describe("client cannot turn data into markup or code", () => {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it.each([
    ["innerHTML assignment", /\.innerHTML\s*=/],
    ["outerHTML assignment", /\.outerHTML\s*=/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\.write/],
    ["eval", /\beval\s*\(/],
    ["new Function", /new\s+Function\s*\(/],
    ["string timers", /set(Timeout|Interval)\s*\(\s*["'`]/],
    ["external scripts or styles", /https?:\/\/[^"'\s]+\.(js|css)/],
  ])("has no %s", (_n, re) => {
    expect(code).not.toMatch(re);
  });

  it("the page template pulls in nothing from other origins", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
  });

  it("keeps navigation inside the sandboxed iframe (no <base target=_top>, every internal link sets the hash itself)", () => {
    expect(html).not.toMatch(/<base\b/i);
    // Every h("a", {...}) link must carry an onclick: a bare <a href="#/x"> could navigate the top window and leave a blank page.
    const attrsOf = (src: string, from: number): string => {
      let depth = 0;
      for (let i = src.indexOf("{", from); i < src.length; i++) {
        if (src[i] === "{") depth++;
        if (src[i] === "}" && --depth === 0) return src.slice(src.indexOf("{", from), i + 1);
      }
      return "";
    };
    const starts = [...code.matchAll(/h\("a",\s*\{/g)].map((m) => m.index ?? 0);
    expect(starts.length).toBeGreaterThanOrEqual(2); // the sidebar and the breadcrumb trail
    for (const at of starts) expect(attrsOf(code, at), attrsOf(code, at).slice(0, 80)).toMatch(/onclick:/);
  });

  it("a view that throws shows an error instead of a blank page", () => {
    expect(code).toMatch(/try\s*\{\s*VIEWS\[name\]\(main, parts\);\s*\}\s*catch/);
    expect(code).toMatch(/addEventListener\("unhandledrejection"/);
  });

  it("never reads identity or tenant from the URL or storage for authorisation", () => {
    expect(code).not.toMatch(/location\.search/);
  });
});

describe("layout does not depend on grid auto-placement", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("places the sidebar and the content in explicit columns, so hiding the sidebar cannot push the content into a zero-width column", () => {
    // Regression: collapsing the menu hid .side (display: none); auto-placement then moved <main> into the 0px first column.
    expect(css).toMatch(/\.side\s*\{[^}]*grid-column:\s*1/);
    expect(css).toMatch(/^main\s*\{[^}]*grid-column:\s*2/m);
    expect(css).toMatch(/\.shell\.nav-collapsed\s*\{[^}]*grid-template-columns:\s*0\s+minmax\(0,\s*1fr\)/);
  });

  it("uses a single column on small screens, where the navigation is a drawer outside the grid flow", () => {
    const small = css.slice(css.indexOf("@media (max-width: 960px)"));
    expect(small).toMatch(/\.shell\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(small).toMatch(/main\s*\{\s*grid-column:\s*1/);
  });
});

describe("header search draws a single border", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("the wrapper owns the border and focus ring; the inner field is reset for every state, with enough specificity to beat input:focus", () => {
    // Regression: the global input:focus rule (same specificity, declared later) drew a second ring inside the wrapper's own border.
    expect(css).toMatch(/\.search:focus-within\s*\{[^}]*border-color:\s*var\(--primary\)/);
    const rule = css.match(/\.search input,\s*\.search input:hover,\s*\.search input:focus,\s*\.search input:focus-visible\s*\{([^}]*)\}/);
    expect(rule, "the .search input reset must cover :hover, :focus and :focus-visible").not.toBeNull();
    expect(rule?.[1]).toMatch(/border:\s*0/);
    expect(rule?.[1]).toMatch(/box-shadow:\s*none/);
    expect(rule?.[1]).toMatch(/outline:\s*0/);
  });
});

describe("scrolling", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("scrollbars are themed in light and dark (same tokens as the rest of the UI)", () => {
    expect(css.match(/--scroll-thumb:/g)?.length).toBe(3); // light, dark by system preference, dark pinned by the toggle
    expect(css).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*var\(--scroll-thumb\)/);
    expect(css).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*var\(--scroll-thumb-hover\)/);
    expect(css).toMatch(/@supports \(-moz-appearance: none\)\s*\{[^}]*scrollbar-color/); // Firefox uses the standard properties
  });

  it("the scrollbar track is painted with the theme's own colour, never transparent (so a light backdrop cannot show through in dark mode)", () => {
    const track = css.match(/(?<![\w:-])::-webkit-scrollbar-track\s*\{([^}]*)\}/);
    expect(track?.[1]).toMatch(/var\(--surface\)/);
    expect(track?.[1]).not.toMatch(/transparent/);
    expect(css).toMatch(/html::-webkit-scrollbar-track\s*\{\s*background:\s*var\(--bg\)/); // the page edge sits on the page background
    expect(css).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\)\s+var\(--surface\)/); // Firefox
  });

  it("reserves the bar's space, keeps inner scrolling from dragging the page and locks the page behind a dialog", () => {
    expect(css).toMatch(/html\s*\{\s*scrollbar-gutter:\s*stable/);
    expect(css).toMatch(/overscroll-behavior:\s*contain/);
    expect(css).toMatch(/body\.modal-open\s*\{\s*overflow:\s*hidden/);
    const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
    expect(appJs.match(/modal-open/g)?.length).toBeGreaterThanOrEqual(2); // added when a dialog opens and removed when it closes
  });
});


describe("no flash of the wrong theme while loading", () => {
  it("applies the pinned theme from the <head>, before the stylesheet, and declares the colour schemes up front", () => {
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    const script = head.indexOf("<script>");
    const styles = head.indexOf("include('styles')");
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(styles); // the attribute is already there when the first rule is evaluated
    expect(head).toMatch(/<meta name="color-scheme" content="light dark"/);
    expect(head).toMatch(/localStorage\.getItem\("sci\.theme"\)/);
    expect(head).toMatch(/setAttribute\("data-theme", t\)/);
    expect(head).toMatch(/catch \(e\)/); // storage can be blocked in the sandbox
  });

  it("uses the same storage key as the toggle in app.js", () => {
    const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
    expect(appJs).toContain('localStorage.setItem("sci.theme"');
    expect(appJs).toContain('localStorage.getItem("sci.theme")');
  });
});

describe("controls inside a table row share one compact height", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const height = (selector: string): string | undefined => css.match(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{[^}]*?height:\\s*(\\d+px)`))?.[1];

  it("the role select and the small button are both 28px and vertically centred (not the 36px form height)", () => {
    expect(height(".btn.small")).toBe("28px");
    expect(height(".row-actions select")).toBe("28px");
    expect(css).toMatch(/\.row-actions\s*\{[^}]*align-items:\s*center/);
  });

  it("the users table uses that wrapper instead of the form row (which aligns to the bottom)", () => {
    expect(appJs).toMatch(/h\("div", \{ class: "row-actions" \}, sel,/);
  });
});

describe("account menu appearance selector", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("fills the whole width of the card and splits it evenly between the three options", () => {
    expect(css).toMatch(/\.acct \.seg\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%/);
    expect(css).toMatch(/\.acct \.seg button\s*\{[^}]*flex:\s*1 1 0/);
  });
});

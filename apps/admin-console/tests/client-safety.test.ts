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

describe("conversation view on the session page", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");

  it("labels every known sender in Portuguese with an icon, and still shows unknown senders as they come", () => {
    expect(appJs).toMatch(/customer: \["Cliente", "person"\]/);
    expect(appJs).toMatch(/seller: \["Vendedor", "headset"\]/);
    expect(appJs).toMatch(/bot: \["Bot", "bot"\]/);
    expect(appJs).toMatch(/system: \["Sistema", "info"\]/);
    expect(appJs).toMatch(/m\.sender_type \|\| "Desconhecido"/);
  });

  it("is an accessible log with day separators, and marks evidence through the criteria badges in the warning colour", () => {
    expect(appJs).toContain('role: "log"');
    expect(appJs).toContain('role: "separator"');
    expect(appJs).toContain('class: "msg" + (ev ? " hl" : "")');
    expect(appJs).toContain("criteriaBadges(highlight[m.message_id], rows)");
  });

  it("puts the message text in a text node (never markup), so conversation content cannot inject HTML", () => {
    expect(appJs).toMatch(/h\("div", \{ class: "body" \}, m\.content\)/);
  });

  it("styles the customer on the left, the company side (seller and bot) on the right, and only system notices centred, using theme tokens only", () => {
    expect(css).toMatch(/\.msg-row\.seller,\s*\.msg-row\.bot\s*\{[^}]*flex-direction:\s*row-reverse/);
    expect(css).toMatch(/\.msg-row\.system\s*\{[^}]*justify-content:\s*center/);
    // A conversation made only of bot messages (the sessions that wait for review) must look like every other conversation.
    expect(css).not.toMatch(/\.msg-row\.bot[^{]*\{[^}]*justify-content:\s*center/);
    expect(css).not.toMatch(/\.msg-row\.bot \.msg[^{]*\{[^}]*dashed/);
    expect(css).toMatch(/\.msg-row\.bot \.who-av\s*\{[^}]*var\(--info-bg\)/);
    const block = css.slice(css.indexOf(".chat-head"), css.indexOf(".msg.hl"));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no hard-coded colours: it must follow the light and dark themes
  });
});

describe("human review screen", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("explains the three steps and that a decision never changes the original analysis", () => {
    expect(appJs).toContain("Como revisar");
    expect(appJs).toContain("A nota, o status e a rubrica originais não mudam.");
    expect(appJs).toMatch(/Abra a sessão\. /);
    expect(appJs).toMatch(/Leia a conversa\. /);
  });

  it("offers exactly the three decisions the server accepts", () => {
    for (const d of ["CONFIRMED", "DISAGREED", "REANALYSIS"]) expect(appJs).toMatch(new RegExp(`${d}: \\["`));
    expect(appJs).toContain('api("review.decide"');
  });

  it("asks for confirmation before recording (a decision cannot be changed) and sends the analysis id of the card, not a free value", () => {
    expect(appJs).toMatch(/confirmModal\("Registrar decisão\?"/);
    expect(appJs).toMatch(/analysisId: a\.analysis_id/);
  });

  it("requires a justification to disagree or ask for a new analysis, with the same minimum as the server (3 characters, 1000 max)", () => {
    expect(appJs).toMatch(/sel === "CONFIRMED" \|\| comment\.trim\(\)\.length >= 3/);
    expect(appJs).toContain("var MAX_REVIEW_COMMENT = 1000");
  });

  it("shows a read-only explanation to a Leitor instead of a form that would be refused", () => {
    expect(appJs).toMatch(/RANK\[state\.role\] < RANK\.EDITOR/);
    expect(appJs).toContain("só Editor ou Administrador registra a decisão");
  });

  it("renders the reviewer's comment as text and keeps the radios readable in the themes (no global input styling leaking in)", () => {
    expect(appJs).toMatch(/h\("blockquote", \{ class: "quote" \}, done\.comment\)/);
    expect(css).toMatch(/\.choice input\s*\{[^}]*border:\s*0/);
    expect(css).toMatch(/\.choice:has\(input:checked\)/);
  });
});

describe("rubric badge on the session page", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("is a real link to the exact rubric version, built with the same route the rubric list uses and with encoded parts", () => {
    expect(appJs).toMatch(/var href = "#\/rubrics\/" \+ encodeURIComponent\(rubricId\) \+ "\/" \+ encodeURIComponent\(String\(version\)\)/);
    expect(appJs).toMatch(/h\("a", \{ class: "badge link", href: href, onclick: function \(e\) \{ e\.stopPropagation\(\); go\(href\)\(e\); \}/);
  });

  it("is used in the summary, the analysis card and the review card", () => {
    expect(appJs.match(/rubricBadge\(/g)?.length).toBeGreaterThanOrEqual(4); // definition + summary + analysis + review
    expect(appJs).toMatch(/h\("h2", null, rubricBadge\(a\.rubric_id, a\.rubric_version\)/);
    expect(appJs).toContain('kv("Rubrica utilizada", rubricBadge(a.rubric_id, a.rubric_version))');
  });

  it("has an accessible name and a visible focus", () => {
    expect(appJs).toContain('"aria-label": "Rubrica "');
    expect(css).toMatch(/\.badge\.link:focus-visible/);
  });

  it("is reachable by every role that can open a session (the rubrics screen is open to VIEWER)", () => {
    expect(appJs).toMatch(/\["rubrics", "Rubricas", "VIEWER"/);
  });
});

describe("analysis card without criteria or approval", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("does not draw an empty table or a stray dash badge", () => {
    expect(appJs).toContain("Nenhum critério foi avaliado nesta análise");
    expect(appJs).toMatch(/kv\("Resultado", a\.approval_status \? badge\(a\.approval_status\) : "—"\)/);
  });
});

describe("sessions list: filters", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");

  it("has the channel, result and rubric filters next to status, period and id, and sends them to the server", () => {
    for (const label of ['fieldOf("Resultado"', 'fieldOf("Canal"', 'fieldOf("Rubrica"', 'fieldOf("Status"']) expect(appJs).toContain(label);
    expect(appJs).toMatch(/query\(extra\) \{ return Object\.assign\(\{ from: f\.from, to: f\.to, status: f\.status, result: f\.result, channel: f\.channel, rubric: f\.rubric, query: f\.query \}/);
  });

  it("offers only the results the engine can produce, with their Portuguese names", () => {
    for (const r of ["APPROVED", "REJECTED", "PENDING", "N_A"]) expect(appJs).toContain(`["${r}"`);
    expect(appJs).toMatch(/PENDING: \["Pendente", "warn"\], N_A: \["Não se aplica", ""\]/);
  });

  it("fills the rubric filter from the lightweight id list, not from the paged rubric list", () => {
    expect(appJs).toContain('api("rubrics.ids")');
  });
});

describe("shared pager component", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("pages with the cursor the server returns (never an offset or a page number), at 25, 50 or 100 rows by default", () => {
    expect(appJs).toContain("var PAGE_SIZES = [25, 50, 100]");
    expect(appJs).toMatch(/o\.load\(cursors\[idx\] \|\| null, size\)/);
    expect(appJs).not.toMatch(/offset:/i);
  });

  it("has previous, next, first and refresh with accessible names, and a polite live region for the range", () => {
    for (const label of ["Página anterior", "Próxima página", "Primeira página", "Atualizar esta página", "Linhas por página"]) expect(appJs).toContain(label);
    expect(appJs).toContain('role: "navigation", "aria-label": "Paginação"');
    expect(appJs).toContain('"aria-live": "polite"');
  });

  it("asks for the total only on demand (counting scans the whole set; paging does not) and forgets it when the filters change", () => {
    expect(appJs).toContain("Mostrar total");
    expect(appJs).toMatch(/o\.count && total === null/);
    expect(appJs).toMatch(/total = null/);
  });

  it("ignores a response that arrives after a newer request, and steps back if a page disappears", () => {
    expect(appJs).toMatch(/if \(my !== seq\) return/);
    expect(appJs).toMatch(/!res\.rows\.length && idx > 0/);
  });

  it("keeps the page, size and the caller's filters per workspace and per list, tolerating blocked storage", () => {
    expect(appJs).toMatch(/o\.t !== tenantKey\(\)/);
    expect(appJs).toMatch(/sizes\.indexOf\(o\.size\) < 0/);
    expect(appJs).toMatch(/catch \(e\) \{ return null; \}/);
    expect(appJs).toContain('sessionStorage.setItem("sci.pg." + key');
  });

  it("is pinned to the bottom of its card, themed, and the list dims (not jumps) while loading", () => {
    expect(css).toMatch(/\.pager\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0/);
    expect(css).toMatch(/\.pg-out\.loading\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.pager\.bare/);
  });

  it.each([
    ["sessions", "sessions.list", "sessions.count"],
    ["review", "review.list", "review.count"],
    ["runs", "runs.list", "runs.count"],
    ["rubrics", "rubrics.list", "rubrics.count"],
    ["users", "users.list", "users.count"],
    ["audit", "audit.list", "audit.count"],
  ])("the %s list uses the shared pager with %s and an on-demand %s", (key, list, count) => {
    expect(appJs).toContain(`key: "${key}"`);
    expect(appJs).toContain(`api("${list}"`);
    expect(appJs).toContain(`api("${count}"`);
  });

  it("counts the range in the page's own unit (rubrics, not their versions)", () => {
    expect(appJs).toMatch(/o\.unitsOf \? o\.unitsOf\(res\.rows\) : res\.rows\.length/);
    expect(appJs).toMatch(/unitsOf: function \(rows\) \{ return rows\.map\(function \(r\) \{ return r\.rubric_id; \}\)/);
  });

  it("no list view loads everything at once any more", () => {
    expect(appJs).not.toMatch(/api\("(runs|audit|users|rubrics|review)\.list", \{ (days: \d+, )?limit: \d{3}/);
  });
});


describe("table cells", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("never wrap: the table sits in a wrapper that scrolls horizontally", () => {
    expect(css).toMatch(/th, td \{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.scroll \{ overflow-x: auto; \}/);
  });

  it("no cell stacks a second line either (the decided-review cell keeps badge and reviewer on one line)", () => {
    const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
    expect(appJs).toMatch(/badge\(r\.decision\), h\("span", \{ class: "muted small"/);
    expect(appJs).not.toMatch(/badge\(r\.decision\), h\("div"/);
  });
});

describe("filter bar: one look for every list", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("every list with filters uses the shared bar (and none builds its own row of controls)", () => {
    expect(appJs.match(/= filterBar\(\{/g)?.length).toBe(5); // sessions, review, runs, execution requests, audit
    expect(appJs).not.toMatch(/class: "row", style: "margin-bottom:12px;align-items:flex-end"/);
    expect(appJs).not.toContain('class: "row filters"');
    expect(appJs).not.toContain('class: "period"');
  });

  it("labels every field above its control, including the segmented situation control", () => {
    expect(appJs).toContain('groupField("Situação", tabs)');
    expect(appJs).toMatch(/function daysSelect[\s\S]*class: "ffield"/);
    expect(css).toMatch(/\.ffield \{[^}]*flex-direction: column/);
  });

  it("gives every control the same height (36px, the segmented control included) and a Limpar filtros at the end", () => {
    expect(css).toMatch(/\.filterbar \.ffield select, \.filterbar \.ffield input \{[^}]*height: 36px/);
    expect(css).toMatch(/\.filterbar \.seg button \{ height: 34px; \}/); // 34 + the 1px borders = 36
    expect(appJs).toContain('"Limpar filtros"');
  });

  it("never squeezes a segmented control: it keeps the width of its options", () => {
    expect(appJs).toContain('class: "ffield fit", role: "group"');
    expect(css).toMatch(/\.ffield\.fit \{ flex: 0 0 auto; \}/);
  });

  it("enables Limpar filtros only when something differs from the defaults", () => {
    expect(appJs).toMatch(/clearBtn\.disabled = !o\.dirty\(\)/);
    expect(appJs).toContain('dirty: function () { return f.days !== 30; }');
    expect(appJs).toContain('dirty: function () { return f.filter !== "pending" || f.days !== 90; }');
    expect(appJs).toContain("dirty: isFiltered");
  });

  it("only the lists with text and date fields (sessions, run history, execution requests) have a Buscar button; the others apply as soon as a field changes", () => {
    expect(appJs).toMatch(/o\.onSubmit \? h\("button", \{ class: "btn primary", type: "submit" \}, "Buscar"\) : null/);
    expect(appJs.match(/onSubmit: function/g)?.length).toBe(3);
  });

  it("lays out the same way on a phone: one field per line", () => {
    expect(css).toMatch(/@media \(max-width: 760px\) \{ \.ffield, \.ffield\.fit \{ flex: 1 1 100%/);
  });
});

describe("sign out", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");

  it("is a button in the account menu, after confirmation, ending the Google session like the Cloud Console", () => {
    expect(appJs).toMatch(/icon\("logout", "sm"\), "Sair"/);
    expect(appJs).toMatch(/confirmModal\("Sair da conta Google\?"/);
    expect(appJs).toContain('window.open(logoutUrl(), "_top")');
    expect(appJs).toContain('"https://accounts.google.com/Logout"');
  });

  it("only asks to come back to a real Apps Script web app address, encoded, and otherwise just signs out", () => {
    const re = /var APP_URL = (\/.*\/);/.exec(appJs)?.[1] ?? "";
    const rx = new RegExp(re.slice(1, -1));
    expect(rx.test("https://script.google.com/a/macros/example.com/s/AKfycbyABC_def-123/exec")).toBe(true);
    expect(rx.test("https://script.google.com/macros/s/AKfycbyABC/exec")).toBe(true);
    for (const bad of ["http://script.google.com/macros/s/A/exec", "https://evil.example.com/macros/s/A/exec", "https://script.google.com.evil.example/macros/s/A/exec", "https://script.google.com/macros/s/A/exec?x=1", "javascript:alert(1)", "https://script.google.com/macros/s/A/exec#a b"]) expect(rx.test(bad), bad).toBe(false);
    expect(appJs).toContain('base + "?continue=" + encodeURIComponent(back)');
  });

  it("is placed at the end of the menu footer, next to the account link", () => {
    expect(appJs).toMatch(/class: "btn small signout"/);
  });
});


describe("criteria shown under the messages that evidence them", () => {
  const app = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("collects every criterion (with its weight) per evidenced message and renders badges below the body", () => {
    expect(app).toMatch(/\(highlight\[m\] = highlight\[m\] \|\| \[\]\)\.push\(\{[^}]*weight: c\.criterion_weight/s);
    expect(app).toMatch(/h\("div", \{ class: "body" \}, m\.content\),\s*ev \? criteriaBadges\(highlight\[m\.message_id\], rows\) : null/);
    expect(app).toMatch(/"peso " \+ fmtNum\(c\.weight\)/);
  });
  it("uses text nodes only (criterion ids and answers come from stored data)", () => {
    const fn = app.slice(app.indexOf("function criteriaBadges"), app.indexOf("function chatView"));
    expect(fn).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
  it("does not reuse the class of another component (`.crit` is the rubric editor card: it adds margin, border and padding)", () => {
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    const fn = app.slice(app.indexOf("function criteriaBadges"), app.indexOf("function chatView"));
    expect(fn).toContain('"badge crit-badge"');
    expect(fn).not.toMatch(/class: "[^"]*\bcrit\b[^-]/);
    expect(css).toMatch(/\.badge\.crit-badge \{/);
  });
});


describe("session summary card", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const fn = appJs.slice(appJs.indexOf("function summaryCard"), appJs.indexOf("function rubricBadge"));
  it("carries the rubric, the analysis status and the result of every analysis (one group per analysis)", () => {
    for (const label of ["Rubrica utilizada", "Status da análise", "Resultado", "Nota", "Modelo", "Prompt", "Modo", "Custo"]) expect(fn).toContain(`kv("${label}"`);
    expect(fn).toContain("reasonBlock(a)"); // the reason of the result is part of the summary, next to the result
    expect(fn).toContain("d.analyses.forEach");
    expect(fn).toContain("Sessão ainda não analisada.");
  });
  it("no longer repeats status and result badges in the analysis card header", () => {
    expect(appJs).toContain('d.analyses.length > 1 ? h("h2", null, rubricBadge(a.rubric_id, a.rubric_version)) : null');
    expect(appJs).not.toMatch(/h\("h2", null, rubricBadge\(a\.rubric_id, a\.rubric_version\), " ", badge\(a\.analysis_status\)/);
  });
  it("shows the rubric above the criteria list only when several analyses must be told apart (the summary already names it)", () => {
    const card = appJs.slice(appJs.indexOf("d.analyses.forEach(function (a) {\n        var crit"), appJs.indexOf("var evidenceCount"));
    expect((card.match(/rubricBadge\(/g) || []).length).toBe(1);
    expect(card).toMatch(/d\.analyses\.length > 1 \? h\("h2", null, rubricBadge/);
  });
  it("does not repeat the technical details or the reason in the analysis card", () => {
    const card = appJs.slice(appJs.indexOf("d.analyses.forEach(function (a) {\n        var crit"), appJs.indexOf("var evidenceCount"));
    expect(card).not.toMatch(/Modelo|Prompt:|reasonBlock/);
  });
  it("uses text nodes only", () => { expect(fn).not.toMatch(/innerHTML|insertAdjacentHTML/); });
});


describe("summary card alignment", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("uses one fixed column grid for every row so labels line up between rows, and collapses on narrow screens", () => {
    expect(css).toMatch(/\.summary-grid \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 1100px\) \{ \.summary-grid \{ grid-template-columns: repeat\(3/);
    expect(css).toMatch(/@media \(max-width: 560px\) \{ \.summary-grid \{ grid-template-columns: repeat\(2/);
    expect(css).not.toMatch(/auto-fit, minmax\(170px/);
  });
});


describe("evidence badges navigate to the message", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("the criteria table renders each evidence id as a button badge wired to the chat rows", () => {
    expect(appJs).toMatch(/render: function \(r\) \{ return evidenceLinks\(r\.evidence_message_ids, d\.messages, msgEls\); \}/);
    expect(appJs).toMatch(/h\("button", \{ type: "button", class: "badge link"/);
    expect(appJs).toContain("if (els) els[m.message_id] = row;");
    expect(appJs).toContain("chatView(d.messages, highlight, msgEls, critRows)");
  });
  it("never builds a selector from stored ids (rows are looked up in a map) and keeps router hashes untouched", () => {
    const fn = appJs.slice(appJs.indexOf("function goToMessage"), appJs.indexOf("function chatView"));
    expect(fn).not.toMatch(/querySelector|getElementById|location\.hash|innerHTML/);
  });
  it("is accessible and respects reduced motion", () => {
    expect(appJs).toContain('"aria-label": "Ir para a mensagem "');
    expect(appJs).toContain("prefers-reduced-motion: reduce");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.msg-row\.flash \.msg \{ animation: none/);
  });
  it("marks evidence outside the loaded messages as a plain, non-clickable badge", () => {
    expect(appJs).toContain("fora do trecho carregado da conversa");
  });
});


describe("evidence is shown by the criteria badges, in the evidence colour", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("the message header no longer carries a separate 'Evidência' badge", () => {
    const chat = appJs.slice(appJs.indexOf("function chatView"), appJs.indexOf("function parseJson"));
    expect(chat).not.toMatch(/"Evidência"/);
    expect(chat).toContain("criteriaBadges(highlight[m.message_id]");
  });
  it("criteria badges under a message use the warning colours of the highlighted bubble", () => {
    expect(css).toMatch(/\.badge\.crit-badge \{[^}]*background: var\(--warn-bg\); color: var\(--warn\)/);
    expect(css).toMatch(/\.msg\.hl \{ border-color: var\(--warn\)/);
  });
});


describe("criteria badges under a message navigate back to the criteria list", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("registers every criteria row by analysis and criterion, and wires the badge to its row", () => {
    expect(appJs).toContain("critRows[critKey(r.analysis_id, r.criterion_id)] = tr;");
    expect(appJs).toContain("key: critKey(c.analysis_id, c.criterion_id)");
    expect(appJs).toContain("criteriaBadges(highlight[m.message_id], rows)");
    expect(appJs).toMatch(/h\("button", \{ type: "button", class: "badge crit-badge"[^}]*onclick: function \(\) \{ jumpTo\(row\); \}/);
  });
  it("shares one jump helper with the message links (scroll, focus, flash) and never queries the DOM by stored ids", () => {
    expect(appJs).toContain("function jumpTo(el)");
    expect(appJs).toContain("function goToMessage(id, els) { if (els[id]) jumpTo(els[id]); }");
    const fn = appJs.slice(appJs.indexOf("function critKey"), appJs.indexOf("function chatView"));
    expect(fn).not.toMatch(/querySelector|getElementById|innerHTML|location\.hash/);
  });
  it("keys rows per analysis so two analyses with the same criterion do not collide, and falls back to a plain badge", () => {
    expect(appJs).toContain('String(analysisId) + "\\u0000" + String(criterionId)');
    expect(appJs).toMatch(/if \(!row\) return h\("span", \{ class: "badge crit-badge", title: tip \}, inner\)/);
  });
  it("flashes the row and respects reduced motion; the button is keyboard-visible", () => {
    expect(css).toMatch(/tr\.flash > td \{ animation: row-flash/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ tr\.flash > td \{ animation: none/);
    expect(css).toMatch(/button\.badge\.crit-badge:focus-visible/);
  });
});


describe("scope of the session view registries", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("chatView and the helpers only use what they receive: the registries live in the view closure (a free `critRows`/`msgEls` threw ReferenceError)", () => {
    for (const name of ["function chatView", "function criteriaBadges", "function evidenceLinks"]) {
      const start = appJs.indexOf(name);
      const body = appJs.slice(start, appJs.indexOf("\n  function ", start + 10));
      expect(body, name).not.toMatch(/\bcritRows\b|\bmsgEls\b/);
    }
    expect(appJs).toContain("chatView(d.messages, highlight, msgEls, critRows)");
  });
});


describe("session code in the summary card", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("is highlighted at the right of the card title, as text (the id comes from stored data)", () => {
    const fn = appJs.slice(appJs.indexOf("function summaryCard"), appJs.indexOf("function rubricBadge"));
    expect(fn).toMatch(/h\("div", \{ class: "card-head" \}, h\("h2", null, "Resumo"\),\s*h\("span", \{ class: "sid", title: "Código da sessão" \}[^]*s\.session_id/);
    expect(fn).not.toMatch(/innerHTML/);
    expect(css).toMatch(/\.card-head \{ display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap/);
    expect(css).toMatch(/\.sid \{[^}]*background: var\(--primary-container\)/);
  });
});


describe("client script", () => {
  it("is syntactically valid JavaScript (neither tsc nor the structural tests parse it)", () => {
    const src = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
    expect(() => new Function(src)).not.toThrow();
  });
});


describe("'Como funciona' page", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const page = appJs.slice(appJs.indexOf("var FLOW = ["), appJs.indexOf("// The human-review flow."));
  it("is in the menu for every role, under its own group", () => {
    expect(appJs).toContain('["how", "Como funciona", "VIEWER", "how", "Ajuda"]');
  });
  it("only reads: live numbers from pipeline.overview, the replay from sessions.get and rubrics.get (no AI, no write method)", () => {
    expect(page).toContain('api("pipeline.overview"');
    expect(page).toContain('api("sessions.get"');
    expect(page).toContain('api("rubrics.get"');
    expect(page).not.toMatch(/api\("(rubrics\.(save|publish|create)|review\.decide|users\.|sessions\.analy[sz]e)/);
  });
  it("covers the six replay steps and the seven flow stages, and each stage maps to a step", () => {
    expect((page.match(/\{ key: "/g) || []).length).toBe(7);
    expect(page).toMatch(/REPLAY_STEPS = \[(\s*\["[^"]+", "[^"]+"\],?){6}\s*\]/);
  });
  it("renders stored values as text and stops its timer when the page is left", () => {
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML/);
    expect(page).toContain("document.body.contains(replayBox)");
    expect(page).toContain("function stopTimer()");
  });
  it("states the guarantees it explains (score by rule, N/A is not zero, confidence is informative)", () => {
    expect(page).toContain("A confiança nunca entra na nota");
    expect(page).toContain("Não aplicável e sem evidência não valem zero");
    expect(page).toContain("Não chama a IA e não gera custo");
  });
});

describe("architecture view and the menu switch for 'Como funciona'", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("draws the architecture from the same read-only numbers, marks what is not active, and lights the component of the replay step", () => {
    expect(appJs).toContain("function archState(id, o)");
    expect(appJs).toContain("A arquitetura, ao vivo");
    expect(appJs).toContain('["Não ativado", "warn"');
    expect(appJs).toMatch(/n\.step === current\.step/);
    expect((appJs.match(/\{ id: "[a-z]+", lane:/g) || []).length).toBe(10);
  });
  it("is a real diagram: connectors measured from the boxes, flowing when both ends are in use, amber dashed when waiting, highlighted on hover/selection", () => {
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    expect(appJs).toContain("var ARCH_EDGES = [");
    expect((appJs.match(/^    \["[a-z]+", "[a-z]+", "/gm) || []).length + (appJs.match(/\["[a-z]+", "[a-z]+", "[^"]+"\]/g) || []).length).toBeGreaterThanOrEqual(10);
    expect(appJs).toContain("function drawEdges()");
    expect(appJs).toContain("getBoundingClientRect");
    expect(appJs).toMatch(/function edgeKind\(e\)[^]*"idle"[^]*"live"/);
    expect(appJs).toContain("function selectArch(id)");
    expect(appJs).toContain('"aria-pressed"');
    expect(css).toContain(".edge.live .ln");
    expect(css).toContain("@keyframes arch-flow");
    expect(css).toMatch(/\.edge\.live \.ln \{ animation: none; \}/);
    expect(css).toContain(".arch-wrap.stack .arch-svg { display: none; }");
    expect(appJs).toContain("ResizeObserver");
    expect(appJs).toMatch(/classList\.toggle\("stack", w < ARCH_MIN_WIDTH\)/);
    expect(appJs).toContain("if (!w || w < ARCH_MIN_WIDTH) return;");
  });
  it("uses the official product icons from assets/icons, embedded as data URIs (no external image), and a generic glyph for our own code", () => {
    expect(appJs).toContain("var PRODUCT_ICONS = {");
    expect((appJs.match(/data:image\/svg\+xml;base64,/g) || []).length).toBe(4);
    expect(appJs).toMatch(/var ARCH_ICON = \{ conversations: "bigquery"[^}]*event: "pubsub"[^}]*console: "appsscript" \}/);
    expect(appJs).toMatch(/var ARCH_GLYPH = \{ engine: "engine", budget: "gauge", openai: "bot" \}/);
    expect(appJs).not.toMatch(/src: "https?:/);
    for (const f of ["bigquery", "cloud-run", "pubsub", "apps-script"]) {
      expect(readFileSync(new URL(`../assets/icons/${f}.svg`, import.meta.url), "utf8")).toContain("<svg");
    }
    expect(readFileSync(new URL("../assets/icons/NOTICE.md", import.meta.url), "utf8")).toContain("cloud.google.com/icons");
  });
  it("splits the page into Fluxo | Arquitetura tabs (arrow keys, roving tabindex) and reuses the product icons on the flow stages", () => {
    expect(appJs).toContain('var HOW_TABS = ["Fluxo", "Arquitetura"]');
    expect(appJs).toContain("function showHowTab(i)");
    expect(appJs).toContain('role: "tab"');
    expect(appJs).toContain('"ArrowRight"');
    expect(appJs).toContain("window.requestAnimationFrame(relayoutArch)");
    expect(appJs).toMatch(/archPanel\.appendChild\(h\("div", \{ class: "card" \}, h\("h2", null, "A arquitetura, ao vivo"\)/);
    expect(appJs).toMatch(/flowPanel\.appendChild\(h\("div", \{ class: "card" \}, h\("h2", null, "O fluxo, ao vivo"\)/);
    expect(appJs).toMatch(/var FLOW_NODE = \{ source: "conversations", trigger: "historical", rubric: "rubrics", ai: "openai", score: "engine", result: "results", review: "console" \}/);
    expect(appJs).toContain("archIcon(FLOW_NODE[st.key])");
  });
  it("the flow stage header has its own class, not the app header's `.top` (which carried a background, border and sticky position)", () => {
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    expect(appJs).toContain('h("div", { class: "stage-head" }, h("div", { class: "n" }');
    expect(css).toContain(".stage .stage-head {");
    expect(css).not.toContain(".stage .top");
  });
  it("has a switch (role=switch) in the account menu that is saved per browser, hides the menu entry and the route, and never breaks without storage", () => {
    expect(appJs).toContain('role: "switch"');
    expect(appJs).toContain('localStorage.getItem("sci.how") !== "off"');
    expect(appJs).toMatch(/function navAllowed\(n\) \{[^}]*showHow\(\)/);
    expect(appJs).toContain("!navAllowed(item)");
    expect(appJs).toMatch(/function showHow\(\) \{ try \{[^}]*\} catch/);
  });
  it("rebuilds only the side menu when toggled, so the account menu stays open, and leaves the page if it was the hidden one", () => {
    expect(appJs).toContain("function drawNav()");
    expect(appJs).toMatch(/setShowHow\(next\);[^]*drawNav\(\);[^]*#\/dashboard/);
  });
});

describe("rubric badges in the lists", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("sessions, review queue and runs show the rubric as a link badge, not plain text", () => {
    expect((appJs.match(/\{ label: "Rubrica", render: function \(r\) \{ return (?:r\.rubric_id \? )?rubricBadge\(r\.rubric_id, r\.rubric_version\)/g) || []).length).toBe(3);
  });
  it("the badge does not also trigger the clickable row it sits in", () => {
    const fn = appJs.slice(appJs.indexOf("function rubricBadge"), appJs.indexOf("var ROLE_LABEL"));
    expect(fn).toContain("e.stopPropagation(); go(href)(e)");
    expect(fn).toMatch(/onkeydown: function \(e\) \{ e\.stopPropagation\(\); \}/);
  });
});

describe("sessions list default period", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("opens on the last 180 days (the dashboard counts by analysis day) and the dashboard says which day it counts", () => {
    expect(appJs).toContain("- 179 * 864e5");
    expect(appJs).toContain("período pelo dia da análise");
  });
});

describe("rubric editor: collapsible criteria", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const card = appJs.slice(appJs.indexOf("function critCard"), appJs.indexOf("function policyPanel"));
  it("each criterion has an always-visible header with a real button (aria-expanded/aria-controls) that opens the body", () => {
    expect(card).toContain('class: "crit-toggle"');
    expect(card).toContain('"aria-expanded"');
    expect(card).toContain('"aria-controls": "crit-body-" + i');
    expect(card).toContain("body.hidden = !isOpen");
  });
  it("the header summarises the criterion (name/id, type, weight, required, disabled, conditional) and follows edits", () => {
    for (const w of ['"peso "', '"Obrigatório"', '"Desabilitado"', '"Condicional"']) expect(card).toContain(w);
    expect(card).toContain("function set(k, v) { c[k] = v; dirty = true; drawHead(); }");
    expect(card).toContain("dirty = true; drawHead(); drawRule(); }");
  });
  it("starts collapsed, has expand-all/collapse-all, opens new criteria, and opens everything when there are pending issues; the open state is never saved", () => {
    expect(appJs).toContain("var openCrit = [];");
    expect(appJs).toContain('"Expandir todos"');
    expect(appJs).toContain('"Recolher todos"');
    expect(appJs).toContain("openCrit.push(nc)");
    expect(appJs).toMatch(/if \(issues && issues\.length\) openCrit = model\.criteria\.slice\(\)/);
    expect(appJs).not.toMatch(/c\.__open|criterion_open/);
  });
});

describe("switches instead of checkboxes", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("the rubric editor uses the switch component for Obrigatório, Habilitado and the applicability values", () => {
    expect(appJs).toContain('switchField("Obrigatório"');
    expect(appJs).toContain('switchField("Habilitado"');
    expect(appJs).toMatch(/return switchField\(k, cond\.equals\.indexOf\(k\) >= 0, ro,/);
  });
  it("the switch is still a real checkbox input with role=switch, and it is the only place a checkbox is created", () => {
    expect(appJs).toContain('type: "checkbox", role: "switch", class: "sw"');
    expect((appJs.match(/type: "checkbox"/g) || []).length).toBe(1);
  });
});

describe("criteria headers are aligned in columns", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("every header draws the same cells (empty ones kept) in a fixed grid, so columns line up across the list", () => {
    for (const c of ["crit-title", "crit-id", "crit-type", "crit-weight", "crit-flags"]) expect(appJs).toContain(`"${c}`);
    expect(css).toMatch(/\.crit-sum \{[^}]*display: grid; grid-template-columns: minmax\(0, 1fr\) 160px 86px 96px/);
  });
  it("the fields row centres switches and the remove button on the 36px inputs", () => {
    expect(css).toMatch(/\.crit \.top2 > \.check \{[^}]*height: 36px[^}]*align-items: center/);
  });
});

describe("applicability conditions are aligned", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("every condition line has the same four parts (connector, criterion, values, remove) and the add button sits under the criterion column", () => {
    expect(appJs).toContain('class: "rule-row"');
    expect(appJs).toContain('class: "rule-values"');
    expect(appJs).toContain("btn small rule-add");
    expect(css).toMatch(/\.rule-row \{ display: grid; grid-template-columns: 84px minmax\(160px, 260px\) minmax\(0, 1fr\) 36px; align-items: center/);
    expect(css).toContain(".rule-add { margin: 8px 0 0 96px;");
  });
  it("remove (x) buttons share the 36px danger style with a red hover and an accessible name", () => {
    expect(appJs.match(/class: "btn danger icon-x"/g)?.length).toBe(2);
    expect(appJs).toContain('"aria-label": "Remover opção"');
    expect(appJs).toContain('"aria-label": "Remover condição"');
    expect(css).toMatch(/\.btn\.icon-x \{ width: 36px; height: 36px;/);
    expect(css).toContain(".btn.icon-x:hover { background: var(--bad-bg);");
  });
});

describe("criteria list in the session detail", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it('shows "Name (identifier)", falling back to the identifier alone', () => {
    expect(appJs).toContain("function critLabel(r)");
    expect(appJs).toContain('"(" + r.criterion_id + ")"');
    expect(appJs).toContain('{ label: "Critério", render: function (r) { return critLabel(r); } }');
  });
});

describe("conversation bubbles", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("the automated agent (bot) sits on the company side like the seller, with its own tint, so a webchat answered by a bot is not one-sided", () => {
    expect(css).toContain(".msg-row.seller, .msg-row.bot { flex-direction: row-reverse; }");
    expect(css).toMatch(/\.msg-row\.bot \.msg \{[^}]*background: var\(--info-bg\)/);
    expect(css).toContain(".msg-row.seller .msg .meta, .msg-row.bot .msg .meta { color: inherit; }");
  });
});

describe("execution requests in the console (ADMIN only)", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("the page offers the request form and the queue only to administrators", () => {
    expect(appJs).toContain("var isAdmin = RANK[state.role] >= RANK.ADMIN");
    expect(appJs).toMatch(/if \(isAdmin\) \{ reqUi = execList\(reloadRequests\); reqPg = reqUi\.pg; panel = execPanel\(reloadRequests\); \}/);
    expect(appJs).toMatch(/isAdmin \? h\("button", \{ class: "btn primary"[^}]*panel\.open\(\)/);
    expect(appJs).toContain("if (!isAdmin) { root.appendChild(history); pg.start(); return; }"); // everyone else sees the history alone, no tabs
    expect(appJs).toContain('tabList(["Pedidos de execução", "Histórico de execução"], "Execuções", [requests, history])');
  });
  it("asks for an estimate first, then an explicit confirmation naming the ceiling, and sends confirm: true", () => {
    expect(appJs).toContain('api("executions.preview", body())');
    expect(appJs).toMatch(/confirmModal\("Pedir execução: "[^]*Você autoriza gastar até/);
    expect(appJs).toContain("b.confirm = true");
    expect(appJs).toContain("canRequest = !!pv && pv.within_ceiling && pv.to_process > 0");
    // the actions are in the card header, at the right corner, next to "Fechar"
    expect(appJs).toMatch(/h\("div", \{ class: "card-head" \}, h\("h2", null, "Nova execução"\),\s*h\("div", \{ class: "row" \}, h\("button", \{ class: "btn", type: "button", disabled: !ready, onclick: estimate \}[^]*canRequest \? h\("button", \{ class: "btn primary"[^]*onclick: request \}, "Pedir execução…"\) : null,\s*h\("button", \{ class: "btn text"[^]*"Fechar"/);
    expect(appJs).toContain("box.appendChild(out); // the estimate sits under the form");
  });
  it("never lets the page choose the model, prices or provider, and cancels only waiting requests after a confirmation", () => {
    const body = appJs.slice(appJs.indexOf("function body()"), appJs.indexOf("function changed()"));
    expect(body).not.toMatch(/model|provider|price/i);
    expect(appJs).toMatch(/r\.status === "REQUESTED" \? h\("button", \{ class: "btn small danger"/);
    expect(appJs).toContain('confirmModal("Cancelar pedido"');
  });
  it("labels the new statuses", () => {
    expect(appJs).toContain('REQUESTED: ["Aguardando executor", "warn"]');
    expect(appJs).toContain('CANCELLED: ["Cancelada", ""]');
  });
});

describe("Execuções page tabs", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("administrators get Pedidos | Histórico as an ARIA tablist with arrow keys; the queue is shown first and after a new or cancelled request", () => {
    expect(appJs).toContain("function tabList(names, label, panels)");
    expect(appJs).toMatch(/function tabList[^]*role: "tablist"[^]*role: "tab"[^]*"ArrowRight"[^]*role", "tabpanel"/);
    expect(appJs).toContain("function reloadRequests() { if (reqPg) { reqPg.reset(); } if (tabs) tabs.show(0); }");
    expect(appJs).toMatch(/tabs\.show\(0\);\s*reqPg\.start\(\);\s*pg\.start\(\);/);
  });
});

describe("run history filters", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const view = appJs.slice(appJs.indexOf("VIEWS.runs = function"), appJs.indexOf("VIEWS.rubrics = function"));
  it("filters by period, status, mode, rubric and run id, sent to the list and to the on-demand count", () => {
    for (const label of ['"De"', '"Até"', '"Status"', '"Modo"', '"Rubrica"', '"ID da execução"']) expect(view).toContain(`fieldOf(${label}`);
    expect(view).toContain('query({ limit: limit, cursor: cursor })');
    expect(view).toContain('api("runs.count", query({}))');
    expect(view).toMatch(/function query\(extra\) \{ return Object\.assign\(\{ from: f\.from, to: f\.to, status: f\.status, mode: f\.mode, rubric: f\.rubric, query: f\.query \}, extra\); \}/);
  });
  it("fills status, mode and rubric from what exists in the period, and offers Limpar filtros only when something is filtered", () => {
    expect(view).toContain('api("runs.facets", { from: f.from, to: f.to })');
    expect(view).toContain("dirty: isFiltered");
    expect(view).toContain('emptyState(isFiltered() ? "Nenhuma execução com estes filtros."');
  });
});

describe("execution request filters", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const view = appJs.slice(appJs.indexOf("function execList(onChange)"), appJs.indexOf("function tabList("));
  it("filters by period, status, type, rubric, requester and request id, sent with every page", () => {
    for (const label of ['"De"', '"Até"', '"Status"', '"Tipo"', '"Rubrica"', '"Pedido por"', '"ID do pedido"']) expect(view).toContain(`fieldOf(${label}`);
    expect(view).toMatch(/function query\(extra\) \{ return Object\.assign\(\{ from: f\.from, to: f\.to, status: f\.status, kind: f\.kind, rubric: f\.rubric, requested_by: f\.requested_by, query: f\.query \}, extra\); \}/);
    expect(view).toContain('api("executions.list", query({ limit: limit, cursor: cursor }))');
  });
  it("fills the options from the period, keeps Limpar filtros for when something is filtered, and sits in the requests tab", () => {
    expect(view).toContain('api("executions.facets", { from: f.from, to: f.to })');
    expect(view).toContain("dirty: isFiltered");
    expect(view).toContain('emptyState(isFiltered() ? "Nenhum pedido com estes filtros."');
    // like the history: the bar is above the card, outside it
    expect(appJs).toMatch(/h\("div", null, reqUi\.bar, h\("div", \{ class: "card" \}, h\("h2", null, "Pedidos de execução"\),[^]*reqPg\.el\)\);/);
  });
});

describe("run detail page", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const start = appJs.indexOf("function runDetail(root, runId)");
  const detail = appJs.slice(start, appJs.indexOf("VIEWS.runs = function"));
  it("a click on a run in the history opens #/runs/<id>, and the runs view routes there", () => {
    expect(appJs).toContain('function (r) { location.hash = "#/runs/" + encodeURIComponent(r.run_id); }');
    expect(appJs).toContain("VIEWS.runs = function (root, parts) {\n    if (parts && parts[0]) return runDetail(root, decodeURIComponent(parts[0]));");
  });
  it("explains the status, groups the failures by cause with what to do, and lists the failed sessions linking to each session", () => {
    expect(detail).toContain('api("runs.get", { run_id: runId })');
    expect(detail).toContain('api("runs.failures", { run_id: runId, limit: limit, cursor: cursor })');
    expect(detail).toContain("RUN_STATUS_HELP[r.run_status]");
    expect(detail).toContain('"Por que falhou"');
    expect(detail).toContain('href: "#/sessions/" + encodeURIComponent(x.session_id)');
  });
  it("says so honestly when an older run has no stored failure details, and shows no failure card for a clean run", () => {
    expect(detail).toContain("Os detalhes das falhas desta execução não foram guardados");
    expect(detail).toContain('"Esta execução não teve falhas."');
  });
  it("has a text and an action for every failure code the jobs can record", () => {
    const codes = ["PROVIDER_UNAVAILABLE", "PROVIDER_QUOTA", "PROVIDER_AUTH", "PROVIDER_REJECTED", "PROVIDER_CIRCUIT_OPEN", "INVALID_PROVIDER_RESPONSE", "INPUT_TOO_LARGE", "PROVIDER_ERROR", "RUBRIC_UNAVAILABLE", "QUERY_TOO_EXPENSIVE", "BIGQUERY_ERROR", "TIMEOUT", "UNEXPECTED"];
    for (const c of codes) expect(appJs, c).toMatch(new RegExp(`${c}: \\["[^"]+", "[^"]+"\\]`));
  });
});

describe("architecture lanes", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it('has the lanes Origem dos dados | Disparo | Regras e processamento | Saída, with the rubrics right above the evaluation engine', () => {
    expect(appJs).toContain('var ARCH_LANES = ["Origem dos dados", "Disparo", "Regras e processamento", "Saída"];');
    const order = [...appJs.slice(appJs.indexOf("var ARCH = ["), appJs.indexOf("var ARCH_ICON") > 0 ? appJs.indexOf("// <icons>") : undefined).matchAll(/\{ id: "([a-z]+)", lane: (\d)/g)].map((m) => [m[1], Number(m[2])]);
    const processing = order.filter(([, lane]) => lane === 2).map(([id]) => id);
    expect(processing.slice(0, 2)).toEqual(["rubrics", "engine"]);
    expect(order.filter(([, lane]) => lane === 1).map(([id]) => id)).toEqual(["historical", "live"]);
  });
});

describe("architecture alignment", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("places every component on a grid row so that components that feed each other sit on the same line", () => {
    const rows = JSON.parse(appJs.match(/var ARCH_ROW = (\{[^}]*\});/)![1]!.replace(/([a-z]+):/g, '"$1":'));
    const ids = [...appJs.matchAll(/\{ id: "([a-z]+)", lane:/g)].map((m) => m[1]);
    expect(Object.keys(rows).sort()).toEqual([...ids].sort());
    for (const chain of [["conversations", "historical", "engine", "results"], ["event", "live", "budget", "console"]]) {
      expect(new Set(chain.map((id) => rows[id as string])).size, chain.join(" > ")).toBe(1);
    }
    expect(rows.rubrics).toBeLessThan(rows.engine); // the rules sit right above the engine
  });
  it("uses one grid with equal-height rows in the wide layout and falls back to stacked lanes on narrow areas", () => {
    expect(appJs).toContain('style: "--c:" + (li + 1) + ";--r:" + (ARCH_ROW[n.id] + 1)');
    expect(css).toContain(".arch-wrap:not(.stack) .arch { grid-template-rows: auto repeat(4, 1fr);");
    expect(css).toContain(".arch-wrap:not(.stack) .lane { display: contents; }");
    expect(css).toContain(".arch-wrap:not(.stack) .lane-t, .arch-wrap:not(.stack) .node { grid-column: var(--c); grid-row: var(--r); }");
    expect(css).toContain(".arch-wrap.stack .lane { gap: 10px; }"); // stacked lanes keep their own flow
  });
});

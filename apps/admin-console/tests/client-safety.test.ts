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
    expect(appJs).toContain("criteriaBadges(highlight[m.message_id])");
  });

  it("puts the message text in a text node (never markup), so conversation content cannot inject HTML", () => {
    expect(appJs).toMatch(/h\("div", \{ class: "body" \}, m\.content\)/);
  });

  it("styles customer and bot as bubbles on the left, seller on the right, and only system notices centred, using theme tokens only", () => {
    expect(css).toMatch(/\.msg-row\.seller\s*\{[^}]*flex-direction:\s*row-reverse/);
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
    expect(appJs).toMatch(/h\("a", \{ class: "badge link", href: href, onclick: go\(href\)/);
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
    expect(appJs.match(/= filterBar\(\{/g)?.length).toBe(4); // sessions, review, runs, audit
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

  it("only the sessions list needs a Buscar button (text and date fields); the others apply as soon as a field changes", () => {
    expect(appJs).toMatch(/o\.onSubmit \? h\("button", \{ class: "btn primary", type: "submit" \}, "Buscar"\) : null/);
    expect(appJs.match(/onSubmit: function/g)?.length).toBe(1);
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
    expect(app).toMatch(/h\("div", \{ class: "body" \}, m\.content\),\s*ev \? criteriaBadges\(highlight\[m\.message_id\]\) : null/);
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
    expect(appJs).toMatch(/h\("h2", null, rubricBadge\(a\.rubric_id, a\.rubric_version\)\),/);
    expect(appJs).not.toMatch(/h\("h2", null, rubricBadge\(a\.rubric_id, a\.rubric_version\), " ", badge\(a\.analysis_status\)/);
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
    expect(appJs).toContain("chatView(d.messages, highlight, msgEls)");
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
    expect(chat).toContain("criteriaBadges(highlight[m.message_id])");
  });
  it("criteria badges under a message use the warning colours of the highlighted bubble", () => {
    expect(css).toMatch(/\.badge\.crit-badge \{[^}]*background: var\(--warn-bg\); color: var\(--warn\)/);
    expect(css).toMatch(/\.msg\.hl \{ border-color: var\(--warn\)/);
  });
});

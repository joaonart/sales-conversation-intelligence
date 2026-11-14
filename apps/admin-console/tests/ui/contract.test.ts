import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildUi } from "../../scripts/build-ui.mjs";
import { DECISION_INFO, MAX_REVIEW_COMMENT } from "../../src/ui/lib/evidence";
import { ARCH, ARCH_EDGES, RES_GROUPS, RES_SECTIONS, REPLAY_STEPS } from "../../src/ui/lib/howData";
import { FAILURE_CODES } from "../../src/ui/lib/executions";
import { PRODUCT_ICONS } from "../../src/ui/lib/productIcons";
import { DEFAULT_SUMMARY_PROMPT } from "../../src/ui/lib/summaryPrompt";
import { STATUS } from "../../src/ui/components/Badge";
import { AUDIT_ACTION } from "../../src/ui/views/AuditView";
import { DECISIONS } from "../../src/server/services/reviews";
import { MAX_SUMMARY_PROMPT } from "../../src/server/types";

const here = (p: string) => new URL(`../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(here(p), "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const uiFiles = walk(fileURLToPath(new URL("../../src/ui", import.meta.url))).filter((f) => /\.(ts|tsx)$/.test(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const uiCode = uiFiles.filter((f) => !f.endsWith("productIcons.ts")).map((f) => [f, strip(readFileSync(f, "utf8"))] as const);
const html = read("src/ui/index.html");

describe("the client cannot turn data into markup or code", () => {
  it.each([
    ["innerHTML assignment", /\.innerHTML\s*=/],
    ["outerHTML assignment", /\.outerHTML\s*=/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
    ["document.write", /document\.write/],
    ["eval", /\beval\s*\(/],
    ["new Function", /new\s+Function\s*\(/],
    ["string timers", /set(Timeout|Interval)\s*\(\s*["'`]/],
    ["external scripts or styles", /https?:\/\/[^"'\s]+\.(js|css)\b/],
    ["a javascript: url", /["'`]javascript:/],
  ])("has no %s", (_n, re) => {
    for (const [f, code] of uiCode) expect(code, f).not.toMatch(re);
  });

  it("the page template pulls in nothing from other origins and declares no <base> (links stay inside the sandboxed iframe)", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toMatch(/<base\b/i);
  });

  it("no stylesheet pulls a font or an image from another origin", () => {
    expect(read("src/ui/styles/app.css")).not.toMatch(/@import\s+url|url\(\s*["']?https?:/);
  });

  it("navigation only sets the hash: nothing assigns the address of the window, and only the account menu opens another window", () => {
    for (const [f, code] of uiCode) {
      expect(code, f).not.toMatch(/location\.(href|assign|replace)\s*[=(]/);
      expect(code, f).not.toMatch(/target=["']_top["']/);
    }
    expect(uiCode.filter(([, c]) => /window\.open\(/.test(c)).map(([f]) => f.split("/").pop())).toEqual(["AccountMenu.tsx"]);
    const menu = uiCode.find(([f]) => f.endsWith("AccountMenu.tsx"))?.[1] ?? "";
    expect(menu).toContain('window.open("https://myaccount.google.com/", "_blank", "noopener")');
    expect(menu).toContain('window.open(logoutUrl(me.app_url), "_top")');
  });

  it("never reads identity or tenant from the URL for authorisation", () => {
    for (const [f, code] of uiCode) expect(code, f).not.toMatch(/location\.search|URLSearchParams/);
  });

  it("storage holds only per-browser conveniences under known keys", () => {
    const keys = new Set<string>();
    for (const [, code] of uiCode) for (const m of code.matchAll(/(?:readStore|writeStore)\(\s*"(?:local|session)"\s*,\s*(?:"([^"]+)"|`([^`$]+))/g)) keys.add((m[1] ?? m[2] ?? "").replace(/\.$/, ""));
    for (const m of uiCode.map(([, c]) => c).join("\n").matchAll(/const \w*KEY\w* = "([^"]+)"/g)) keys.add(m[1] ?? "");
    expect(keys.size).toBeGreaterThanOrEqual(5); // the scan really finds the keys
    const allowed = ["sci.theme", "sci.nav", "sci.how", "sci.tenant", "sci.critnames", "sci.page"];
    for (const k of keys) expect(allowed.some((a) => k === a || k.startsWith(`${a}.`)), k).toBe(true);
  });
});

describe("no flash of the wrong theme while loading", () => {
  it("applies the pinned theme from the <head>, before the stylesheet, and declares the colour schemes up front", () => {
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    const script = head.indexOf("<script>");
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(head.indexOf("include('styles')")); // the attribute is already there when the first rule is evaluated
    expect(head).toMatch(/<meta name="color-scheme" content="light dark"/);
    expect(head).toMatch(/localStorage\.getItem\("sci\.theme"\)/);
    expect(head).toMatch(/setAttribute\("data-theme", t\)/);
    expect(head).toMatch(/catch \(e\)/); // storage can be blocked in the sandbox
  });
  it("uses the same storage key as the toggle", () => {
    expect(read("src/ui/lib/theme.ts")).toContain('const KEY = "sci.theme"');
  });
  it("the template keeps the entry points the server fills in", () => {
    expect(html).toContain("<?!= include('styles') ?>");
    expect(html).toContain("<?!= include('app') ?>");
    expect(html).toContain('data-version="<?= appVersion ?>"');
    expect(html).toContain('<div id="app"');
  });
});

describe("what the screens offer is what the server accepts", () => {
  it("offers exactly the decisions the server accepts, with the server's comment limit", () => {
    expect(Object.keys(DECISION_INFO).sort()).toEqual([...DECISIONS].sort());
    expect(read("src/server/services/reviews.ts")).toContain(`const MAX_COMMENT = ${MAX_REVIEW_COMMENT};`);
    expect(read("src/server/services/reviews.ts")).toMatch(/min: decision === "CONFIRMED" \? 0 : 3/); // the form's own minimum is 3 characters
  });

  it("the general evaluation's limit equals the platform's, and the suggested text fits it", () => {
    const python = readFileSync(new URL("../../../../packages/evaluation-core/src/sci_core/rubric.py", import.meta.url), "utf8");
    expect(MAX_SUMMARY_PROMPT).toBe(Number(python.match(/MAX_SUMMARY_PROMPT_CHARS = (\d+)/)?.[1]));
    expect(DEFAULT_SUMMARY_PROMPT.length).toBeLessThan(MAX_SUMMARY_PROMPT);
  });

  it("labels every status the server and the jobs can send, in Portuguese", () => {
    const needed = [
      "COMPLETED", "NEEDS_REVIEW", "NOT_EVALUABLE", "FAILED", "APPROVED", "REJECTED", "DRAFT", "PUBLISHED", "RUNNING", "BUDGET_STOPPED", "COMPLETED_WITH_FAILURES", "SESSION_GATE_STOPPED",
      "SUCCESS", "DENIED", "ERROR", "ACTIVE", "DISABLED", "APPLICABLE", "NOT_APPLICABLE", "INSUFFICIENT_EVIDENCE", "PENDING", "N_A", "REQUESTED", "CANCELLED", "PENDING_REVIEW", "CONFIRMED",
      "DISAGREED", "REANALYSIS", "EVALUATED", "DUPLICATE_CONTENT", "NO_MESSAGES", "SESSION_NOT_FOUND", "RATE_LIMITED", "BUDGET_BLOCKED", "TOKEN_LIMIT", "ROUTED_SKIP",
    ];
    for (const k of needed) expect(STATUS[k]?.[0], k).toBeTruthy();
    expect(STATUS.PENDING).toEqual(["Pendente", "warn"]);
    expect(STATUS.N_A).toEqual(["Não se aplica", "neutral"]);
    expect(STATUS.REQUESTED).toEqual(["Aguardando worker", "warn"]);
    expect(STATUS.CANCELLED).toEqual(["Cancelada", "neutral"]);
  });

  it("explains every failure cause with a text and an action", () => {
    expect(Object.keys(FAILURE_CODES)).toHaveLength(13);
    for (const [code, [what, todo]] of Object.entries(FAILURE_CODES)) {
      expect(what.length, code).toBeGreaterThan(10);
      expect(todo.length, code).toBeGreaterThan(10);
    }
  });
});

describe("the page about the architecture describes what is implemented", () => {
  const data = read("src/ui/lib/howData.ts");
  const node = (id: string) => ARCH.find((n) => n.id === id);
  const edge = (a: string, b: string) => ARCH_EDGES.find((e) => e[0] === a && e[1] === b);

  it("shows the live path that really exists: the event, the worker, the wait queue (Cloud Tasks) and the dead-letter safety net", () => {
    expect(node("queue")).toMatchObject({ lane: 1, title: "Fila de espera", where: "Cloud Tasks · sci-{env}-live-eval" });
    expect(data).toContain("-dlq), guardada por 7 dias");
    expect(data).toContain("Até 8 tentativas se algo falhar.");
    expect(edge("live", "queue")).toEqual(["live", "queue", "agenda · chama depois da espera", "both"]); // the worker schedules AND is called back
  });

  it("shows the executor of the console requests and does not present the historical job as deployed when it is not", () => {
    expect(node("executor")).toMatchObject({ lane: 1, title: "Worker sob demanda", where: "Cloud Run Job · sci-{env}-executor · acordado pelo Cloud Scheduler (sci-{env}-executor-poll)" });
    expect(node("schedules")).toMatchObject({ lane: 1, title: "Agendas", where: "Console · BigQuery" });
    expect(edge("schedules", "executor")?.[2]).toBe("cria os pedidos no horário");
    expect(edge("conversations", "executor")?.[2]).toBe("lê as sessões do pedido");
    expect(edge("executor", "engine")?.[2]).toBe("pedidos do console");
    expect(node("ingest")).toMatchObject({ where: "Cloud Run · sci-{env}-ingest" });
    expect(node("live")).toMatchObject({ where: "Cloud Run · sci-{env}-live" });
    expect(node("inbox")).toMatchObject({ lane: 0, title: "Conversas recebidas", where: "Pub/Sub · sci-{env}-conversations" });
    expect(node("inbox")?.text).toContain("sci-{env}-conversations-dlq");
    expect(node("event")).toMatchObject({ where: "Pub/Sub · sci-{env}-session-updates" });
    expect(node("event")?.text).toContain("sci-{env}-session-updates-dlq");
    expect(node("inbox")?.text).toContain("quem valida e grava no BigQuery é a ingestão");
    expect(edge("inbox", "ingest")?.[2]).toBe("entrega a conversa (push)");
    expect(edge("ingest", "conversations")?.[2]).toBe("grava a conversa");
    expect(edge("ingest", "event")).toEqual(["ingest", "event", "publica o evento", "detour"]); // runs down the margin: a straight line would cross Conversas
    expect(node("historical")).toBeUndefined(); // the historical batch is what the on-demand worker runs, not a component of its own
    expect(node("executor")?.text).toContain("inclusive o processamento histórico");
    expect(node("executor")?.text).toContain("um Cloud Run Job só para o histórico existe no Terraform, mas não foi implantado");
    expect(ARCH.filter((n) => n.lane === 1).map((n) => n.title)).toEqual(["Agendas", "Worker sob demanda", "Worker ao vivo", "Fila de espera"]);
  });

  it("describes the AI honestly: only the Responses API cites messages, the Decisions API does not, and the key lives in Secret Manager", () => {
    const ai = node("openai")?.text ?? "";
    expect(ai).toContain("A Responses API cita as mensagens que sustentam a resposta. A Decisions API não devolve citações: no ao vivo, uma segunda chamada opcional (a etapa de evidências, com outro modelo da lista) as obtém.");
    expect(ai).toContain("Secret Manager");
    expect(ai).toContain("escolhe a rubrica de cada sessão (roteamento) e escreve a avaliação geral");
    expect(data).not.toContain("Só responde cada critério e cita as mensagens.");
    expect(data).not.toContain("e cita as mensagens que o comprovam");
    expect(data).not.toContain("devolve a resposta e as mensagens que a sustentam.");
    expect(data).not.toMatch(/Só a Responses API (cita|aponta)/);
  });

  it("describes the cost ceiling for both modes (request ceiling, and the monthly cap for live and the executor)", () => {
    expect(node("budget")?.text).toContain("o teto do pedido ou da execução e, no worker ao vivo e no worker sob demanda, também o teto mensal de IA do workspace, somado a tudo o que foi pago no mês");
  });

  it("explains the queue in plain words (no jargon)", () => {
    expect(node("queue")?.text).toContain("viram uma só tarefa, que chama o worker uma espera depois que a janela termina, ou seja, entre 1 e 2 vezes a espera (60 a 120 segundos no dev). Assim uma rajada de avisos é analisada uma vez só.");
    expect(data).not.toMatch(/assent/i);
  });

  it("what the replay says about the AI and the masking matches the implementation", () => {
    const steps = REPLAY_STEPS.map((s) => s.join(" ")).join(" ");
    expect(steps).toContain("A Responses API cita, na própria resposta, as mensagens que a sustentam. A Decisions API (a padrão) não devolve citações: no ao vivo, uma segunda chamada opcional (a etapa de evidências) as obtém, só para as respostas que afirmam algo.");
    expect(steps).toContain("mascarados antes de irem para a IA e ao serem mostrados no console");
    expect(steps).not.toContain("mascarados antes de qualquer leitura");
  });

  it("describes the alerts and the budget as Terraform defines them", () => {
    expect(data).toContain("esperando há mais de 10 minutos");
    expect(data).toContain("também quando a previsão do mês passa de 100%");
  });

  it("the resource list declares its two sections with their tabs, and each group joins a section, a tab and (BigQuery) a dataset", () => {
    expect(RES_SECTIONS.bigquery?.tabs).toEqual([["tables", "Tabelas"], ["views", "Views"]]);
    expect(RES_SECTIONS.identity?.tabs).toEqual([["secrets", "Segredos"], ["identity", "Identidade"]]);
    const joined = (id: string) => RES_GROUPS.find((g) => g.id === id);
    for (const [id, tab, ds] of [["bq-source", "tables", "commerce"], ["bq-config", "tables", "conversation_config"], ["bq-results", "tables", "conversation_analytics"], ["bq-views", "views", "conversation_analytics"]])
      expect(joined(id!)).toMatchObject({ section: "bigquery", tab, dataset: ds });
    for (const [id, tab] of [["sec-secrets", "secrets"], ["sec-accounts", "identity"], ["sec-roles", "identity"], ["sec-federation", "identity"]]) expect(joined(id!)).toMatchObject({ section: "identity", tab });
  });
});

describe("the official product marks", () => {
  it("embeds six data URIs (four products and the OpenAI mark in two colours), each the official file unmodified, and no external image", () => {
    expect(Object.keys(PRODUCT_ICONS).sort()).toEqual(["appsscript", "bigquery", "cloudrun", "openai", "openaidark", "pubsub"]);
    for (const v of Object.values(PRODUCT_ICONS)) expect(v).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
    for (const [key, file] of [["openai", "OAI_OpenAI-Blossom_Black.svg"], ["openaidark", "OAI_OpenAI-Blossom_White.svg"]] as const)
      expect(Buffer.from((PRODUCT_ICONS[key] as string).split(",")[1] as string, "base64").toString("utf8")).toBe(read(`assets/icons/${file}`));
    for (const f of ["bigquery", "cloud-run", "pubsub", "apps-script"]) expect(read(`assets/icons/${f}.svg`)).toContain("<svg");
    expect(read("assets/icons/NOTICE.md")).toContain("cloud.google.com/icons");
  });
  it("the black and the white OpenAI mark swap by theme, so the mark is visible in every theme", () => {
    const css = read("src/ui/styles/app.css");
    expect(css).toContain(".pi-dark {\n  display: none;");
    expect(css).toContain(':root:not([data-theme="light"]) .pi-light');
    expect(css).toContain(':root[data-theme="dark"] .pi-light');
  });
});

describe("the server answers what the screens read", () => {
  const readTs = read("src/server/services/read.ts");
  it("the cost of each model comes from the same table and tenant filter as the total", () => {
    expect(readTs).toContain("SUM(cost_usd) AS cost_usd FROM ${this.t.dailyCost} WHERE ${TENANT} GROUP BY model, analysis_mode ORDER BY cost_usd DESC");
  });
  it("the architecture numbers come from tenant-scoped, read-only queries", () => {
    expect(readTs).toContain("COUNT(DISTINCT rubric_id) AS total, COUNT(DISTINCT IF(status = 'PUBLISHED', rubric_id, NULL)) AS published FROM ${this.t.rubrics} WHERE ${TENANT}");
    expect(readTs).toContain("SELECT COUNT(*) AS runs FROM ${this.t.runs} WHERE ${TENANT} AND processing_mode = 'historical'");
    expect(readTs).toContain("processing_mode = 'live' GROUP BY run_status");
  });
});

describe("the preview mock follows the same contract", () => {
  const mock = read("preview/mock.js");
  it("answers the model catalog, the score by grain and the efficiency by model", () => {
    expect(mock).toContain('"executions.models": function () { return MODEL_CATALOG; }');
    expect(mock).toContain('"dashboard.score": function (p)');
    expect(mock).toMatch(/models: \[\{ provider: "responses", model: "gpt-4o"/);
  });
});

describe("package.json stays installable", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const lock = JSON.parse(read("package-lock.json")) as { packages?: Record<string, { version?: string }> };
  it("every dependency range is satisfied by the version in the lockfile (a release bump must not touch dependency ranges)", () => {
    // `npm ci` fails in CI when package.json and the lock disagree; a blind search-and-replace of the app version once rewrote the esbuild range.
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      expect(locked, `${name} is missing from the lockfile`).toBeDefined();
      const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
      if (!m) {
        expect(locked, `${name}: pinned ${range}`).toBe(range); // an exact range must be exactly what the lock holds
        continue;
      }
      const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const [lmaj = 0, lmin = 0, lpat = 0] = (locked as string).split(".").map(Number);
      const ok = maj > 0 ? lmaj === maj && (lmin > min || (lmin === min && lpat >= pat)) : lmaj === 0 && lmin === min && lpat >= pat;
      expect(ok, `${name}: ${range} is not satisfied by locked ${locked}`).toBe(true);
    }
  });
  it("the client libraries are build-time only: nothing is loaded from a CDN", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["preact"]);
  });
});

describe("the built client", () => {
  it("is one script and one stylesheet that Apps Script can inline, within the size budget", async () => {
    const { js, css } = await buildUi({ minify: true });
    expect(() => new Function(js)).not.toThrow(); // neither tsc nor the unit tests parse the bundle
    expect(js).not.toMatch(/<\/script|<!--/); // would end the inline <script> early
    expect(css).not.toMatch(/<\/style/);
    expect(js.length).toBeLessThan(280_000); // the legacy client was 272 KB
    expect(css.length).toBeLessThan(60_000);
    for (const util of ["bg-surface", "text-fg", "border-line", "rounded-card"]) expect(css, util).toContain(util.replace(/^(bg|text|border)-/, ""));
  }, 60_000);
});

describe("the words on the screens match what the platform does", () => {
  it("every action the server writes to the audit log has a label in Auditoria", () => {
    const rpc = read("src/server/rpc.ts");
    const audited = [...rpc.matchAll(/"([a-zA-Z]+\.[a-zA-Z]+)": \{\s*min: "[A-Z]+", write: true/g)].map((m) => m[1] as string);
    expect(audited.length).toBeGreaterThanOrEqual(10);
    expect(audited.filter((a) => !AUDIT_ACTION[a])).toEqual([]);
  });

  it("the review decision 'new analysis' is a recommendation: it says the analysis is requested in Execuções", () => {
    expect(DECISION_INFO.REANALYSIS?.[0]).toBe("Recomendar nova análise");
    expect(DECISION_INFO.REANALYSIS?.[1]).toContain("a nova análise é pedida em Execuções");
    expect(STATUS.REANALYSIS).toEqual(["Reanálise recomendada", "info"]);
  });

  it("the Sessões filter offers no status that is never stored (a failed analysis is never written)", () => {
    expect(read("src/ui/views/SessionsView.tsx")).not.toContain('["FAILED"');
  });

  it("the cost of the Painel says what it sums: the stored analyses, not everything paid", () => {
    const dash = read("src/ui/views/DashboardView.tsx");
    expect(dash).toContain("Custo das análises gravadas no período");
    expect(dash).not.toContain("Tudo o que foi pago");
  });
});

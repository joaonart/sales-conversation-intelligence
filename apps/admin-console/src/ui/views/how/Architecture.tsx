import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Badge, type Tone } from "../../components/Badge";
import { Card } from "../../components/Card";
import { ProductIcon } from "../../components/ProductIcon";
import type { IconName } from "../../components/icons";
import { ARCH, ARCH_EDGES, ARCH_LANES, ARCH_ROW, type ArchEdge, type ArchNode } from "../../lib/howData";
import { archState, currentAnalyses } from "../../lib/pipelineState";
import { cx } from "../../lib/cx";
import { fmtInt } from "../../lib/format";
import type { PipelineOverview } from "../../lib/types";
import { API_LABEL, PROC_MODE } from "../../lib/executions";
import { fmtUsd } from "../../lib/format";
import { DataTable } from "../../components/DataTable";

/** Below this width the four columns do not fit: the components stack and the connectors are hidden. */
export const ARCH_MIN_WIDTH = 900;
const MARK: Record<string, string> = { conversations: "bigquery", rubrics: "bigquery", results: "bigquery", live: "cloudrun", ingest: "cloudrun", executor: "cloudrun", inbox: "pubsub", event: "pubsub", console: "appsscript", openai: "openai" };
const GLYPH: Record<string, IconName> = { engine: "engine", budget: "gauge", queue: "clock", schedules: "clock" };
const TONE: Record<string, Tone> = { "": "neutral", ok: "ok", warn: "warn", info: "info" };
const byId = (id: string): ArchNode | undefined => ARCH.find((n) => n.id === id);

interface DrawnEdge {
  edge: ArchEdge;
  d: string;
  heads: string[];
  lx: number;
  ly: number;
  anchor: "start" | "middle";
  rotate: boolean;
}
interface Box { l: number; r: number; t: number; b: number; cx: number; cy: number }

/** The path, arrowheads and label of a connector between two measured boxes. */
export function drawEdge(edge: ArchEdge, a: Box, b: Box): DrawnEdge {
  const kind = edge[3];
  if (kind === "detour") {
    // Two components of the same column with another one between them: the line leaves the left side of the first, runs down the margin of the
    // column and enters the left side of the second, so it never crosses the component in between.
    const x0 = a.l - 14;
    const d = `M${a.l} ${a.cy} H${x0 + 8} Q${x0} ${a.cy} ${x0} ${a.cy + 8} V${b.cy - 8} Q${x0} ${b.cy} ${x0 + 8} ${b.cy} H${b.l}`;
    return { edge, d, heads: [[b.l, b.cy, b.l - 8, b.cy - 4, b.l - 8, b.cy + 4].join(" ")], lx: x0 - 5, ly: (a.cy + b.cy) / 2, anchor: "middle", rotate: true };
  }
  if (Math.abs(a.cx - b.cx) < 10) {
    const heads = [[b.cx, b.t, b.cx - 4, b.t - 8, b.cx + 4, b.t - 8].join(" ")];
    if (kind === "both") heads.push([a.cx, a.b, a.cx - 4, a.b + 8, a.cx + 4, a.b + 8].join(" ")); // the worker schedules AND is called back: a head at each end
    return { edge, d: `M${a.cx} ${a.b} L${b.cx} ${b.t}`, heads, lx: a.cx + 10, ly: (a.b + b.t) / 2 + 4, anchor: "start", rotate: false };
  }
  const dx = (b.l - a.r) / 2;
  return {
    edge,
    d: `M${a.r} ${a.cy} C${a.r + dx} ${a.cy} ${b.l - dx} ${b.cy} ${b.l} ${b.cy}`,
    heads: [[b.l, b.cy, b.l - 8, b.cy - 4, b.l - 8, b.cy + 4].join(" ")],
    lx: (a.r + b.l) / 2,
    ly: (a.cy + b.cy) / 2 - 6,
    anchor: "middle",
    rotate: false,
  };
}

function ModelCosts({ models, current }: { models: NonNullable<PipelineOverview["models"]>; current: number }) {
  const sum = (f: "analyses" | "cost_usd") => models.reduce((a, m) => a + (Number(m[f]) || 0), 0);
  const executed = sum("analyses");
  return (
    <div class="mt-3">
      <div class="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Gasto por modelo</div>
      <DataTable
        caption="Gasto por modelo"
        rows={models}
        rowKey={(m) => `${m.provider}|${m.model}|${m.analysis_mode}`}
        columns={[
          { header: "API", cell: (m) => API_LABEL[m.provider] ?? "—" },
          { header: "Modelo", cell: (m) => <span class="font-mono text-xs">{m.model || "—"}</span> },
          { header: "Modo", cell: (m) => PROC_MODE[m.analysis_mode] ?? m.analysis_mode ?? "—" },
          { header: "Executadas", align: "right", cell: (m) => fmtInt(Number(m.analyses) || 0) },
          { header: "Custo", align: "right", cell: (m) => fmtUsd(Number(m.cost_usd) || 0) },
        ]}
        foot={<tr><td class="px-4 py-2">Total</td><td /><td /><td class="px-4 py-2 text-right tabular-nums">{fmtInt(executed)}</td><td class="px-4 py-2 text-right tabular-nums">{fmtUsd(sum("cost_usd"))}</td></tr>}
      />
      <p class="mt-2 text-xs text-muted">
        Executadas = toda análise gravada, inclusive as substituídas por reexecução. Dessas, {fmtInt(Math.min(current, executed))} são as vigentes (a mais recente de cada sessão e rubrica)
        {executed > current ? ` e ${fmtInt(executed - current)} foram substituídas.` : "."}
      </p>
    </div>
  );
}

interface ArchitectureProps {
  overview: PipelineOverview;
  /** The replay step being shown (its component lights up), or null. */
  activeStep: number | null;
}

export function Architecture({ overview, activeStep }: ArchitectureProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const nodes = useRef<Record<string, HTMLButtonElement | null>>({});
  const [width, setWidth] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [drawn, setDrawn] = useState<DrawnEdge[]>([]);
  const focus = hover ?? sel;
  const wide = width >= ARCH_MIN_WIDTH;

  // The layout follows the width of the diagram area itself (the side menu takes space, so the window width is not a reliable guide).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = window.ResizeObserver ? new window.ResizeObserver(() => window.requestAnimationFrame(measure)) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // The connectors are measured from the real boxes, so they are drawn after the layout and again when its width changes.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || !wide) {
      setDrawn([]);
      return;
    }
    const base = el.getBoundingClientRect();
    const box: Record<string, Box> = {};
    for (const [id, node] of Object.entries(nodes.current)) {
      if (!node) continue;
      const r = node.getBoundingClientRect();
      box[id] = { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top, cx: (r.left + r.right) / 2 - base.left, cy: (r.top + r.bottom) / 2 - base.top };
    }
    setDrawn(ARCH_EDGES.flatMap((e) => (box[e[0]] && box[e[1]] ? [drawEdge(e, box[e[0]] as Box, box[e[1]] as Box)] : [])));
  }, [width, wide, overview]);

  const on = (n: ArchNode) => n.step !== null && n.step === activeStep;
  const related = (id: string) => Boolean(focus) && focus !== id && ARCH_EDGES.some((e) => (e[0] === focus && e[1] === id) || (e[1] === focus && e[0] === id));
  // Edge colour follows the two ends: both in use -> flowing; one waiting for activation -> dashed amber; otherwise neutral.
  const kindOf = (e: ArchEdge): string => {
    const sa = archState(e[0], overview)[1];
    const sb = archState(e[1], overview)[1];
    return sa === "warn" || sb === "warn" ? "idle" : sa === "ok" && sb === "ok" ? "live" : "quiet";
  };

  const nodeButton = (n: ArchNode, style?: Record<string, string | number>) => {
    const st = archState(n.id, overview);
    const isRel = related(n.id);
    return (
      <button
        key={n.id}
        ref={(el) => {
          nodes.current[n.id] = el;
        }}
        type="button"
        title={n.text}
        aria-pressed={sel === n.id}
        style={style}
        onClick={() => setSel(sel === n.id ? null : n.id)}
        onMouseEnter={() => setHover(n.id)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(n.id)}
        onBlur={() => setHover(null)}
        class={cx(
          "z-[1] flex flex-col gap-1.5 rounded-card border bg-surface p-3 text-left shadow-card transition-opacity",
          on(n) ? "border-primary ring-2 ring-primary/50" : st[1] === "warn" ? "border-dashed border-warn" : "border-line",
          sel === n.id && "ring-2 ring-primary",
          isRel && "border-primary/60",
          focus && focus !== n.id && !isRel && "opacity-40",
        )}
      >
        <span class="flex items-center gap-2"><ProductIcon mark={MARK[n.id]} glyph={GLYPH[n.id]} /><span class="font-semibold">{n.title}</span></span>
        <span class="text-xs text-muted">{n.where}</span>
        <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><Badge tone={TONE[st[1]]}>{st[0]}</Badge><span class="text-muted">{st[2]}</span></span>
      </button>
    );
  };

  const selected = sel ? byId(sel) : undefined;
  const names = (ids: string[]) => (ids.length ? ids.map((i) => byId(i)?.title ?? i).join(", ") : "—");
  return (
    <Card title="A arquitetura, ao vivo">
      <p class="mb-4 text-muted">
        Os componentes da solução e como se conectam. As linhas em movimento mostram caminhos em uso neste workspace; as tracejadas em âmbar são partes prontas que ainda não receberam dados. Durante o replay, acende o componente do passo mostrado. Nos nomes dos tópicos e dos serviços, {"{env}"} é o ambiente (dev ou prod).
      </p>
      <div ref={wrap} class="relative" role="list" aria-label="Componentes da arquitetura">
        {wide ? (
          <div class="grid grid-cols-4 gap-x-20 gap-y-4">
            {ARCH_LANES.map((lane, li) => <div key={lane} role="listitem" aria-label={lane} class="text-xs font-semibold tracking-wide text-faint uppercase" style={{ gridColumn: li + 1, gridRow: 1 }}>{lane}</div>)}
            {ARCH.map((n) => nodeButton(n, { gridColumn: n.lane + 1, gridRow: (ARCH_ROW[n.id] ?? 1) + 1 }))}
          </div>
        ) : (
          <div class="flex flex-col gap-5">
            {ARCH_LANES.map((lane, li) => (
              <div key={lane} role="listitem" aria-label={lane} class="flex flex-col gap-3">
                <div class="text-xs font-semibold tracking-wide text-faint uppercase">{lane}</div>
                {ARCH.filter((n) => n.lane === li).map((n) => nodeButton(n))}
              </div>
            ))}
          </div>
        )}
        {wide ? (
          <svg class="pointer-events-none absolute inset-0 z-[2]" aria-hidden="true" width={width} height="100%" style={{ overflow: "visible" }}>
            {drawn.map((x) => {
              const hit = Boolean(focus) && (x.edge[0] === focus || x.edge[1] === focus);
              const lit = [x.edge[0], x.edge[1]].some((id) => { const n = byId(id); return n ? on(n) : false; });
              return (
                <g key={x.edge[0] + x.edge[1]} class={cx("edge", kindOf(x.edge), lit && "on", hit && "hl", focus && !hit && "dim")}>
                  <path class="ln" d={x.d} />
                  {x.heads.map((p) => <polygon key={p} class="hd" points={p} />)}
                  <text class="lb" x={x.lx} y={x.ly} text-anchor={x.anchor} transform={x.rotate ? `rotate(-90 ${x.lx} ${x.ly})` : undefined}>{x.edge[2]}</text>
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>
      <div class="mt-4 rounded-control bg-surface-2 p-4" aria-live="polite">
        {selected ? (
          <>
            <div class="flex items-center gap-2.5">
              <ProductIcon mark={MARK[selected.id]} glyph={GLYPH[selected.id]} />
              <div><div class="font-semibold">{selected.title}</div><div class="text-xs text-muted">{selected.where}</div></div>
            </div>
            <p class="mt-2">{selected.text}</p>
            {(() => {
              const st = archState(selected.id, overview);
              const hasModels = selected.id === "openai" && Boolean(overview.models?.length);
              return (
                <div class="mt-2 flex flex-wrap items-center gap-2 text-xs"><Badge tone={TONE[st[1]]}>{st[0]}</Badge>{hasModels ? null : <span class="text-muted">{st[2]}</span>}</div>
              );
            })()}
            {selected.id === "openai" && overview.models?.length ? <ModelCosts models={overview.models} current={currentAnalyses(overview)} /> : null}
            <div class="mt-3 flex flex-col gap-1 text-xs sm:flex-row sm:gap-6">
              <span><b>Recebe de: </b>{names(ARCH_EDGES.filter((e) => e[1] === selected.id).map((e) => e[0]))}</span>
              <span><b>Envia para: </b>{names(ARCH_EDGES.filter((e) => e[0] === selected.id).map((e) => e[1]))}</span>
            </div>
          </>
        ) : (
          <p class="text-muted">Passe o mouse ou toque num componente para destacar suas conexões e ver o que ele faz.</p>
        )}
      </div>
    </Card>
  );
}

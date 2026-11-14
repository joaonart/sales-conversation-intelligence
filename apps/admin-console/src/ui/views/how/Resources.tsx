import { useState } from "preact/hooks";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { Input } from "../../components/Field";
import { ProductIcon } from "../../components/ProductIcon";
import { TabPanel, Tabs } from "../../components/Tabs";
import type { IconName } from "../../components/icons";
import { RES_GROUPS, RES_SECTIONS, type ResGroup } from "../../lib/howData";

const count = (n: number) => `${n} ${n === 1 ? "recurso" : "recursos"}`;

/** Everything is matched against the group, its dataset and the whole line, lower-cased. */
const matches = (g: ResGroup, item: ResGroup["items"][number], q: string): boolean => !q || `${g.title} ${g.dataset ?? ""} ${item.join(" ")}`.toLowerCase().includes(q);

const MARKED = new Set(["bigquery", "cloudrun", "pubsub"]);
const iconOf = (g: ResGroup) => <ProductIcon mark={MARKED.has(g.icon) ? g.icon : undefined} glyph={g.icon as IconName} />;

function ResTable({ g, q }: { g: ResGroup; q: string }) {
  const items = g.items.filter((it) => matches(g, it, q));
  if (!items.length) return null;
  return (
    <div class="overflow-x-auto">
      <table class="w-full min-w-[44rem] table-fixed border-collapse text-left text-sm">
        <colgroup>
          <col class="w-[32%]" />
          <col />
          <col class="w-[18%]" />
        </colgroup>
        <thead>
          <tr class="border-b border-line">
            {["Recurso", "Por que existe", "Custo"].map((h) => <th key={h} scope="col" class="px-4 py-2.5 text-xs font-medium tracking-wide text-muted uppercase">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it[0] + it[1]} class="border-b border-divider align-top last:border-b-0">
              <td class="px-4 py-3">
                <div class="flex min-w-0 items-start gap-2.5">
                  {iconOf(g)}
                  <div class="min-w-0">
                    <div class="font-mono text-[13px] [overflow-wrap:anywhere]">{it[0]}</div>
                    <div class="text-xs text-muted [overflow-wrap:anywhere]">{it[1]}</div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3 whitespace-normal">{it[2]}</td>
              <td class="px-4 py-3 whitespace-normal text-muted">{it[3]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A section: one card with tabs, and inside a tab one block per group. The label of a tab says how many lines it has and, while filtering, how many match. */
function Section({ id, groups, q }: { id: string; groups: ResGroup[]; q: string }) {
  const sec = RES_SECTIONS[id];
  const [chosen, setChosen] = useState(sec?.tabs[0]?.[0] ?? "");
  if (!sec) return null;
  const all = (tab: string) => groups.filter((g) => g.tab === tab).reduce((n, g) => n + g.items.length, 0);
  const hit = (tab: string) => groups.filter((g) => g.tab === tab).reduce((n, g) => n + g.items.filter((it) => matches(g, it, q)).length, 0);
  const anyHit = sec.tabs.some(([t]) => hit(t) > 0);
  if (!anyHit) return null;
  // Never leave a person on an empty tab when the match is on the other one.
  const current = q && !hit(chosen) ? (sec.tabs.find(([t]) => hit(t) > 0)?.[0] ?? chosen) : chosen;
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <Card title={sec.title} aside={`${sec.product} · ${count(total)}`} class="mb-4" data-section={id}>
      <p class="mb-3 text-muted">{sec.blurb}</p>
      <Tabs label={sec.title} idPrefix={`res-${id}`} value={current} onChange={setChosen} items={sec.tabs.map(([t, label]) => ({ id: t, label, count: q ? `${hit(t)} de ${all(t)}` : all(t) }))} />
      {sec.tabs.map(([t]) => (
        <TabPanel key={t} idPrefix={`res-${id}`} id={t} active={t === current}>
          {groups.filter((g) => g.tab === t).map((g) => {
            const shown = g.items.filter((it) => matches(g, it, q)).length;
            if (!shown) return null;
            return (
              <section key={g.id} aria-label={g.title} class="pt-4">
                <div class="mb-1 flex flex-wrap items-center gap-2">
                  <h3 class="font-semibold">{g.title}</h3>
                  {g.dataset ? <Badge mono>{g.dataset}</Badge> : null}
                  <span class="text-xs text-muted">{count(g.items.length)}</span>
                </div>
                <p class="mb-2 text-muted">{g.blurb}</p>
                <ResTable g={g} q={q} />
              </section>
            );
          })}
        </TabPanel>
      ))}
    </Card>
  );
}

/** Everything the solution runs on in Google Cloud (and the few parts outside it), and why each one exists. */
export function Resources() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const total = RES_GROUPS.reduce((n, g) => n + g.items.length, 0);
  // The units, in the order of the data: a section is placed where its first group is.
  const units: Array<{ kind: "card"; group: ResGroup } | { kind: "section"; id: string; groups: ResGroup[] }> = [];
  const seen = new Map<string, ResGroup[]>();
  for (const g of RES_GROUPS) {
    if (!g.section) units.push({ kind: "card", group: g });
    else if (!seen.has(g.section)) {
      const groups = [g];
      seen.set(g.section, groups);
      units.push({ kind: "section", id: g.section, groups });
    } else seen.get(g.section)?.push(g);
  }
  const shown = RES_GROUPS.reduce((n, g) => n + g.items.filter((it) => matches(g, it, q)).length, 0);
  return (
    <div>
      <Card title="Tudo o que a solução usa" class="mb-4">
        <p class="mb-3 text-muted">
          São {total} recursos em {units.length} áreas. Os do Google Cloud são criados pelo Terraform (os nomes usam {"{env}"} por causa do ambiente: dev ou prod); o dataset de origem e as peças de fora estão marcados. Cada linha diz o que é e por que existe, para que nada fique sem dono nem sem motivo. O que já está aplicado em cada ambiente fica em docs/deployment-plan.md.
        </p>
        <Input type="search" class="max-w-xs" placeholder="Filtrar recursos" aria-label="Filtrar recursos" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        {shown === 0 ? <p class="mt-3 text-muted">Nenhum recurso corresponde ao filtro.</p> : null}
      </Card>
      {units.map((u) =>
        u.kind === "card" ? (
          matches(u.group, u.group.items[0] ?? ["", "", "", ""], "") && u.group.items.some((it) => matches(u.group, it, q)) ? (
            <Card key={u.group.id} title={u.group.title} aside={`${u.group.product} · ${count(u.group.items.length)}`} class="mb-4" data-group={u.group.id}>
              <p class="mb-3 text-muted">{u.group.blurb}</p>
              <ResTable g={u.group} q={q} />
            </Card>
          ) : null
        ) : (
          <Section key={u.id} id={u.id} groups={u.groups} q={q} />
        ),
      )}
    </div>
  );
}

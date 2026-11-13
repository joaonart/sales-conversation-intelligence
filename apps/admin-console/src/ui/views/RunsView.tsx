import { useState } from "preact/hooks";
import { PageHead } from "../components/PageHead";
import { TabPanel, Tabs } from "../components/Tabs";
import { useSession } from "../state/session";
import { ExecutionForm, type When } from "./ExecutionForms";
import { RequestsTab, SchedulesTab } from "./ExecutionTabs";
import { RunDetail } from "./RunDetail";
import { RunHistory } from "./RunHistory";

const TABS = [
  { id: "requests", label: "Pedidos de execução" },
  { id: "schedules", label: "Agendas de execução" },
  { id: "history", label: "Histórico de execução" },
];

function Executions() {
  const { can } = useSession();
  const isAdmin = can("ADMIN");
  const [tab, setTab] = useState("requests");
  // The one form for a request and for a schedule; it opens already on "Agora" (the button of the Pedidos tab) or on "Repetir" (the button of the Agendas tab); either way it is a dialog over the page.
  const [form, setForm] = useState<{ when: When; n: number } | null>(null);
  const [reqKey, setReqKey] = useState(0);
  const [schedKey, setSchedKey] = useState(0);
  return (
    <>
      <PageHead title="Execuções" subtitle="Pedidos de execução e histórico de processamento (última linha de cada execução)" />
      {/* Only administrators have requests and schedules: everyone else sees the history alone. */}
      {!isAdmin ? (
        <RunHistory />
      ) : (
        <>
          <Tabs label="Execuções" idPrefix="exec" items={TABS} value={tab} onChange={setTab} />
          <div class="pt-4">
            {form ? (
              <ExecutionForm
                key={form.n}
                initialWhen={form.when}
                onClose={() => setForm(null)}
                onRequested={() => { setReqKey((n) => n + 1); setTab("requests"); }}
                onScheduled={() => { setSchedKey((n) => n + 1); setTab("schedules"); }}
              />
            ) : null}
            <TabPanel idPrefix="exec" id="requests" active={tab === "requests"}><RequestsTab reloadKey={reqKey} schedulesKey={schedKey} onChange={() => setReqKey((n) => n + 1)} onNew={() => setForm({ when: "now", n: Date.now() })} /></TabPanel>
            <TabPanel idPrefix="exec" id="schedules" active={tab === "schedules"}><SchedulesTab reloadKey={schedKey} onNew={() => setForm({ when: "repeat", n: Date.now() })} /></TabPanel>
            <TabPanel idPrefix="exec" id="history" active={tab === "history"}><RunHistory /></TabPanel>
          </div>
        </>
      )}
    </>
  );
}

export function RunsView({ parts }: { parts: string[] }) {
  const id = parts[0];
  return id ? <RunDetail runId={decodeURIComponent(id)} /> : <Executions />;
}

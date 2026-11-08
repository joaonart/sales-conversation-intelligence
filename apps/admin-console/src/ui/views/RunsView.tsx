import { useState } from "preact/hooks";
import { Button } from "../components/Button";
import { PageHead } from "../components/PageHead";
import { TabPanel, Tabs } from "../components/Tabs";
import { useSession } from "../state/session";
import { ExecutionForm, ScheduleForm } from "./ExecutionForms";
import { RequestsTab, SchedulesTab } from "./ExecutionTabs";
import { RunDetail } from "./RunDetail";
import { RunHistory } from "./RunHistory";

const TABS = [
  { id: "requests", label: "Pedidos de execução" },
  { id: "schedules", label: "Agendas" },
  { id: "history", label: "Histórico de execução" },
];

function Executions() {
  const { can } = useSession();
  const isAdmin = can("ADMIN");
  const [tab, setTab] = useState("requests");
  const [panel, setPanel] = useState<"exec" | "sched" | null>(null);
  const [reqKey, setReqKey] = useState(0);
  const [schedKey, setSchedKey] = useState(0);
  return (
    <>
      <PageHead
        title="Execuções"
        subtitle="Pedidos de execução e histórico de processamento (última linha de cada execução)"
        actions={isAdmin ? <Button variant="primary" icon="add" onClick={() => setPanel("exec")}>Nova execução</Button> : null}
      />
      {/* Only administrators have requests and schedules: everyone else sees the history alone. */}
      {!isAdmin ? (
        <RunHistory />
      ) : (
        <>
          {panel === "exec" ? <ExecutionForm onClose={() => setPanel(null)} onRequested={() => { setReqKey((n) => n + 1); setTab("requests"); }} /> : null}
          {panel === "sched" ? <ScheduleForm onClose={() => setPanel(null)} onSaved={() => setSchedKey((n) => n + 1)} /> : null}
          <Tabs label="Execuções" idPrefix="exec" items={TABS} value={tab} onChange={setTab} />
          <div class="pt-4">
            <TabPanel idPrefix="exec" id="requests" active={tab === "requests"}><RequestsTab reloadKey={reqKey} onChange={() => setReqKey((n) => n + 1)} /></TabPanel>
            <TabPanel idPrefix="exec" id="schedules" active={tab === "schedules"}><SchedulesTab reloadKey={schedKey} onNew={() => setPanel("sched")} /></TabPanel>
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

import { useCallback, useEffect, useState } from "preact/hooks";
import { ErrorAlert } from "../components/Bits";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { PageHead } from "../components/PageHead";
import { TabPanel, Tabs } from "../components/Tabs";
import type { PipelineOverview } from "../lib/types";
import { useSession } from "../state/session";
import { Architecture } from "./how/Architecture";
import { Replay } from "./how/Replay";
import { Resources } from "./how/Resources";

const TABS = [
  { id: "flow", label: "Fluxo" },
  { id: "arch", label: "Arquitetura" },
  { id: "res", label: "Recursos" },
];

/** "Como funciona": the path of a conversation to its result, with this workspace's real numbers. */
export function HowView() {
  const { api } = useSession();
  const [tab, setTab] = useState("flow");
  const [overview, setOverview] = useState<PipelineOverview>({});
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const load = useCallback(() => {
    api("pipeline.overview", {}).then(
      (o) => {
        setOverview(o);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : "Não foi possível carregar os números."),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return (
    <>
      <PageHead
        title="Como funciona"
        subtitle="O caminho de uma conversa até o resultado, com os números reais deste workspace"
        actions={<Button icon="refresh" onClick={load}>Atualizar</Button>}
      />
      {error ? <div class="mb-4"><ErrorAlert message={error} /></div> : null}
      <Tabs label="Visões" idPrefix="how" items={TABS} value={tab} onChange={setTab} />
      <div class="pt-4">
        <TabPanel idPrefix="how" id="flow" active={tab === "flow"}>
          <div class="flex flex-col gap-4">
            <Replay onActiveStep={setActiveStep} />
            <Card title="O que a IA faz e o que não faz">
              <ul class="list-disc space-y-2 pl-5">
                <li><strong>A IA responde e escreve, mas não dá a nota.</strong> Cada critério vira uma pergunta e ela devolve a resposta. Opcionalmente também escolhe a rubrica de cada sessão e escreve a avaliação geral, um resumo em texto. As mensagens que a sustentam vêm da Responses API ou, com a Decisions API (que não devolve citações), de uma segunda chamada opcional no ao vivo, a etapa de evidências.</li>
                <li><strong>A nota é por regra.</strong> Peso, obrigatoriedade, aplicabilidade e mínimo de aprovação são calculados por código e dão o mesmo resultado em histórico e ao vivo.</li>
                <li><strong>Sem evidência não é zero.</strong> Não aplicável e evidência insuficiente ficam de fora ou vão para revisão humana.</li>
                <li><strong>Texto da conversa é dado, não instrução.</strong> Tentativas de prompt injection são ignoradas. CPF, CNPJ, e-mail e telefone são mascarados; nomes e texto livre não são.</li>
                <li><strong>Custo tem teto.</strong> Toda execução tem estimativa prévia e um teto aprovado por pedido ou agenda, e, no worker ao vivo e no worker sob demanda, há também um teto mensal de IA por workspace somando tudo o que foi pago; passou, para.</li>
              </ul>
            </Card>
          </div>
        </TabPanel>
        <TabPanel idPrefix="how" id="arch" active={tab === "arch"}>
          <Architecture overview={overview} activeStep={activeStep} />
        </TabPanel>
        <TabPanel idPrefix="how" id="res" active={tab === "res"}>
          <Resources />
        </TabPanel>
      </div>
    </>
  );
}

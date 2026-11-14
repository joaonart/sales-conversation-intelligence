/**
 * What "Como funciona" shows: the steps of the replay, the architecture (lanes, components, connectors) and the list of resources the solution runs on.
 * Plain data: `tests/test_console_resources.py` fails when a Terraform resource is missing from RES_GROUPS, and the names use {env} because the same
 * Terraform creates dev and prod.
 */
export type ReplayStep = [title: string, text: string];
export interface ArchNode { id: string; lane: number; step: number | null; title: string; where: string; text: string }
export type ArchEdge = [from: string, to: string, label: string, kind?: "detour" | "both"];
export interface ResSection { title: string; product: string; icon: string; tabs: Array<[id: string, label: string]>; blurb: string }
export type ResItem = [name: string, kind: string, why: string, cost: string];
export interface ResGroup { id: string; section?: string; tab?: string; dataset?: string; title: string; product: string; icon: string; blurb: string; items: ResItem[] }

export const REPLAY_STEPS: ReplayStep[] = [
    ["A conversa", "A conversa chega do BigQuery. CPF, CNPJ, e-mail e telefone são mascarados antes de irem para a IA e ao serem mostrados no console; nomes e texto livre não são."],
    ["A rubrica", "A rubrica publicada define o que avaliar, quanto cada critério pesa e quando ele se aplica."],
    ["A resposta da IA", "A IA responde cada critério. A Responses API cita, na própria resposta, as mensagens que a sustentam. A Decisions API (a padrão) não devolve citações: no ao vivo, uma segunda chamada opcional (a etapa de evidências) as obtém, só para as respostas que afirmam algo. Ela não calcula nota."],
    ["O cálculo", "O motor calcula a nota por regra fixa: Σ(peso × nota) ÷ Σ pesos dos critérios aplicáveis."],
    ["O resultado", "Status, resultado e motivo são gravados no BigQuery junto com o modelo e a versão do prompt."],
    ["A revisão humana", "Quando a decisão é incerta, a análise vai para a fila e uma pessoa decide."]
  ];

/** Architecture, in four lanes. `step` ties a component to the replay step that uses it (it lights up while that step is shown). */
export const ARCH_LANES: string[] = ["Origem dos dados", "Disparo", "Regras e processamento", "Saída"];
export const ARCH: ArchNode[] = [
    { id: "inbox", lane: 0, step: null, title: "Conversas recebidas", where: "Pub/Sub · sci-{env}-conversations", text: "Opcional: o tópico por onde o sistema de origem (fora desta plataforma) publica a conversa completa, sessão e mensagens, uma mensagem a cada mudança. Ele só guarda e entrega: quem valida e grava no BigQuery é a ingestão. Se a ingestão não conseguir tratar a conversa (5 tentativas), ela vai para uma fila de mortos (sci-{env}-conversations-dlq), guardada por 7 dias, e um alerta é enviado." },
    { id: "ingest", lane: 0, step: null, title: "Ingestão de conversas", where: "Cloud Run · sci-{env}-ingest", text: "Opcional: recebe do tópico de conversas (entrega push) a conversa completa (sessão e mensagens, até 500), valida e grava no BigQuery: a sessão só avança se for mais nova e uma mensagem reenviada não vira linha duplicada. Depois de gravar, avisa o worker ao vivo. Só aceita organizações e workspaces autorizados." },
    { id: "conversations", lane: 0, step: 0, title: "Conversas", where: "BigQuery · commerce", text: "Sessões e mensagens no formato canônico, gravadas pelo sistema de origem ou pela ingestão e sempre lidas com filtro de organização e workspace." },
    { id: "event", lane: 0, step: null, title: "Evento da sessão", where: "Pub/Sub · sci-{env}-session-updates", text: "O sistema de origem (fora deste repositório) avisa que a sessão mudou (ou a ingestão publica o aviso depois de gravar a conversa). Nunca se assume evento de inserção do BigQuery. Se o worker não conseguir tratar o aviso (5 tentativas), ele vai para uma fila de mortos (sci-{env}-session-updates-dlq), guardada por 7 dias, e um alerta é enviado." },
    { id: "schedules", lane: 1, step: null, title: "Agendas", where: "Console · BigQuery", text: "Instruções recorrentes criadas em Execuções › Agendas (por exemplo, todo dia às 02:00 UTC analisar as sessões novas de uma rubrica, com teto por execução). Uma agenda nunca gasta sozinha: no horário, o worker sob demanda a transforma num pedido comum, no nome de quem a criou, que passa por todos os portões." },
    { id: "executor", lane: 1, step: null, title: "Worker sob demanda", where: "Cloud Run Job · sci-{env}-executor · acordado pelo Cloud Scheduler (sci-{env}-executor-poll)", text: "Acordado de tempos em tempos pelo Cloud Scheduler. Cria os pedidos das agendas que venceram e roda os pedidos feitos em Execuções, inclusive o processamento histórico: varre as sessões por partição, com checkpoint, estimativa prévia e teto de custo aprovado. A mesma rotina também roda pela linha de comando; um Cloud Run Job só para o histórico existe no Terraform, mas não foi implantado. Antes de chamar a IA confere de novo o teto do pedido, o teto mensal de IA do workspace e se quem pediu ainda é administrador, e recusa o que passar. Sem nada a fazer termina em segundos, sem custo de IA." },
    { id: "live", lane: 1, step: null, title: "Worker ao vivo", where: "Cloud Run · sci-{env}-live", text: "Recebe o aviso, confere se o workspace está autorizado e agenda a análise na fila. Depois da espera, lê só aquela sessão, e, se o conteúdo é igual ao da última análise, não analisa de novo e não gera custo. Também respeita o limite de análises por sessão e o teto mensal." },
    { id: "queue", lane: 1, step: null, title: "Fila de espera", where: "Cloud Tasks · sci-{env}-live-eval", text: "Junta os avisos de uma mesma sessão: todos os que chegam dentro de uma janela (60 segundos no dev, 2 minutos por padrão) viram uma só tarefa, que chama o worker uma espera depois que a janela termina, ou seja, entre 1 e 2 vezes a espera (60 a 120 segundos no dev). Assim uma rajada de avisos é analisada uma vez só. Até 8 tentativas se algo falhar." },
    { id: "rubrics", lane: 2, step: 1, title: "Rubricas", where: "BigQuery · conversation_config", text: "Versões publicadas e imutáveis, com critérios, pesos e regras de aplicabilidade." },
    { id: "engine", lane: 2, step: 3, title: "Motor de avaliação", where: "Biblioteca Python · sci_core", text: "O mesmo motor no worker ao vivo e no worker sob demanda (que inclui o histórico): monta as perguntas e calcula a nota por regra fixa. Opcionalmente, antes dele, um roteador escolhe a rubrica de cada sessão com uma pergunta curta à IA." },
    { id: "budget", lane: 2, step: null, title: "Teto de custo", where: "Biblioteca Python · sci_core (BudgetGate)", text: "Reserva o pior caso antes de chamar a IA e recusa o que passaria do limite: o teto do pedido ou da execução e, no worker ao vivo e no worker sob demanda, também o teto mensal de IA do workspace, somado a tudo o que foi pago no mês (cada chamada paga é registrada na tabela ai_spend do BigQuery no instante em que o provedor responde, mesmo que a análise não chegue a ser gravada). Na dúvida, a chamada não é feita." },
    { id: "openai", lane: 2, step: 2, title: "IA", where: "OpenAI · externo", text: "Decisions API (padrão) ou Responses API, com um modelo da lista permitida. Responde cada critério; opcionalmente também escolhe a rubrica de cada sessão (roteamento) e escreve a avaliação geral, um resumo em texto que não altera a nota. A Responses API cita as mensagens que sustentam a resposta. A Decisions API não devolve citações: no ao vivo, uma segunda chamada opcional (a etapa de evidências, com outro modelo da lista) as obtém. A chave fica no Secret Manager." },
    { id: "results", lane: 3, step: 4, title: "Resultados", where: "BigQuery · conversation_analytics", text: "Análises e critérios só são acrescentados; a visão de último resultado evita duplicidade." },
    { id: "console", lane: 3, step: 5, title: "Este console", where: "Apps Script", text: "Painel, sessões, rubricas, fila de revisão e, para administradores, os pedidos de execução e as agendas. A decisão humana fica ao lado da análise." }
  ];

/** Row of each component inside its column (1 = top of the tallest column): a component sits on the same line as the one it feeds. */
export const ARCH_ROW: Record<string, number> = { inbox: 1, ingest: 2, conversations: 3, event: 4, schedules: 1, executor: 2, live: 4, queue: 5, rubrics: 2, engine: 3, budget: 4, openai: 5, results: 3, console: 4 };

/** Connections drawn between the components: [from, to, short label shown when either end is highlighted]. */
export const ARCH_EDGES: ArchEdge[] = [
    ["conversations", "executor", "lê as sessões do pedido"], ["conversations", "live", "lê a sessão"], ["event", "live", "sessão mudou"],
    ["inbox", "ingest", "entrega a conversa (push)"], ["ingest", "conversations", "grava a conversa"], ["ingest", "event", "publica o evento", "detour"],
    ["live", "queue", "agenda · chama depois da espera", "both"],
    ["schedules", "executor", "cria os pedidos no horário"], ["executor", "engine", "pedidos do console"],
    ["live", "engine", "sessão a avaliar"], ["rubrics", "engine", "critérios e pesos"],
    ["engine", "budget", "reserva o pior caso"], ["budget", "openai", "chamada autorizada"],
    ["engine", "results", "grava a análise"], ["results", "console", "consulta e revisa"]
  ];

export const RES_SECTIONS: Record<string, ResSection> = {
    bigquery: { title: "Dados no BigQuery", product: "BigQuery", icon: "bigquery", tabs: [["tables", "Tabelas"], ["views", "Views"]],
      blurb: "Três datasets: o de origem (lido, nunca escrito pela análise), o de configuração e o de resultados. Rubricas publicadas nunca mudam e resultados só ganham linhas: uma alteração vira uma nova revisão." },
    identity: { title: "Segredos e identidade", product: "Secret Manager · IAM", icon: "audit", tabs: [["secrets", "Segredos"], ["identity", "Identidade"]],
      blurb: "O que guarda a chave da IA e quem pode fazer o quê. Cada processo tem a própria conta de serviço, com só as permissões de que precisa." }
  };
export const RES_GROUPS: ResGroup[] = [
    { id: "bq-source", section: "bigquery", tab: "tables", dataset: "commerce", title: "Conversas de origem", product: "BigQuery", icon: "bigquery", blurb: "O dataset de origem: de onde a plataforma lê, e nada aqui é escrito pela análise. O Terraform não o cria; só concede leitura aos processos e escrita ao serviço de ingestão, e toda consulta filtra organização, workspace e partição.", items: [
      ["sessions", "Tabela", "Uma linha por sessão de conversa: canal, status, início, última atualização e fechamento. É a lista de trabalho das análises.", "Armazenamento"],
      ["messages", "Tabela", "As mensagens de cada sessão. É a única fonte do texto analisado; a plataforma nunca copia esse texto para os registros.", "Armazenamento"]
    ] },
    { id: "bq-config", section: "bigquery", tab: "tables", dataset: "conversation_config", title: "Configuração e controle", product: "BigQuery · conversation_config", icon: "bigquery", blurb: "O que as pessoas configuram e decidem. Rubricas publicadas nunca mudam: uma alteração vira uma nova revisão.", items: [
      ["app_users", "Tabela", "Quem pode entrar no console e com qual papel, por organização e workspace.", "Centavos"],
      ["audit_log", "Tabela", "Trilha de auditoria: quem fez o quê e quando. Só acrescenta linhas.", "Centavos"],
      ["evaluation_rubrics", "Tabela", "As rubricas, versionadas. Uma versão publicada é imutável.", "Centavos"],
      ["evaluation_criteria", "Tabela", "Os critérios e pesos de cada versão de rubrica.", "Centavos"],
      ["evaluation_policies", "Tabela", "As regras de cada rubrica: nota mínima, obrigatoriedade e o mínimo de mensagens para analisar.", "Centavos"],
      ["review_decisions", "Tabela", "A decisão de quem revisou uma análise incerta. Fica ao lado da análise e não a altera.", "Centavos"],
      ["run_requests", "Tabela", "Os pedidos de execução feitos no console, com o teto de custo. O worker sob demanda os consome.", "Centavos"],
      ["run_schedules", "Tabela", "As agendas recorrentes (dia, hora, rubrica, modelo e teto por execução). Cada alteração é uma linha nova. No horário, o worker sob demanda transforma a agenda num pedido comum, que passa por todos os portões.", "Centavos"]
    ] },
    { id: "bq-results", section: "bigquery", tab: "tables", dataset: "conversation_analytics", title: "Resultados e custos", product: "BigQuery · conversation_analytics", icon: "bigquery", blurb: "Tudo o que a análise produz, só acrescentando linhas. Nunca se atualiza nem se apaga um resultado: a visão de último resultado evita duplicidade.", items: [
      ["session_analyses", "Tabela", "Uma linha por análise: status, nota, modelo, versão do prompt e da rubrica, custo e a execução que a produziu.", "Armazenamento"],
      ["session_criterion_results", "Tabela", "O resultado de cada critério de cada análise, com as mensagens que o comprovam.", "Armazenamento"],
      ["session_summaries", "Tabela", "A avaliação geral de cada análise: um resumo com pontos positivos, negativos e oportunidades, cada um com as mensagens que o sustentam. Escrita depois da nota, nunca entra no cálculo, e guarda o modelo e o hash do prompt da rubrica que a gerou.", "Armazenamento"],
      ["analysis_runs", "Tabela", "Cada execução, histórica ou ao vivo: contadores, custo e ponto de retomada.", "Centavos"],
      ["session_routes", "Tabela", "Para qual rubrica cada sessão foi roteada (ou nenhuma), por qual modelo.", "Centavos"],
      ["run_failures", "Tabela", "Por que uma sessão falhou, como código seguro: nunca o texto da conversa nem a resposta do provedor.", "Centavos"],
      ["ai_spend", "Tabela", "Toda chamada paga à IA, gravada no instante em que o provedor responde. O teto mensal lê esta tabela, então vale mesmo quando a análise não chega a ser gravada.", "Centavos"]
    ] },
    { id: "bq-views", section: "bigquery", tab: "views", dataset: "conversation_analytics", title: "Visões", product: "BigQuery · conversation_analytics", icon: "bigquery", blurb: "Consultas prontas sobre as tabelas: o console e os painéis leem daqui, não das tabelas brutas.", items: [
      ["latest_session_analyses", "Visão", "A análise vigente de cada sessão e rubrica: o último resultado, sem duplicidade por reenvio.", "Por consulta"],
      ["current_session_results", "Visão", "A análise vigente com o resultado já calculado, usada nas listas e no painel.", "Por consulta"],
      ["current_session_routes", "Visão", "A decisão de roteamento vigente de cada sessão.", "Por consulta"],
      ["latest_analysis_runs", "Visão", "A situação atual de cada execução (a linha mais recente do ponto de retomada).", "Por consulta"],
      ["latest_criterion_results", "Visão", "Os critérios da análise vigente.", "Por consulta"],
      ["review_queue", "Visão", "As análises incertas que esperam uma pessoa decidir.", "Por consulta"],
      ["gold_daily_quality", "Visão", "Nota e aprovação por dia: o painel de qualidade.", "Por consulta"],
      ["gold_criterion_daily", "Visão", "O desempenho de cada critério por dia.", "Por consulta"],
      ["gold_cost_daily", "Visão", "Custo e quantidade de análises por dia e modelo: o painel de custo.", "Por consulta"],
      ["gold_routing_daily", "Visão", "Quantas sessões foram para cada rubrica por dia.", "Por consulta"],
      ["gold_run_health", "Visão", "A saúde das execuções: concluídas, com falhas e paradas.", "Por consulta"]
    ] },
    { id: "run", title: "Processamento", product: "Cloud Run", icon: "cloudrun", blurb: "Todo processamento escala a zero: sem trabalho, não há custo de instância parada. Nada de GKE, Cloud SQL ou servidores ligados o tempo todo.", items: [
      ["sci-{env}-live", "Serviço do Cloud Run", "O worker ao vivo: recebe o aviso de que a sessão mudou, agenda a análise e, depois da espera, avalia só aquela sessão. Tem teto de instâncias e teto mensal de gasto com IA.", "Por uso; zero instâncias paradas"],
      ["sci-{env}-ingest", "Serviço do Cloud Run", "Opcional. Recebe a conversa completa do produtor, grava sessão e mensagens no BigQuery sem duplicar e avisa o worker ao vivo. Evita que o produtor precise de acesso direto ao BigQuery.", "Por uso; zero instâncias paradas"],
      ["sci-{env}-executor", "Job do Cloud Run", "O worker sob demanda: roda os pedidos feitos em Execuções, inclusive os das agendas e o processamento histórico. Antes de chamar a IA confere de novo o teto do pedido, o teto mensal de IA do workspace e se quem pediu ainda é administrador.", "Só enquanto roda"],
      ["sci-{env}-executor-poll", "Job do Cloud Scheduler (opcional)", "Acorda o worker sob demanda de tempos em tempos. Ele cria os pedidos das agendas que venceram e roda os pedidos esperando. Sem nada a fazer, termina em segundos e não gera custo de IA. Só é criado quando o worker sob demanda tem imagem e uma frequência definida.", "Centavos"],
      ["sci-{env}-historical", "Job do Cloud Run (preparado)", "Um job só para o processamento histórico, sem passar pelo worker sob demanda. Está no Terraform, mas só é criado quando se informa a imagem; hoje o histórico roda pelo worker sob demanda ou pela linha de comando.", "Só enquanto roda"],
      ["sci-{env}-api", "Serviço do Cloud Run (preparado)", "A API de leitura. Está no Terraform, mas só é criada quando se informa a imagem; o console lê o BigQuery diretamente.", "Por uso; zero instâncias paradas"]
    ] },
    { id: "msg", title: "Mensageria e agenda", product: "Pub/Sub · Cloud Tasks", icon: "pubsub", blurb: "Em vez de assumir que o BigQuery avisa quando uma linha entra (ele não avisa), o produtor publica um evento. As filas de mortos guardam o que não deu certo, para ninguém perder um aviso.", items: [
      ["sci-{env}-conversations", "Tópico do Pub/Sub", "Por onde o produtor envia a conversa completa para o serviço de ingestão.", "Por mensagem"],
      ["sci-{env}-conversations-ingest", "Assinatura (push)", "Entrega cada conversa ao serviço de ingestão, com autenticação e até 5 tentativas.", "Por mensagem"],
      ["sci-{env}-conversations-dlq", "Tópico do Pub/Sub", "Recebe a conversa que a ingestão não conseguiu tratar depois das tentativas.", "Por mensagem"],
      ["sci-{env}-conversations-dlq-hold", "Assinatura", "Guarda essas conversas por 7 dias, para investigar e reenviar. Um alerta avisa quando há mensagens aqui.", "Por mensagem"],
      ["sci-{env}-session-updates", "Tópico do Pub/Sub", "O evento \"a sessão mudou\": é o gatilho do processamento ao vivo, publicado pelo produtor ou pela ingestão.", "Por mensagem"],
      ["sci-{env}-session-updates-live", "Assinatura (push)", "Entrega cada evento ao worker ao vivo, com autenticação e até 5 tentativas.", "Por mensagem"],
      ["sci-{env}-session-updates-dlq", "Tópico do Pub/Sub", "Recebe o evento que o worker não conseguiu tratar depois das tentativas.", "Por mensagem"],
      ["sci-{env}-session-updates-dlq-hold", "Assinatura", "Guarda esses eventos por 7 dias para reprocessar. Um alerta avisa quando há mensagens aqui.", "Por mensagem"],
      ["sci-{env}-live-eval", "Fila do Cloud Tasks", "A fila de espera: junta os avisos de uma mesma sessão que chegam numa janela (60 s no dev) numa só tarefa, que roda uma espera depois que a janela termina (60 a 120 s no dev), e limita o ritmo de chamadas à IA.", "Por tarefa"]
    ] },
    { id: "sec-secrets", section: "identity", tab: "secrets", title: "Segredos", product: "Secret Manager", icon: "audit", blurb: "Só o cofre existe no Terraform; o valor é colocado por uma pessoa e nunca passa pelo código nem pelo console.", items: [
      ["sci-{env}-openai-api-key", "Segredo do Secret Manager", "A chave da OpenAI. O Terraform cria só o cofre; o valor é colocado por uma pessoa e nunca passa pelo código nem pelo console. Só os processos que chamam a IA podem ler.", "Centavos"]
    ] },
    { id: "sec-accounts", section: "identity", tab: "identity", title: "Contas de serviço", product: "IAM", icon: "audit", blurb: "Cada processo tem a própria conta, com só as permissões de que precisa. Ninguém usa a conta do dono do projeto para rodar a plataforma.", items: [
      ["sci-{env}-live", "Conta de serviço", "Identidade do worker ao vivo: lê conversas e rubricas, grava resultados e lê a chave.", "Gratuito"],
      ["sci-{env}-ingest", "Conta de serviço", "Identidade da ingestão: só grava sessões e mensagens e publica o evento.", "Gratuito"],
      ["sci-{env}-producer", "Conta de serviço (opcional)", "A identidade do sistema que ENVIA as conversas (por exemplo, um aplicativo fora do Google Cloud). Pode publicar só no tópico de conversas: não lê dados nem vê resultados. A chave dela é criada por uma pessoa, nunca pelo Terraform.", "Gratuito"],
      ["sci-{env}-exec", "Conta de serviço", "Identidade do worker sob demanda: lê pedidos, conversas e rubricas, grava resultados e lê a chave.", "Gratuito"],
      ["sci-{env}-exec-sched", "Conta de serviço (opcional)", "A que o agendador usa para acordar o worker sob demanda, e só para isso.", "Gratuito"],
      ["sci-{env}-hist", "Conta de serviço", "Identidade do job histórico próprio (preparado).", "Gratuito"],
      ["sci-{env}-api", "Conta de serviço", "Identidade da API de leitura (preparada).", "Gratuito"],
      ["sci-{env}-tasks", "Conta de serviço", "A que o Cloud Tasks usa para chamar o worker ao vivo com autenticação.", "Gratuito"],
      ["sci-{env}-push", "Conta de serviço", "A que o Pub/Sub usa para entregar mensagens às assinaturas push com autenticação.", "Gratuito"]
    ] },
    { id: "sec-roles", section: "identity", tab: "identity", title: "Papéis personalizados", product: "IAM", icon: "audit", blurb: "As permissões sob medida que essas contas recebem: cada papel faz uma coisa só e nenhum lê o que não precisa.", items: [
      ["sciResultWriter", "Papel personalizado", "Grava resultados e roda cargas no BigQuery, sem poder ler ou alterar mais nada.", "Gratuito"],
      ["sciSourceWriter", "Papel personalizado", "Grava sessões e mensagens de origem, e só isso.", "Gratuito"],
      ["sciConsoleConfigEditor", "Papel personalizado", "Deixa o console editar a configuração (rubricas, usuários, decisões) sem tocar nos resultados.", "Gratuito"]
    ] },
    { id: "sec-federation", section: "identity", tab: "identity", title: "Federação de identidade", product: "IAM · Workload Identity", icon: "audit", blurb: "Como o GitHub Actions entra no Google Cloud sem guardar nenhuma chave.", items: [
      ["sci-{env}-github", "Pool de identidade de carga", "Deixa o GitHub Actions entrar no Google Cloud sem guardar nenhuma chave: só o repositório e a ramificação autorizados.", "Gratuito"]
    ] },
    { id: "build", title: "Construção e base", product: "Artifact Registry · APIs", icon: "engine", blurb: "O que constrói e guarda o código que roda.", items: [
      ["sci-{env}-images", "Repositório do Artifact Registry", "As imagens de contêiner dos processos (workers ao vivo e sob demanda, e API), construídas pelo GitHub Actions a partir do código enviado.", "Armazenamento"],
      ["sci-{env}-build", "Conta de serviço", "A conta que o GitHub Actions assume para enviar imagens, só para este repositório.", "Gratuito"],
      ["14 APIs do Google Cloud", "Serviços do projeto", "BigQuery, Cloud Run, Pub/Sub, Cloud Tasks, Cloud Scheduler, Secret Manager, Artifact Registry, IAM e credenciais, STS, Logging, Monitoring, Billing Budgets e Resource Manager: o mínimo para tudo acima. Algumas só são habilitadas quando o recurso que as usa existe (o Cloud Scheduler, por exemplo, só com o executor agendado).", "Gratuito"]
    ] },
    { id: "obs", title: "Observabilidade", product: "Logging · Monitoring", icon: "dashboard", blurb: "Para saber que algo está errado antes de um usuário perceber. Os registros nunca levam texto de conversa.", items: [
      ["sci-{env}_evaluations", "Métrica de log", "Conta as análises concluídas.", "Centavos"],
      ["sci-{env}_evaluation_latency_ms", "Métrica de log", "Mede quanto tempo cada análise leva: base do objetivo de 95% em menos de 120 s.", "Centavos"],
      ["sci-{env}_failures", "Métrica de log", "Conta sessões que falharam, tarefas repetidas e eventos malformados.", "Centavos"],
      ["Alerta: falhas", "Política de alerta", "Mais de 10 falhas em 10 minutos.", "Gratuito"],
      ["Alerta: latência", "Política de alerta", "O p95 da análise passou de 120 s.", "Gratuito"],
      ["Alerta: fila de mortos do ao vivo", "Política de alerta", "Há eventos na fila de mortos dos avisos de sessão.", "Gratuito"],
      ["Alerta: fila de mortos da ingestão", "Política de alerta", "Há conversas na fila de mortos da ingestão.", "Gratuito"],
      ["Alerta: aviso parado", "Política de alerta", "A mensagem mais antiga da assinatura do ao vivo está esperando há mais de 10 minutos: o worker não está dando conta ou parou.", "Gratuito"],
      ["E-mail de alerta", "Canal de notificação", "Para onde os alertas vão.", "Gratuito"]
    ] },
    { id: "fin", title: "Controle de custo", product: "Billing", icon: "gauge", blurb: "O orçamento só avisa; quem realmente segura o gasto são os tetos do código (por pedido, por mês e por consulta), o limite de instâncias e a chave de IA desligada por padrão.", items: [
      ["sci-{env} monthly", "Orçamento do Billing", "Avisa a 50%, 90% e 100% do valor mensal definido e também quando a previsão do mês passa de 100%. Não corta o gasto sozinho.", "Gratuito"]
    ] },
    { id: "out", title: "Fora do Google Cloud", product: "Externos", icon: "external", blurb: "Peças que não rodam no Google Cloud. Estão aqui para nenhuma ficar escondida.", items: [
      ["Este console", "Apps Script", "A interface de administração. Lê o BigQuery com a identidade de quem a implantou e nunca guarda a chave da IA. É implantada pelo laptop com o clasp.", "Gratuito"],
      ["OpenAI", "Processador externo", "Responde cada critério (Decisions API ou Responses API) e escolhe a rubrica quando há roteamento. É o único serviço pago de uso variável.", "Por token, com teto"],
      ["GitHub Actions", "Integração contínua", "Testa o código e constrói as imagens. Entra no Google Cloud pela identidade de carga, sem chaves.", "Gratuito no plano atual"]
    ] }
  ];

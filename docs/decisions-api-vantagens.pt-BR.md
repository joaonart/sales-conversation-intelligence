# Por que usamos a Decisions API (e não só uma API generativa tradicional)

> Documento de apoio à decisão. Tudo o que está aqui vem da validação do contrato (`docs/openai-validation.md`, conferida em 2026-10-27), das decisões do projeto (`docs/decisions.md`) e dos números medidos em dev. O que **não** foi medido está dito como tal, na seção 6.

## 1. Resumo

A nossa necessidade é **avaliar uma conversa contra uma rubrica**: para cada critério, uma resposta de vocabulário fechado (sim/não, uma opção, um nível numa escala), que a plataforma converte em pontos de forma aritmética. Não precisamos que o modelo escreva texto.

A **Decisions API** (`POST /v1/decisions`) foi desenhada para esse formato: recebe a conversa e uma lista de **questões tipadas** e devolve **respostas tipadas com probabilidades**. Uma API generativa tradicional (no projeto, a Responses API) recebe uma instrução em linguagem natural e devolve texto ou JSON que precisamos pedir, forçar e validar.

| Em uma frase | Decisions API | API generativa tradicional (Responses) |
|---|---|---|
| O que é | Perguntas tipadas, respostas tipadas | Texto ou JSON gerado a partir de um prompt |
| Papel na nossa solução | **Avaliação dos critérios** (padrão) | Evidência, avaliação geral, sugestões de prompt e, opcionalmente, a avaliação |

## 2. Como cada uma recebe a pergunta

| | Decisions API | Responses API |
|---|---|---|
| Modelo | `gpt-6-luna` (o único aceito) | `gpt-4o`, `gpt-4o-mini` (lista fechada do projeto) |
| Pergunta | Até 400 **questões** por chamada: `predicate`, `choice` (2 a 255 opções) ou `score` (2 a 10 níveis) | Texto no prompt + JSON Schema `strict` que nós escrevemos |
| Resposta | Predicado: `probability`. Escolha: `choice`, `confidence`, `probabilities`. Nível: `score`, `probabilities`. Qualquer questão pode devolver `refusal` | JSON com o formato do schema; recusa e `incomplete` tratados à parte |
| Citações das mensagens | Não devolve | Devolve, na mesma chamada |

## 3. Vantagens para a nossa solução

### 3.1 O contrato da resposta é da API, não do prompt
Os três tipos de critério da rubrica (`PREDICATE`, `CHOICE`, `SCORE`) mapeiam **1 para 1** para os tipos de questão da API. Não escrevemos instruções do tipo "responda apenas JSON", não mantemos um schema por rubrica e não dependemos de o modelo respeitar um formato pedido em texto. O adaptador ainda valida tudo o que volta (resposta fora do vocabulário vira *evidência insuficiente*, nunca zero), mas o caso comum já chega no formato certo.

### 3.2 Probabilidades em vez de um "sim" ou "não" seco
Num predicado a API devolve a **probabilidade**; a plataforma aplica um **limiar fixo** (0,5 por padrão, registrado na versão do prompt) e decide verdadeiro/falso. Isso permite uma regra que uma resposta textual não permite: respostas **perto do limiar** podem ir para **revisão humana** em vez de serem decididas (`min_decision_margin`). A confiança e as probabilidades são informativas e **nunca entram na nota**, como exige o AGENTS.md (nota determinística, independente da confiança do modelo).

### 3.3 Uma chamada para a rubrica inteira
Até 400 critérios numa chamada (acima disso o adaptador divide). A conversa, que é a parte cara, é lida **uma vez** para todos os critérios, e não uma vez por pergunta.

### 3.4 Custo por token muito menor
Preços Standard, contexto até 272K, USD por 1 milhão de tokens (página oficial de preços, conferida em 2026-10-27 e 2026-10-31):

| | Entrada | Entrada em cache | Saída |
|---|---|---|---|
| `gpt-6-luna` (Decisions) | 0,10 | 0,01 | 0,50 |
| `gpt-4o` (Responses) | 2,50 | 1,25 | 10,00 |
| Razão | 25 vezes menor | 125 vezes menor | 20 vezes menor |

Como a rubrica e o texto fixo se repetem de uma conversa para outra, o **cache de prompt** (suportado pela API: `prompt_cache_key`, `prompt_cache_options`) pesa a favor. Isto é preço por token: o custo por análise depende também de quantos tokens cada API consome (ver seção 6).

### 3.5 Uso reportado por componente: custo exato e teto de gasto confiável
A resposta traz `input_tokens`, `cached_tokens`, `cache_write_tokens` e `output_tokens`. O custo é calculado **por componente**, e uma resposta sem uso **falha a análise** (o orçamento ficaria cego). Isso sustenta o que o projeto exige: reserva do pior caso antes da chamada, teto por pedido, teto mensal e custo por etapa no Painel.

### 3.6 Governança e privacidade
- Elegível a **ZDR** (retenção zero de dados).
- Processamento regional **EUA e EEA+CH** disponível (acréscimo de 10% no preço, tratado como `multiplier`).
- `safety_identifier` opaco por workspace (hash), sem expor identificadores do cliente.

### 3.7 Menos espaço para um texto livre carregar uma instrução maliciosa
A conversa é texto não confiável. Como a Decisions só devolve respostas tipadas (probabilidade, opção, nível), **não há canal de texto livre** na avaliação por onde uma instrução escondida numa mensagem possa produzir uma saída arbitrária que alguém ou algo vá ler. Isto é uma propriedade do desenho, não uma garantia absoluta: o aviso fixo ao modelo (a conversa é dado, nunca instrução) e o mascaramento de PII continuam obrigatórios.

### 3.8 O motor não muda
Decisions e Responses implementam a mesma interface (`sci_core.provider.AIProvider`). Rubrica, mapeamento de notas, pontuação e armazenamento são idênticos, e cada provedor tem identidade própria (`gpt-6-luna` + `decisions-v1` contra `<modelo>` + `responses-v1`): resultados de um nunca sobrescrevem os do outro. Dá para comparar as duas no console com as mesmas sessões, escolhendo a API por execução.

## 4. O que a Decisions API não faz (e como lidamos)

| Limite | Como a solução lida |
|---|---|
| **Não devolve citações** das mensagens | Passo de evidência separado: **uma** chamada Responses (`gpt-4o-mini`) por análise, só para respostas positivas. É um custo a mais e só roda no caminho ao vivo hoje |
| **Um único modelo** (`gpt-6-luna`) | Sem alternativa dentro da API; a Responses fica como segunda opção |
| **Limites de taxa específicos não documentados** | Teto de concorrência, `Retry-After` mais jitter, retry exponencial limitado, circuit breaker; `insufficient_quota` nunca é repetido |
| **Texto sobre preço de saída contraditório** (o guia diz que não é cobrada; a página de preços lista 0,50) | Usamos o valor maior nas estimativas e nos tetos até a OpenAI esclarecer |
| **Base do índice do nível** (0 ou 1) não declarada | Inferida das probabilidades; se for ambígua, o critério fica sem evidência suficiente |
| **Não escreve texto livre** | Sugestões de prompt e avaliação geral usam a Responses, porque são texto por natureza |

## 5. Quando cada API é a certa aqui

| Tarefa | API | Motivo |
|---|---|---|
| Avaliar os critérios da rubrica | **Decisions** (padrão) | Perguntas de vocabulário fechado, resposta tipada, preço baixo |
| Roteamento (qual rubrica serve a conversa) | Decisions (uma questão de escolha) ou Responses | Uma escolha entre rotas |
| Citar as mensagens de cada resposta | Responses | A Decisions não cita |
| Avaliação geral e sugestões de prompt | Responses | Texto livre |
| Avaliar quando a citação tem que vir junto, numa só chamada | Responses | Evidência na mesma chamada |

## 6. O que ainda não medimos

- **Não há comparação lado a lado de qualidade nem de custo por análise.** Em dev, o Painel tinha `gpt-4o` com 28 análises (cerca de US$ 0,0055 por análise, US$ 0,0067 por análise concluída) e `gpt-6-luna` com **uma** análise: pouco para concluir. A razão de preço da seção 3.4 é por token e não prevê o custo por análise.
- O custo por análise da Decisions inclui, quando o passo de evidência está ligado, a segunda chamada Responses. A comparação justa é "Decisions + evidência" contra "Responses sozinha".
- **Como medir:** rodar as **mesmas sessões** com as duas APIs (o formulário "Nova execução" já permite) e comparar na tabela "Eficiência por API e modelo" do Painel o custo por análise concluída, e na fila de revisão a concordância das respostas. Custo não é qualidade: o modelo mais barato pode concluir menos ou errar mais.
- Os preços e limites foram conferidos em outubro de 2026; **reconfirmar antes de habilitar produção**.

## 7. Fontes

- `docs/openai-validation.md`: contrato validado, preços, pontos não documentados.
- `docs/openai-requests.pt-BR.md`: o que é enviado e devolvido em cada chamada, com exemplos.
- `docs/decisions.md`: decisões do projeto (evidência, paridade entre ao vivo e sob demanda, Melhorar prompt).
- Guia da API: https://developers.openai.com/api/docs/guides/decisions
- Preços: https://developers.openai.com/api/docs/pricing

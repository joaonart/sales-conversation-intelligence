# Consultas de análise (agrupar e aprofundar)

Consultas para rodar no BigQuery (console ou `bq query`) quando há milhares de conversas analisadas e ninguém vai abrir uma a uma. **Só leem**; não criam tabela, view nem modelo, e não chamam a OpenAI. Não são aplicadas pelo Terraform. Ajuste as variáveis `DECLARE` no topo (`p_project`, workspace, rubrica, versão, período, limite de "nota baixa"). O projeto vem de `p_project` por `SET @@dataset_project_id`, então as tabelas aparecem como `conversation_analytics.…` sem o projeto. Se esse `SET` der erro no seu ambiente, apague a linha: o BigQuery usa o projeto em que a consulta roda (o selecionado no console, ou `bq --project_id`).

Todas filtram organização e workspace, fixam **uma versão da rubrica** (notas de versões diferentes não se misturam) e limitam o período, para ler só as partições necessárias. Contam a análise mais recente de cada conversa. "Evidência insuficiente" e "não se aplica" nunca contam como nota baixa.

| Arquivo | Pergunta que responde |
|---|---|
| `01_weak_spot_profiles.sql` | Quais **tipos de problema** aparecem e quantas conversas há em cada um? Cada conversa recebe o perfil formado pelos 2 critérios que mais custaram pontos (ex.: `closing + objection`). |
| `02_criterion_overview.sql` | **Onde** perdemos pontos? Por critério: nota média, % de notas baixas, % de evidência insuficiente (sinal de instrução confusa) e participação na nota perdida. |
| `03_profile_drilldown.sql` | **Por quê**, em um perfil? As conversas dele, da pior para a melhor, com o resumo escrito, os pontos fracos e as mensagens citadas. |

Fluxo: `02` para ver o panorama → `01` para ver os grupos → copie o nome de um perfil para `p_profile` na `03` → abra uma conversa específica no console, só então.

## Por que regra fixa e não k-means

O agrupamento é determinístico: o mesmo dado dá sempre os mesmos grupos, cada grupo tem um nome que o negócio entende e a soma das conversas fecha. Um k-means (BigQuery ML) acharia grupos que ninguém sabe nomear, mudaria a cada treino e trataria "não se aplica" como número. Ele só vale se os perfis acima não separarem bem o que você procura; nesse caso cria um modelo no BigQuery (custo pequeno por consulta, mas é um recurso novo) e precisa de aprovação.

## Limites conhecidos

- Os perfis dependem do limite de "nota baixa" (`p_weak`, 60 por padrão) e de quantos critérios entram (`p_top_n`, 2). Teste 50 e 70 para ver se os grupos mudam muito.
- Agrupar por **tema do texto** (o que os resumos dizem, não só quais critérios falharam) exigiria embeddings, que são uma chamada paga a um modelo. Não está incluído.
- Critérios de **portão** (peso 0, como `is_sales` e `has_objection`) decidem se outros critérios se aplicam, mas não medem qualidade: ficam fora dos perfis e do `weak_pct`.
- Executadas em 14/11/2026 no BigQuery de dev: o `dry_run` das três passou e as consultas 01 e 02 rodaram com a organização `synthetic-a` (rubrica `sales_quality` v5, 13 conversas, soma dos perfis = 13); a 03 rodou com `org-test`. Os dados de dev são sintéticos e poucos, então os grupos servem de teste do mecanismo, não de conclusão de negócio.

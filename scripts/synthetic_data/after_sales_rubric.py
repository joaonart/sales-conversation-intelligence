"""Creates the DRAFT rubric `after_sales_quality` v1 in both dev synthetic workspaces (refuses to overwrite).

Publishing is done in the console; no AI is called. Run: python scripts/synthetic_data/after_sales_rubric.py
"""
import json

from google.cloud import bigquery

P = "jnart-intelligence-513001"
c = bigquery.Client(project=P)
RID, VER = "after_sales_quality", 1
GATE = {"type": "depends_on", "criterion_id": "is_after_sales", "equals": ["true"]}
BOTH = {"type": "all_of", "rules": [{"criterion_id": "is_after_sales", "equals": ["true"]}, {"criterion_id": "has_frustration", "equals": ["true"]}]}
YN = {"true": 100, "false": 0}
WHO = "O atendente (pessoa ou assistente virtual)"
CRIT = [
 ("is_after_sales", "É um atendimento de pós-venda?", "PREDICATE", 0, False, None, YN, None,
  "Esta é uma conversa de pós-venda? Considere pós-venda quando o cliente já comprou e procura ajuda: defeito, troca, devolução, cancelamento, entrega, nota fiscal, garantia ou dúvida de uso. Responda falso para interesse em comprar, número errado ou mensagens sem relação com um pedido ou produto já adquirido."),
 ("greeting", "Saudação", "PREDICATE", 10, False, GATE, YN, None,
  f"{WHO} abriu a conversa de forma cordial, se identificou (nome ou empresa) e ofereceu ajuda?"),
 ("understanding", "Entendimento do problema", "SCORE", 20, True, GATE, {"none": 0, "partial": 50, "complete": 100},
  {"none": "Propôs uma solução sem perguntar nada sobre o problema.",
   "partial": "Fez uma pergunta para entender o problema, mas não identificou o pedido ou produto e o sintoma.",
   "complete": "Identificou o pedido ou produto E o sintoma ou contexto do problema, perguntando o que faltava, antes de agir."},
  f"{WHO} entendeu o problema do cliente antes de propor a solução?"),
 ("resolution", "Solução", "SCORE", 25, True, GATE, {"poor": 0, "fair": 50, "good": 100},
  {"poor": "Não apresentou solução, deixou o cliente sem resposta ou deu uma informação incorreta.",
   "fair": "Apresentou uma solução genérica, sem passos concretos nem prazo.",
   "good": "Apresentou uma solução concreta (troca, reembolso, reparo ou orientação) com os passos a seguir e o prazo ou a próxima ação."},
  "A solução apresentada resolve o problema do cliente de forma correta e prática?"),
 ("has_frustration", "Cliente demonstrou insatisfação?", "PREDICATE", 0, False, None, YN, None,
  "O cliente demonstrou insatisfação, irritação, urgência ou voltou a cobrar a mesma questão?"),
 ("empathy", "Empatia", "SCORE", 15, False, BOTH, {"poor": 0, "fair": 50, "good": 100},
  {"poor": "Ignorou a insatisfação ou respondeu de forma fria ou defensiva.",
   "fair": "Reconheceu o problema com uma frase genérica, sem pedir desculpas nem se comprometer a resolver.",
   "good": "Reconheceu o problema, pediu desculpas quando cabia e se comprometeu a resolver, com tom adequado ao cliente."},
  f"{WHO} reconheceu a insatisfação do cliente e manteve um tom empático?"),
 ("next_steps", "Próximos passos", "PREDICATE", 15, False, GATE, YN, None,
  f"{WHO} deixou claro o que acontece depois (prazo, protocolo, quem faz o quê) ou confirmou os dados necessários para seguir?"),
 ("closing", "Encerramento", "PREDICATE", 15, False, GATE, YN, None,
  f"{WHO} confirmou se o problema foi resolvido ou perguntou se o cliente precisava de mais alguma coisa antes de encerrar?"),
]
J = bigquery.ScalarQueryParameter
def j(v): return None if v is None else json.dumps(v, ensure_ascii=False)
for org in ("synthetic-a", "synthetic-b"):
    p = {"org": org, "ws": "default", "rid": RID, "ver": VER}
    assert not list(c.query(f"SELECT 1 FROM `{P}.conversation_config.evaluation_rubrics` WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid",
        job_config=bigquery.QueryJobConfig(query_parameters=[J(k, "INT64" if k == "ver" else "STRING", v) for k, v in p.items()])).result()), f"{org} already has {RID}"
    c.query(f"""INSERT INTO `{P}.conversation_config.evaluation_rubrics` (organization_id, workspace_id, rubric_id, version, name, status, published_at, created_at, description)
      VALUES (@org, @ws, @rid, @ver, 'Qualidade do pós-venda', 'DRAFT', NULL, CURRENT_TIMESTAMP(), 'Rubrica sintética para atendimento de pós-venda e suporte')""",
      job_config=bigquery.QueryJobConfig(query_parameters=[J(k, "INT64" if k == "ver" else "STRING", v) for k, v in p.items()])).result()
    c.query(f"""INSERT INTO `{P}.conversation_config.evaluation_policies` (organization_id, workspace_id, rubric_id, rubric_version, minimum_approval_score, missing_evidence_policy, min_messages, min_customer_messages, min_seller_messages)
      VALUES (@org, @ws, @rid, @ver, 70, 'NEEDS_REVIEW', 3, 0, 0)""",
      job_config=bigquery.QueryJobConfig(query_parameters=[J(k, "INT64" if k == "ver" else "STRING", v) for k, v in p.items()])).result()
    for i, (cid, name, typ, w, req, rule, mapping, levels, text) in enumerate(CRIT, 1):
        qp = [J("org","STRING",org), J("ws","STRING","default"), J("rid","STRING",RID), J("ver","INT64",VER), J("cid","STRING",cid), J("nm","STRING",name), J("tx","STRING",text),
              J("ty","STRING",typ), J("w","NUMERIC",w), J("rq","BOOL",req), J("ar","STRING",j(rule)), J("sm","STRING",j(mapping)), J("sl","STRING",j(levels)), J("o","INT64",i)]
        c.query(f"""INSERT INTO `{P}.conversation_config.evaluation_criteria` (organization_id, workspace_id, rubric_id, rubric_version, criterion_id, criterion_name, evaluation_instructions,
            evaluation_type, weight, required, enabled, applicability_rule, score_mapping, score_levels, display_order)
          VALUES (@org,@ws,@rid,@ver,@cid,@nm,@tx,@ty,@w,@rq,TRUE,
            IF(@ar IS NULL, NULL, PARSE_JSON(@ar)), PARSE_JSON(@sm), IF(@sl IS NULL, NULL, PARSE_JSON(@sl)), @o)""",
          job_config=bigquery.QueryJobConfig(query_parameters=qp)).result()
    print("created", org, RID, VER, len(CRIT), "criteria")

-- Aprofundar um perfil: as conversas dele, o resumo escrito e os pontos fracos (com as mensagens citadas), da pior nota para a melhor.
-- Rode depois da 01: copie o nome do perfil (ex.: 'closing + objection', em ordem alfabética) para p_profile. Só lê tabelas; ajuste as variáveis do topo.
-- O resumo só existe para análises feitas com o resumo ligado; sem ele as colunas de texto vêm vazias.
DECLARE p_project STRING  DEFAULT 'jnart-intelligence-513001';
DECLARE p_org     STRING  DEFAULT 'org-test';
DECLARE p_ws      STRING  DEFAULT 'default';
DECLARE p_rubric  STRING  DEFAULT 'sales_quality';
DECLARE p_version INT64   DEFAULT 4;
DECLARE p_from    DATE    DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY);
DECLARE p_to      DATE    DEFAULT CURRENT_DATE();
DECLARE p_weak    FLOAT64 DEFAULT 60;
DECLARE p_top_n   INT64   DEFAULT 2;
DECLARE p_profile STRING  DEFAULT 'closing + objection';
DECLARE p_limit   INT64   DEFAULT 50;
SET @@dataset_project_id = p_project;  -- o projeto das tabelas `conversation_analytics.*` abaixo

WITH analyses AS (
  SELECT analysis_id, session_id, overall_score, approval_status
  FROM `conversation_analytics.session_analyses`
  WHERE organization_id = p_org AND workspace_id = p_ws AND rubric_id = p_rubric AND rubric_version = p_version
    AND DATE(started_at) BETWEEN p_from AND p_to AND analysis_status = 'COMPLETED'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY completed_at DESC, analysis_id DESC) = 1
),
criteria AS (
  SELECT c.analysis_id, c.criterion_id, c.applicability_status, c.normalized_score, c.criterion_weight
  FROM `conversation_analytics.session_criterion_results` c
  JOIN analyses a ON a.analysis_id = c.analysis_id
  WHERE c.organization_id = p_org AND c.workspace_id = p_ws
    AND DATE(c.evaluated_at) BETWEEN p_from AND DATE_ADD(p_to, INTERVAL 1 DAY)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY c.analysis_id, c.criterion_id ORDER BY c.evaluated_at DESC) = 1
),
per_session AS (  -- a mesma regra da consulta 01: o perfil tem que sair igual
  SELECT a.analysis_id, a.session_id, a.overall_score, a.approval_status,
    ARRAY_AGG(IF(c.applicability_status = 'APPLICABLE' AND c.normalized_score < p_weak, c.criterion_id, NULL) IGNORE NULLS
              ORDER BY c.criterion_weight * (100 - c.normalized_score) DESC, c.criterion_id) AS weak_all
  FROM analyses a LEFT JOIN criteria c ON c.analysis_id = a.analysis_id
  GROUP BY a.analysis_id, a.session_id, a.overall_score, a.approval_status
),
capped AS (
  SELECT * EXCEPT (weak_all), ARRAY(SELECT x FROM UNNEST(weak_all) x WITH OFFSET o WHERE o < p_top_n ORDER BY o) AS worst
  FROM per_session
),
profiled AS (
  SELECT *, IF(ARRAY_LENGTH(worst) = 0, '(sem ponto fraco)', ARRAY_TO_STRING(ARRAY(SELECT x FROM UNNEST(worst) x ORDER BY x), ' + ')) AS profile
  FROM capped
),
summaries AS (  -- no máximo um resumo por análise
  SELECT analysis_id, overall_summary, weaknesses
  FROM `conversation_analytics.session_summaries`
  WHERE organization_id = p_org AND workspace_id = p_ws
    AND DATE(generated_at) BETWEEN p_from AND DATE_ADD(p_to, INTERVAL 1 DAY)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY analysis_id ORDER BY generated_at DESC) = 1
)
SELECT
  p.session_id, p.overall_score, p.approval_status, p.profile,
  s.overall_summary,
  ARRAY(SELECT JSON_VALUE(w, '$.text') FROM UNNEST(JSON_QUERY_ARRAY(s.weaknesses)) w) AS weaknesses,
  ARRAY(SELECT m FROM UNNEST(JSON_QUERY_ARRAY(s.weaknesses)) w, UNNEST(JSON_VALUE_ARRAY(w, '$.message_ids')) m) AS cited_message_ids
FROM profiled p
LEFT JOIN summaries s ON s.analysis_id = p.analysis_id
WHERE p.profile = p_profile
ORDER BY p.overall_score ASC, p.session_id
LIMIT p_limit;

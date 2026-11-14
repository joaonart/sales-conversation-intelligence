-- Visão por critério: onde a equipe vai bem, onde vai mal e onde a rubrica pode estar confusa. Só lê tabelas; ajuste as variáveis do topo.
DECLARE p_project STRING  DEFAULT 'jnart-intelligence-513001';
DECLARE p_org     STRING  DEFAULT 'org-test';
DECLARE p_ws      STRING  DEFAULT 'default';
DECLARE p_rubric  STRING  DEFAULT 'sales_quality';
DECLARE p_version INT64   DEFAULT 4;
DECLARE p_from    DATE    DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY);
DECLARE p_to      DATE    DEFAULT CURRENT_DATE();
DECLARE p_weak    FLOAT64 DEFAULT 60;
SET @@dataset_project_id = p_project;  -- o projeto das tabelas `conversation_analytics.*` abaixo

WITH analyses AS (
  SELECT analysis_id
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
)
SELECT
  criterion_id,
  ANY_VALUE(criterion_weight)                                                AS weight,           -- 0 = critério de portão (decide se outros se aplicam), não mede qualidade
  COUNT(*)                                                                   AS evaluations,
  ROUND(AVG(IF(applicability_status = 'APPLICABLE', normalized_score, NULL)), 1) AS avg_score,
  ROUND(100 * COUNTIF(applicability_status = 'APPLICABLE' AND criterion_weight > 0 AND normalized_score < p_weak)
        / NULLIF(COUNTIF(applicability_status = 'APPLICABLE' AND criterion_weight > 0), 0), 1)        AS weak_pct,          -- % das aplicáveis abaixo do limite
  ROUND(100 * COUNTIF(applicability_status = 'INSUFFICIENT_EVIDENCE') / COUNT(*), 1) AS insufficient_pct,  -- alto: instrução pouco clara ou conversa curta
  ROUND(100 * COUNTIF(applicability_status = 'NOT_APPLICABLE') / COUNT(*), 1) AS not_applicable_pct,
  ROUND(SUM(IF(applicability_status = 'APPLICABLE', criterion_weight * (100 - normalized_score), 0))
        / NULLIF(SUM(IF(applicability_status = 'APPLICABLE', criterion_weight * 100, 0)), 0) * 100, 1) AS points_lost_pct  -- peso do critério na nota perdida
FROM criteria
GROUP BY criterion_id
ORDER BY points_lost_pct DESC;

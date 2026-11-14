-- Perfis de ponto fraco: agrupa as conversas analisadas pelos critérios que mais custaram pontos a cada uma.
-- Não usa IA nem modelo estatístico: é uma regra fixa, então o mesmo dado dá sempre o mesmo agrupamento e cada grupo tem nome legível
-- (ex.: "objection + closing"). Só lê tabelas; não cria nada. Ajuste as variáveis abaixo (a primeira é o projeto).
--
-- Cada conversa recebe o perfil formado pelos até N critérios que mais custaram pontos (peso x distância até 100),
-- considerando apenas critérios aplicáveis com nota abaixo do limite. "Evidência insuficiente" e "não se aplica" nunca contam como nota baixa.
DECLARE p_project STRING  DEFAULT 'jnart-intelligence-513001';
DECLARE p_org     STRING  DEFAULT 'org-test';
DECLARE p_ws      STRING  DEFAULT 'default';
DECLARE p_rubric  STRING  DEFAULT 'sales_quality';
DECLARE p_version INT64   DEFAULT 4;
DECLARE p_from    DATE    DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY);
DECLARE p_to      DATE    DEFAULT CURRENT_DATE();
DECLARE p_weak    FLOAT64 DEFAULT 60;  -- nota (0 a 100) abaixo da qual um critério conta como ponto fraco
DECLARE p_top_n   INT64   DEFAULT 2;   -- quantos critérios formam o perfil
SET @@dataset_project_id = p_project;  -- o projeto das tabelas `conversation_analytics.*` abaixo

WITH analyses AS (  -- a análise mais recente de cada conversa nesta versão da rubrica (a janela de datas limita a leitura da partição)
  SELECT analysis_id, session_id, overall_score, approval_status
  FROM `conversation_analytics.session_analyses`
  WHERE organization_id = p_org AND workspace_id = p_ws
    AND rubric_id = p_rubric AND rubric_version = p_version
    AND DATE(started_at) BETWEEN p_from AND p_to
    AND analysis_status = 'COMPLETED'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY completed_at DESC, analysis_id DESC) = 1
),
criteria AS (  -- uma linha por análise e critério (retentativas não duplicam)
  SELECT c.analysis_id, c.criterion_id, c.applicability_status, c.normalized_score, c.criterion_weight
  FROM `conversation_analytics.session_criterion_results` c
  JOIN analyses a ON a.analysis_id = c.analysis_id
  WHERE c.organization_id = p_org AND c.workspace_id = p_ws
    AND DATE(c.evaluated_at) BETWEEN p_from AND DATE_ADD(p_to, INTERVAL 1 DAY)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY c.analysis_id, c.criterion_id ORDER BY c.evaluated_at DESC) = 1
),
per_session AS (
  SELECT
    a.session_id, a.overall_score, a.approval_status,
    ARRAY_AGG(  -- todos os pontos fracos, do que mais custou ao que menos custou; abaixo fica só o top N
      IF(c.applicability_status = 'APPLICABLE' AND c.normalized_score < p_weak, c.criterion_id, NULL) IGNORE NULLS
      ORDER BY c.criterion_weight * (100 - c.normalized_score) DESC, c.criterion_id
    ) AS weak_all
  FROM analyses a
  LEFT JOIN criteria c ON c.analysis_id = a.analysis_id
  GROUP BY a.session_id, a.overall_score, a.approval_status
),
capped AS (
  SELECT * EXCEPT (weak_all), ARRAY(SELECT x FROM UNNEST(weak_all) x WITH OFFSET o WHERE o < p_top_n ORDER BY o) AS worst
  FROM per_session
),
profiled AS (
  SELECT
    *,
    IF(ARRAY_LENGTH(worst) = 0, '(sem ponto fraco)',
       ARRAY_TO_STRING(ARRAY(SELECT x FROM UNNEST(worst) x ORDER BY x), ' + ')) AS profile  -- ordem fixa: "a + b" é igual a "b + a"
  FROM capped
)
SELECT
  profile,
  COUNT(*)                                                    AS sessions,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)            AS pct_of_sessions,
  ROUND(AVG(overall_score), 1)                                AS avg_score,
  ROUND(100 * COUNTIF(approval_status = 'APPROVED') / COUNT(*), 1) AS approval_rate_pct,
  ARRAY_AGG(session_id ORDER BY overall_score ASC, session_id LIMIT 5) AS lowest_scored_sessions  -- por onde começar a olhar em detalhe
FROM profiled
GROUP BY profile
ORDER BY sessions DESC;

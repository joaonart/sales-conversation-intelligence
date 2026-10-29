/* Local preview only: fakes google.script.run with in-memory data that follows the real rpc contract. Never deployed. */
(function () {
  var role = new URLSearchParams(location.search).get("role") || "ADMIN";
  var tenants = [{ organization_id: "synthetic-a", workspace_id: "default", role: role }, { organization_id: "synthetic-b", workspace_id: "default", role: "VIEWER" }];
  var days = []; for (var i = 29; i >= 0; i--) { var d = new Date(Date.UTC(2026, 9, 28) - i * 864e5).toISOString().slice(0, 10); days.push(d); }
  var rubricsDb = {
    "sales_quality:1": { header: { rubric_id: "sales_quality", version: 1, name: "Qualidade comercial", status: "PUBLISHED", published_at: "2026-10-20T12:00:00.000Z", created_at: "2026-10-20T11:00:00.000Z" } },
    "sales_quality:2": { header: { rubric_id: "sales_quality", version: 2, name: "Qualidade comercial (níveis descritos)", status: "DRAFT", published_at: null, created_at: "2026-10-28T11:00:00.000Z" } }
  };
  function crit(id, name, type, w, req, map, desc, ord, rule) { return { criterion_id: id, criterion_name: name, evaluation_instructions: "Pergunta de avaliação para " + name + "?", evaluation_type: type, weight: w, required: req, enabled: true, score_mapping: map, level_descriptions: desc || {}, applicability_rule: rule || null, display_order: ord }; }
  var draft = { name: "Qualidade comercial (níveis descritos)", description: "Rubrica sintética", criteria: [
    crit("greeting", "Saudação", "PREDICATE", 10, false, { "true": 100, "false": 0 }, {}, 1),
    crit("needs", "Necessidade", "SCORE", 25, true, { none: 0, partial: 50, complete: 100 }, { none: "Não perguntou nada", complete: "Perguntou uso e orçamento" }, 2),
    crit("has_objection", "Cliente levantou objeção?", "PREDICATE", 0, false, { "true": 100, "false": 0 }, {}, 3),
    crit("objections", "Objeções", "SCORE", 25, false, { poor: 0, good: 100 }, { poor: "Ignorou a objeção" }, 4, { criterion_id: "has_objection", equals: ["true"] })],
    policy: { minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null, monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0 } };
  var etag = "e1";
  function issues() { var out = []; if (draft.criteria.some(function (c) { return !c.criterion_id; })) out.push({ path: "criteria", message: "Informe o identificador de todos os critérios." }); return out; }
  var ok = function (data) { return JSON.stringify({ ok: true, data: data, requestId: "mock-req" }); };
  var bad = function (code, message, details) { return JSON.stringify({ ok: false, error: { code: code, message: message, details: details }, requestId: "mock-req" }); };
  function sessions() { var rows = []; for (var k = 0; k < 12; k++) rows.push({ session_id: "s" + (100 + k), channel: k % 2 ? "whatsapp" : "webchat", session_status: "closed", started_at: "2026-10-2" + (k % 8) + "T1" + (k % 9) + ":00:00.000Z",
    analysis_status: k === 3 ? "NEEDS_REVIEW" : k === 7 ? null : "COMPLETED", overall_score: k === 3 || k === 7 ? null : 20 + k * 6, approval_status: k === 3 || k === 7 ? null : (20 + k * 6 >= 70 ? "APPROVED" : "REJECTED"), rubric_id: k === 7 ? null : "sales_quality", rubric_version: k === 7 ? null : 2, model: "gpt-6-luna" }); return rows; }
  var handlers = {
    me: function () { return { email: "ana@empresa.com", memberships: tenants }; },
    "dashboard.summary": function () { return {
      quality: days.map(function (d, i) { return { rubric_id: "sales_quality", rubric_version: 2, day: d, sessions: 4 + (i % 5), scored_sessions: 4 + (i % 5), avg_score: 40 + ((i * 7) % 45), approved: 2, rejected: 2, needs_review: i % 4 === 0 ? 1 : 0, not_evaluable: 0, approval_rate: 0.5 }; }),
      cost: days.slice(-5).map(function (d) { return { day: d, analysis_mode: "historical", model: "gpt-6-luna", analyses: 12, cost_usd: 0.00108, avg_duration_ms: 340 }; }),
      runs: days.slice(-3).map(function (d) { return { day: d, processing_mode: "historical", run_status: "COMPLETED", runs: 1, sessions_processed: 30, sessions_failed: 0, sessions_skipped: 0, actual_cost_usd: 0.0029 }; }) }; },
    "sessions.list": function () { return { rows: sessions(), nextCursor: null }; },
    "sessions.get": function (p) { return {
      session: { session_id: p.sessionId, channel: "whatsapp", status: "closed", started_at: "2026-10-22T10:00:00.000Z" },
      messages: [{ message_id: "m1", sender_type: "customer", content: "Quanto custa o plano? Meu e-mail é [EMAIL]", sequence_number: 1 }, { message_id: "m2", sender_type: "seller", content: "Olá! Para indicar a melhor opção, qual seu uso e orçamento?", sequence_number: 2 }, { message_id: "m3", sender_type: "customer", content: "<script>alert(1)<\/script> Uso no trabalho, até R$ 300.", sequence_number: 3 }],
      analyses: [{ analysis_id: "a1", rubric_id: "sales_quality", rubric_version: 2, analysis_status: "COMPLETED", overall_score: 82.5, approval_status: "APPROVED", model: "gpt-6-luna", prompt_version: "decisions-v1", analysis_mode: "historical", estimated_cost_usd: 0.0001, completed_at: "2026-10-28T12:00:00.000Z" }],
      criteria: [{ analysis_id: "a1", criterion_id: "needs", criterion_weight: 25, evaluation_result: "{\"answer\":\"complete\",\"warnings\":[]}", normalized_score: 100, weighted_score: 60, applicability_status: "APPLICABLE", confidence: null, evidence_message_ids: ["m2"] },
        { analysis_id: "a1", criterion_id: "objections", criterion_weight: 25, evaluation_result: "{}", normalized_score: null, weighted_score: null, applicability_status: "NOT_APPLICABLE", confidence: null, evidence_message_ids: [] }], truncated: false }; },
    "review.list": function () { return [{ session_id: "s103", rubric_id: "sales_quality", rubric_version: 2, analysis_id: "a9", completed_at: "2026-10-28T12:00:00.000Z" }]; },
    "runs.list": function () { return [{ run_id: "hist-3cbac5193cf8d6aa42575193", rubric_id: "sales_quality", rubric_version: 2, processing_mode: "historical", run_status: "COMPLETED_WITH_FAILURES", sessions_total: 10, sessions_processed: 2, sessions_failed: 8, sessions_skipped: 0, estimated_cost_usd: 0.0078, actual_cost_usd: 0.0064, created_at: "2026-10-28T12:00:00.000Z", finished_at: "2026-10-28T12:01:00.000Z" }]; },
    "rubrics.list": function () { return Object.keys(rubricsDb).map(function (k) { return rubricsDb[k].header; }).reverse(); },
    "rubrics.get": function (p) { var r = rubricsDb[p.rubric_id + ":" + p.version]; if (!r) throw ["NOT_FOUND", "Rubrica não encontrada."]; var d = p.version === 2 ? draft : { name: r.header.name, description: "", criteria: draft.criteria, policy: draft.policy }; return { header: r.header, draft: JSON.parse(JSON.stringify(d)), etag: etag, issues: p.version === 2 ? issues() : [] }; },
    "rubrics.saveDraft": function (p) { if (p.etag !== etag) throw ["CONFLICT", "O rascunho foi alterado por outra pessoa. Recarregue antes de salvar."]; draft = p.draft; etag = "e" + (Number(etag.slice(1)) + 1); return { etag: etag, issues: issues() }; },
    "rubrics.publish": function (p) { if (issues().length) throw ["INVALID_INPUT", "A rubrica tem pendências e não pode ser publicada.", ["criteria: Informe o identificador"]]; rubricsDb["sales_quality:2"].header.status = "PUBLISHED"; return { version: 2, criteria: draft.criteria.length }; },
    "rubrics.deleteDraft": function () { delete rubricsDb["sales_quality:2"]; return { deleted: true }; },
    "rubrics.createDraft": function (p) { rubricsDb[p.rubric_id + ":3"] = { header: { rubric_id: p.rubric_id, version: 3, name: p.name, status: "DRAFT", published_at: null, created_at: new Date().toISOString() } }; return { version: 3 }; },
    "users.list": function () { return [{ email: "ana@empresa.com", role: "ADMIN", status: "ACTIVE", changed_at: "2026-10-27T12:00:00.000Z", changed_by: "bootstrap" }, { email: "bruno@empresa.com", role: "VIEWER", status: "ACTIVE", changed_at: "2026-10-28T12:00:00.000Z", changed_by: "ana@empresa.com" }]; },
    "users.upsert": function (p) { return { email: p.email, role: p.role, status: p.status }; },
    "audit.list": function () { return [{ event_id: "e1", occurred_at: "2026-10-28T12:00:00.000Z", actor_email: "ana@empresa.com", action: "rubrics.publish", entity_type: "rubrics", entity_id: "sales_quality", outcome: "SUCCESS", details: "{\"version\":1,\"criteria\":5}", request_id: "r1" },
      { event_id: "e2", occurred_at: "2026-10-28T12:05:00.000Z", actor_email: "bruno@empresa.com", action: "session.view", entity_type: "session", entity_id: "s101", outcome: "SUCCESS", details: "{}", request_id: "r2" }]; }
  };
  function make(onOk, onFail) {
    var api = { withSuccessHandler: function (f) { return make(f, onFail); }, withFailureHandler: function (f) { return make(onOk, f); },
      rpc: function (json) { setTimeout(function () { var req = JSON.parse(json), res;
        try { var m = handlers[req.method]; if (!m) throw ["INVALID_INPUT", "Método desconhecido."]; res = ok(m(req.payload || {})); } catch (e) { res = Array.isArray(e) ? bad(e[0], e[1], e[2]) : bad("INTERNAL", "Erro interno."); }
        onOk(res); }, 120); } };
    return api;
  }
  window.google = { script: { run: make(function () {}, function () {}) } };
})();

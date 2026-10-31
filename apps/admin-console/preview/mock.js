/* Local preview only: fakes google.script.run with in-memory data that follows the real rpc contract. Never deployed. */
(function () {
  var role = new URLSearchParams(location.search).get("role") || "ADMIN";
  // ?photo=none shows the initials; ?photo=bad serves an image that fails to load (the fallback); default uses Google's public default avatar host (allowed host, real image).
  var photo = new URLSearchParams(location.search).get("photo");
  var PROFILE = photo === "none" ? { name: null, photo_url: null } : { name: "Ana Souza", photo_url: photo === "bad" ? "https://lh3.googleusercontent.com/a/does-not-exist-sci=s128-c" : "https://lh3.googleusercontent.com/a/default-user=s128-c" };
  // Generic keyset paging for the preview: the cursor holds the id of the last row of the previous page.
  function pageOf(all, p, idOf) {
    var at = 0, key = p.cursor ? (p.cursor.id !== undefined ? p.cursor.id : p.cursor.key) : null;
    if (key !== null) for (var k = 0; k < all.length; k++) if (idOf(all[k]) === key) { at = k + 1; break; }
    var rows = all.slice(at, at + p.limit), last = rows[rows.length - 1], more = at + p.limit < all.length && last;
    return { rows: rows, nextCursor: more ? (p.byKey ? { key: idOf(last) } : { at: "2026-10-01T00:00:00.123456Z", id: idOf(last) }) : null };
  }
  var REVIEW_ALL = []; for (var rq = 0; rq < 63; rq++) REVIEW_ALL.push({ session_id: "s" + (2000 + rq), rubric_id: "sales_quality", rubric_version: 2, analysis_id: "q" + rq, completed_at: new Date(Date.UTC(2026, 9, 28, 20) - rq * 5400e3).toISOString(),
    criteria: rq % 4 === 1 ? null : 6, insufficient: rq % 4 === 0 ? 2 : 0, decision: rq % 9 === 5 ? "CONFIRMED" : null, decided_at: rq % 9 === 5 ? "2026-10-28T21:00:00.000Z" : null, reviewer_email: rq % 9 === 5 ? "ana@empresa.com" : null });
  var RUNS_ALL = []; for (var rn = 0; rn < 71; rn++) RUNS_ALL.push({ run_id: "run-" + String(9000 - rn), rubric_id: "sales_quality", rubric_version: 2, processing_mode: rn % 3 ? "live" : "historical", run_status: rn % 17 === 0 ? "FAILED" : "COMPLETED",
    sessions_total: 30, sessions_processed: 30 - (rn % 17 === 0 ? 4 : 0), sessions_failed: rn % 17 === 0 ? 4 : 0, sessions_skipped: 0, estimated_cost_usd: 0.003, actual_cost_usd: 0.0029, created_at: new Date(Date.UTC(2026, 9, 28, 12) - rn * 7200e3).toISOString(), finished_at: null });
  var USERS_ALL = []; for (var us = 0; us < 58; us++) USERS_ALL.push({ email: us === 0 ? "ana@empresa.com" : "pessoa" + String(100 + us).slice(1) + "@empresa.com", role: us === 0 ? "ADMIN" : us % 7 === 0 ? "EDITOR" : "VIEWER", status: us % 11 === 5 ? "DISABLED" : "ACTIVE", changed_at: "2026-10-2" + (us % 9) + "T09:00:00.000Z", changed_by: "ana@empresa.com" });
  USERS_ALL.sort(function (x, y) { return x.email < y.email ? -1 : 1; });
  var AUDIT_ALL = []; for (var au = 0; au < 133; au++) AUDIT_ALL.push({ event_id: "ev" + String(1000 - au), occurred_at: new Date(Date.UTC(2026, 9, 28, 20) - au * 1800e3).toISOString(), actor_email: "ana@empresa.com", action: au % 5 ? "session.view" : "users.upsert", entity_type: au % 5 ? "session" : "user", entity_id: au % 5 ? "s" + (1000 + au) : "bruno@empresa.com", outcome: au % 23 === 0 ? "DENIED" : "SUCCESS", details: au % 5 ? "{}" : "{\"role\":\"VIEWER\"}", request_id: "r" + au });
  var RUB_IDS = []; for (var rb = 0; rb < 14; rb++) RUB_IDS.push("rubrica_" + String(10 + rb));
  var decidedIds = {}, decisionRows = [{ decision_id: "d0", analysis_id: "a3", decision: "DISAGREED", comment: "O vendedor tratou a objeção, mas o modelo não achou a evidência.", reviewer_email: "ana@empresa.com", decided_at: "2026-10-26T09:30:00.000Z" }];
  // Sessions that sit in the review queue: s103 (2 criteria without evidence), s104 (too short, no criteria), s105 (uncertain), s90 (already decided).
  var REVIEW = { s103: { aid: "a9", crit: true, ins: 2 }, s104: { aid: "a10", crit: false, ins: 0 }, s105: { aid: "a11", crit: true, ins: 0 }, s90: { aid: "a3", crit: true, ins: 1 } };
  function reviewable(sid, d) {
    var r = REVIEW[sid]; d.decisions = []; if (!r) return d;
    // Like the real review sessions: the conversation holds only bot messages (menu and queue notice).
    if (sid === "s104") d.messages = [{ message_id: "m1", sender_type: "bot", content: "Olá! Sou a assistente virtual da TecnoCasa. Digite 1 para vendas, 2 para suporte.", created_at: "2026-10-09T21:10:52Z", sequence_number: 1 }, { message_id: "m2", sender_type: "bot", content: "Você está na fila. Em breve Roberto vai te atender.", created_at: "2026-10-09T21:11:03Z", sequence_number: 2 }];
    d.analyses = [{ analysis_id: r.aid, rubric_id: "sales_quality", rubric_version: 2, analysis_status: "NEEDS_REVIEW", overall_score: r.crit ? 48 : null, approval_status: null, approval_reason: r.ins ? { minimum: 70, overall: null, reasons: [{ code: "INSUFFICIENT_EVIDENCE", criterion_id: "needs", required: true }] } : null, model: "gpt-6-luna", prompt_version: "decisions-v1", analysis_mode: "historical", estimated_cost_usd: 0.0001, completed_at: "2026-10-28T12:00:00.000Z" }];
    d.criteria = r.crit ? ["needs", "objections", "closing"].map(function (c, k) { return { analysis_id: r.aid, criterion_id: c, criterion_weight: 25, evaluation_result: "{}", normalized_score: k < r.ins ? null : 60, weighted_score: null, applicability_status: k < r.ins ? "INSUFFICIENT_EVIDENCE" : "APPLICABLE", confidence: null, evidence_message_ids: k === 2 ? ["m2"] : [] }; }) : [];
    d.decisions = decisionRows.filter(function (x) { return x.analysis_id === r.aid; });
    return d;
  }
  var tenants = [{ organization_id: "synthetic-a", workspace_id: "default", role: role }, { organization_id: "synthetic-b", workspace_id: "default", role: "VIEWER" }];
  if (new URLSearchParams(location.search).get("ws") === "1") tenants = tenants.slice(0, 1); // ?ws=1 previews a user with a single workspace
  var days = []; for (var i = 29; i >= 0; i--) { var d = new Date(Date.UTC(2026, 9, 28) - i * 864e5).toISOString().slice(0, 10); days.push(d); }
  var rubricsDb = {
    "sales_quality:1": { header: { rubric_id: "sales_quality", version: 1, name: "Qualidade comercial", status: "PUBLISHED", published_at: "2026-10-20T12:00:00.000Z", created_at: "2026-10-20T11:00:00.000Z" } },
    "sales_quality:2": { header: { rubric_id: "sales_quality", version: 2, name: "Qualidade comercial (níveis descritos)", status: "DRAFT", published_at: null, created_at: "2026-10-28T11:00:00.000Z" } }
  };
  function crit(id, name, type, w, req, map, desc, ord, rule) { return { criterion_id: id, criterion_name: name, evaluation_instructions: "Pergunta de avaliação para " + name + "?", evaluation_type: type, weight: w, required: req, enabled: true, score_mapping: map, level_descriptions: desc || {}, applicability_rule: rule || null, display_order: ord }; }
  var draft = { name: "Qualidade comercial (níveis descritos)", description: "Rubrica sintética", criteria: [
    crit("is_sales", "É uma conversa de venda?", "PREDICATE", 0, false, { "true": 100, "false": 0 }, {}, 0),
    crit("greeting", "Saudação", "PREDICATE", 10, false, { "true": 100, "false": 0 }, {}, 1, { conditions: [{ criterion_id: "is_sales", equals: ["true"] }] }),
    crit("needs", "Necessidade", "SCORE", 25, true, { none: 0, partial: 50, complete: 100 }, { none: "Não perguntou nada", complete: "Perguntou uso e orçamento" }, 2),
    crit("has_objection", "Cliente levantou objeção?", "PREDICATE", 0, false, { "true": 100, "false": 0 }, {}, 3),
    crit("objections", "Objeções", "SCORE", 25, false, { poor: 0, good: 100 }, { poor: "Ignorou a objeção" }, 4, { conditions: [{ criterion_id: "is_sales", equals: ["true"] }, { criterion_id: "has_objection", equals: ["true"] }] })],
    policy: { minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null, monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0 } };
  var etag = "e1";
  function issues() { var out = []; if (draft.criteria.some(function (c) { return !c.criterion_id; })) out.push({ path: "criteria", message: "Informe o identificador de todos os critérios." }); return out; }
  var ok = function (data) { return JSON.stringify({ ok: true, data: data, requestId: "mock-req" }); };
  var bad = function (code, message, details) { return JSON.stringify({ ok: false, error: { code: code, message: message, details: details }, requestId: "mock-req" }); };
  // 237 sessions, newest first, so the pager, the filters and the total have something to work on.
  var CHANNELS = ["webchat", "whatsapp", "email"], RUBRICS = ["sales_quality", "support_quality"], RESULTS = ["APPROVED", "REJECTED", "PENDING", "N_A"];
  var BIG = []; for (var n = 0; n < 237; n++) BIG.push({ session_id: "s" + (1000 + n), channel: CHANNELS[n % 3], session_status: "closed", started_at: new Date(Date.UTC(2026, 9, 28, 20, 0, 0) - n * 3600e3).toISOString(),
    analysis_status: n % 11 === 0 ? "NEEDS_REVIEW" : n % 13 === 0 ? null : "COMPLETED", overall_score: n % 11 === 0 || n % 13 === 0 ? null : 20 + (n * 7) % 80, approval_status: n % 11 === 0 ? "PENDING" : n % 13 === 0 ? null : RESULTS[n % 2],
    rubric_id: n % 13 === 0 ? null : RUBRICS[n % 2], rubric_version: 2, model: "gpt-6-luna" });
  function allSessions(p) { return BIG.filter(function (r) { return (!p.channel || r.channel === p.channel) && (!p.result || r.approval_status === p.result) && (!p.rubric || r.rubric_id === p.rubric)
    && (!p.status || (p.status === "UNANALYSED" ? !r.analysis_status : r.analysis_status === p.status)) && (!p.query || r.session_id === p.query); }); }
  function sessions() { var rows = []; for (var k = 0; k < 12; k++) rows.push({ session_id: "s" + (100 + k), channel: k % 2 ? "whatsapp" : "webchat", session_status: "closed", started_at: "2026-10-2" + (k % 8) + "T1" + (k % 9) + ":00:00.000Z",
    analysis_status: k === 3 ? "NEEDS_REVIEW" : k === 7 ? null : "COMPLETED", overall_score: k === 3 || k === 7 ? null : 20 + k * 6, approval_status: k === 3 || k === 7 ? null : (20 + k * 6 >= 70 ? "APPROVED" : "REJECTED"), rubric_id: k === 7 ? null : "sales_quality", rubric_version: k === 7 ? null : 2, model: "gpt-6-luna" }); return rows; }
  var handlers = {
    me: function () { return { email: "ana@empresa.com", memberships: tenants, profile: PROFILE, app_url: "https://script.google.com/a/macros/j-nart.com/s/AKfycbyPREVIEW/exec" }; },
    "pipeline.overview": function () { return {
      source: [{ sessions: 29 }], decided: [{ decided: 1 }], cost: [{ analyses: 24, cost_usd: 0.1335 }], models: [{ model: "gpt-4o", analysis_mode: "historical", analyses: 24 }],
      results: [{ analysis_status: "COMPLETED", approval_status: "APPROVED", analyses: 7 }, { analysis_status: "COMPLETED", approval_status: "REJECTED", analyses: 10 }, { analysis_status: "NEEDS_REVIEW", approval_status: "PENDING", analyses: 2 }, { analysis_status: "NOT_EVALUABLE", approval_status: "N_A", analyses: 5 }],
      lastRun: [{ processing_mode: "historical", run_status: "COMPLETED", sessions_processed: 14, created_at: "2026-10-29T21:10:00.000Z" }] }; },
    "dashboard.summary": function () { return {
      quality: days.map(function (d, i) { return { rubric_id: "sales_quality", rubric_version: 2, day: d, sessions: 4 + (i % 5), scored_sessions: 4 + (i % 5), avg_score: 40 + ((i * 7) % 45), approved: 2, rejected: 2, needs_review: i % 4 === 0 ? 1 : 0, not_evaluable: 0, approval_rate: 0.5 }; }),
      cost: days.slice(-5).map(function (d) { return { day: d, analysis_mode: "historical", model: "gpt-6-luna", analyses: 12, cost_usd: 0.00108, avg_duration_ms: 340 }; }),
      runs: days.slice(-3).map(function (d) { return { day: d, processing_mode: "historical", run_status: "COMPLETED", runs: 1, sessions_processed: 30, sessions_failed: 0, sessions_skipped: 0, actual_cost_usd: 0.0029 }; }) }; },
    "sessions.list": function (p) { var all = allSessions(p), at = 0;
      if (p.cursor) { for (var k = 0; k < all.length; k++) if (all[k].session_id === p.cursor.session_id) { at = k + 1; break; } }
      var rows = all.slice(at, at + p.limit); var last = rows[rows.length - 1];
      return { rows: rows, nextCursor: at + p.limit < all.length && last ? { started_at: "2026-10-01T00:00:00.123456Z", session_id: last.session_id } : null }; },
    "sessions.count": function (p) { return { total: allSessions(p).length }; },
    "sessions.channels": function () { return ["email", "webchat", "whatsapp"]; },
    "sessions.get": function (p) { return reviewable(p.sessionId, {
      session: { session_id: p.sessionId, channel: "whatsapp", status: "closed", started_at: "2026-10-22T10:00:00.000Z" },
      messages: [{ message_id: "m0", sender_type: "bot", content: "Atendimento iniciado pelo assistente virtual.", created_at: "2026-10-22T10:00:00Z", sequence_number: 0 }, { message_id: "m1", sender_type: "customer", content: "Quanto custa o plano? Meu e-mail é [EMAIL]", created_at: "2026-10-22T10:01:00Z", sequence_number: 1 }, { message_id: "m2", sender_type: "seller", content: "Olá! Para indicar a melhor opção, qual seu uso e orçamento?", created_at: "2026-10-22T10:02:00Z", sequence_number: 2 }, { message_id: "m3", sender_type: "customer", content: "<script>alert(1)<\/script> Uso no trabalho, até R$ 300.", created_at: "2026-10-22T10:05:00Z", sequence_number: 3 }, { message_id: "m4", sender_type: "seller", content: "Perfeito. Uma mensagem bem longa para conferir a quebra de linha e o limite de largura do balão: " + "texto ".repeat(40) + "\nSegunda linha.", created_at: "2026-10-23T09:15:00Z", sequence_number: 4 }, { message_id: "m5", sender_type: "system", content: "Conversa encerrada.", created_at: "2026-10-23T09:20:00Z", sequence_number: 5 }],
      analyses: [{ analysis_id: "a1", rubric_id: "sales_quality", rubric_version: 2, analysis_status: "COMPLETED", overall_score: 87.5, approval_status: "REJECTED", approval_reason: { minimum: 70, overall: 87.5, reasons: [{ code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs", score: 50 }] }, model: "gpt-6-luna", prompt_version: "decisions-v1", analysis_mode: "historical", estimated_cost_usd: 0.0001, completed_at: "2026-10-28T12:00:00.000Z" }],
      criteria: [{ analysis_id: "a1", criterion_id: "needs", criterion_name: "Necessidade", criterion_weight: 25, evaluation_result: "{\"answer\":\"complete\",\"warnings\":[]}", normalized_score: 100, weighted_score: 60, applicability_status: "APPLICABLE", confidence: null, evidence_message_ids: ["m2"] },
        { analysis_id: "a1", criterion_id: "objections", criterion_name: "Objeções", criterion_weight: 25, evaluation_result: "{}", normalized_score: null, weighted_score: null, applicability_status: "NOT_APPLICABLE", confidence: null, evidence_message_ids: [] }], truncated: false }); },
    "review.list": function (p) { var filter = (p && p.filter) || "pending";
      var all = REVIEW_ALL.map(function (r) { return decidedIds[r.analysis_id] ? Object.assign({}, r, decidedIds[r.analysis_id]) : r; }).filter(function (r) { return filter === "all" || (filter === "decided" ? !!r.decision : !r.decision); });
      return pageOf(all, p, function (r) { return r.analysis_id; }); },
    "review.count": function (p) { return { total: REVIEW_ALL.map(function (r) { return decidedIds[r.analysis_id] ? Object.assign({}, r, decidedIds[r.analysis_id]) : r; }).filter(function (r) { return p.filter === "all" || (p.filter === "decided" ? !!r.decision : !r.decision); }).length }; },
    "review.decide": function (p) { decidedIds[p.analysisId] = { decision: p.decision, decided_at: new Date().toISOString(), reviewer_email: "ana@empresa.com" }; decisionRows.unshift({ decision_id: "d" + decisionRows.length, analysis_id: p.analysisId, decision: p.decision, comment: p.comment || null, reviewer_email: "ana@empresa.com", decided_at: new Date().toISOString() }); return { decision_id: "dx", analysis_id: p.analysisId, decision: p.decision }; },
    "runs.list": function (p) { return pageOf(RUNS_ALL, p, function (r) { return r.run_id; }); },
    "runs.count": function () { return { total: RUNS_ALL.length }; },
    "rubrics.list": function (p) { p.byKey = true; var ids = RUB_IDS.concat(Object.keys(rubricsDb).map(function (k) { return rubricsDb[k].header.rubric_id; }).filter(function (x, i, aa) { return aa.indexOf(x) === i; })).filter(function (x, i, aa) { return aa.indexOf(x) === i; }).sort();
      var pg = pageOf(ids, p, function (x) { return x; });
      pg.rows = pg.rows.reduce(function (acc, id) { var real = Object.keys(rubricsDb).map(function (k) { return rubricsDb[k].header; }).filter(function (hd) { return hd.rubric_id === id; }).reverse();
        return acc.concat(real.length ? real : [{ rubric_id: id, version: 1, name: "Rubrica " + id, status: "PUBLISHED", published_at: "2026-10-20T10:00:00.000Z", created_at: "2026-10-19T10:00:00.000Z", description: "" }]); }, []);
      return pg; },
    "rubrics.count": function () { return { total: RUB_IDS.length + 1 }; },
    "rubrics.ids": function () { return RUB_IDS.concat(["sales_quality"]).sort(); },
    "rubrics.get": function (p) { var r = rubricsDb[p.rubric_id + ":" + p.version]; if (!r) throw ["NOT_FOUND", "Rubrica não encontrada."]; var d = p.version === 2 ? draft : { name: r.header.name, description: "", criteria: draft.criteria, policy: draft.policy }; return { header: r.header, draft: JSON.parse(JSON.stringify(d)), etag: etag, issues: p.version === 2 ? issues() : [] }; },
    "rubrics.saveDraft": function (p) { if (p.etag !== etag) throw ["CONFLICT", "O rascunho foi alterado por outra pessoa. Recarregue antes de salvar."]; draft = p.draft; etag = "e" + (Number(etag.slice(1)) + 1); return { etag: etag, issues: issues() }; },
    "rubrics.publish": function (p) { if (issues().length) throw ["INVALID_INPUT", "A rubrica tem pendências e não pode ser publicada.", ["criteria: Informe o identificador"]]; rubricsDb["sales_quality:2"].header.status = "PUBLISHED"; return { version: 2, criteria: draft.criteria.length }; },
    "rubrics.deleteDraft": function () { delete rubricsDb["sales_quality:2"]; return { deleted: true }; },
    "rubrics.createDraft": function (p) { rubricsDb[p.rubric_id + ":3"] = { header: { rubric_id: p.rubric_id, version: 3, name: p.name, status: "DRAFT", published_at: null, created_at: new Date().toISOString() } }; return { version: 3 }; },
    "users.list": function (p) { p.byKey = true; return pageOf(USERS_ALL, p, function (u) { return u.email; }); },
    "users.count": function () { return { total: USERS_ALL.length }; },
    "users.upsert": function (p) { return { email: p.email, role: p.role, status: p.status }; },
    "audit.list": function (p) { return pageOf(AUDIT_ALL, p, function (e) { return e.event_id; }); },
    "audit.count": function () { return { total: AUDIT_ALL.length }; },
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

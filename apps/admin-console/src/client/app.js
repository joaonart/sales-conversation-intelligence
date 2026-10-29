/* SCI Console client. No innerHTML anywhere: every value is placed with textContent, so data can never become markup. */
(function () {
  "use strict";

  // ---------- helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else if (k === "value") el.value = v;
        else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
        else el.setAttribute(k, v === true ? "" : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { append(el, x); });
    else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function $(sel) { return document.querySelector(sel); }

  var pt = { dt: new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }), d: new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "UTC" }) };
  function fmtDt(s) { var d = s ? new Date(s) : null; return d && !isNaN(d) ? pt.dt.format(d) : "—"; }
  function fmtDay(s) { var d = s ? new Date(s + "T00:00:00Z") : null; return d && !isNaN(d) ? pt.d.format(d) : "—"; }
  function fmtNum(n, digits) { return n === null || n === undefined ? "—" : Number(n).toLocaleString("pt-BR", { maximumFractionDigits: digits === undefined ? 1 : digits }); }
  function fmtUsd(n) { return n === null || n === undefined ? "—" : "US$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: Number(n) < 1 ? 5 : 2 }); }
  function fmtPct(n) { return n === null || n === undefined ? "—" : (Number(n) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + "%"; }
  var STATUS = {
    COMPLETED: ["Concluída", "ok"], NEEDS_REVIEW: ["Revisão necessária", "warn"], NOT_EVALUABLE: ["Não avaliável", ""], FAILED: ["Falha", "bad"],
    APPROVED: ["Aprovada", "ok"], REJECTED: ["Reprovada", "bad"], DRAFT: ["Rascunho", "warn"], PUBLISHED: ["Publicada", "ok"],
    RUNNING: ["Em andamento", "info"], BUDGET_STOPPED: ["Parada por orçamento", "warn"], COMPLETED_WITH_FAILURES: ["Concluída com falhas", "warn"],
    SESSION_GATE_STOPPED: ["Parada por limite", "warn"], SUCCESS: ["Sucesso", "ok"], DENIED: ["Negado", "bad"], ERROR: ["Erro", "bad"],
    ACTIVE: ["Ativo", "ok"], DISABLED: ["Desativado", ""], APPLICABLE: ["Aplicável", "ok"], NOT_APPLICABLE: ["Não aplicável", ""],
    INSUFFICIENT_EVIDENCE: ["Evidência insuficiente", "warn"]
  };
  function badge(s) { if (!s) return h("span", { class: "muted" }, "—"); var m = STATUS[s] || [s, ""]; return h("span", { class: "badge " + m[1] }, m[0]); }
  var ROLE_LABEL = { VIEWER: "Leitor", EDITOR: "Editor", ADMIN: "Administrador" };
  var RANK = { VIEWER: 1, EDITOR: 2, ADMIN: 3 };

  // ---------- api ----------
  function ApiError(e, requestId) { this.code = e.code; this.message = e.message; this.details = e.details || []; this.requestId = requestId; }
  function call(method, payload) {
    return new Promise(function (resolve, reject) {
      google.script.run
        .withSuccessHandler(function (text) {
          var res;
          try { res = JSON.parse(text); } catch (e) { return reject(new ApiError({ code: "INTERNAL", message: "Resposta inválida do servidor." })); }
          if (res.ok) resolve(res.data); else reject(new ApiError(res.error, res.requestId));
        })
        .withFailureHandler(function () { reject(new ApiError({ code: "UNAVAILABLE", message: "Não foi possível falar com o servidor." })); })
        .rpc(JSON.stringify({ method: method, payload: payload || {} }));
    });
  }
  var state = { me: null, tenant: null, role: null };
  function api(method, payload) { return call(method, Object.assign({ tenant: state.tenant }, payload || {})); }

  // ---------- ui primitives ----------
  function toast(msg, bad) {
    var t = h("div", { class: "toast" + (bad ? " bad" : "") }, msg);
    $("#toasts").appendChild(t);
    setTimeout(function () { t.remove(); }, bad ? 7000 : 3500);
  }
  function showError(e) {
    var msg = e && e.message ? e.message : "Erro inesperado.";
    toast(msg, true);
  }
  function confirmModal(title, body, okLabel, danger) {
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      function close(v) { bg.remove(); if (prev && prev.focus) prev.focus(); resolve(v); }
      var ok = h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: function () { close(true); } }, okLabel);
      var no = h("button", { class: "btn", onclick: function () { close(false); } }, "Cancelar");
      var bg = h("div", { class: "modal-bg", onkeydown: function (e) { if (e.key === "Escape") close(false); } },
        h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", null, title), body, h("div", { class: "actions" }, no, ok)));
      document.body.appendChild(bg);
      no.focus();
    });
  }
  function emptyState(text) { return h("div", { class: "empty" }, text); }
  function table(cols, rows, onRow) {
    var head = h("tr", null, cols.map(function (c) { return h("th", { class: c.num ? "num" : "" }, c.label); }));
    var body = rows.map(function (r) {
      var tr = h("tr", onRow ? { tabindex: "0", style: "cursor:pointer", onclick: function () { onRow(r); }, onkeydown: function (e) { if (e.key === "Enter") onRow(r); } } : null,
        cols.map(function (c) { return h("td", { class: c.num ? "num" : "" }, c.render ? c.render(r) : r[c.key] === null || r[c.key] === undefined ? "—" : r[c.key]); }));
      return tr;
    });
    return h("div", { class: "scroll" }, h("table", null, h("thead", null, head), h("tbody", null, body)));
  }
  function loading() { return h("p", { class: "muted" }, "Carregando…"); }
  function pageHead(title, sub, actions) {
    return h("div", { class: "head" }, h("div", null, h("h1", null, title), sub ? h("div", { class: "sub" }, sub) : null), h("div", { class: "spacer" }), actions);
  }

  // ---------- views ----------
  var VIEWS = {};

  VIEWS.dashboard = function (root) {
    var days = 30;
    var box = h("div", null, loading());
    function load() {
      clear(box); box.appendChild(loading());
      api("dashboard.summary", { days: days }).then(function (d) {
        clear(box);
        var q = d.quality, scored = 0, sum = 0, appr = 0, rej = 0, rev = 0, sessions = 0;
        q.forEach(function (r) { sessions += r.sessions; scored += r.scored_sessions; sum += (r.avg_score || 0) * r.scored_sessions; appr += r.approved; rej += r.rejected; rev += r.needs_review; });
        var cost = d.cost.reduce(function (a, r) { return a + (Number(r.cost_usd) || 0); }, 0);
        var byDay = {};
        q.forEach(function (r) { var o = byDay[r.day] || (byDay[r.day] = { n: 0, s: 0 }); o.n += r.scored_sessions; o.s += (r.avg_score || 0) * r.scored_sessions; });
        var dayKeys = Object.keys(byDay).sort();
        box.appendChild(h("div", { class: "grid" },
          kpi("Sessões analisadas", fmtNum(sessions, 0)), kpi("Nota média", scored ? fmtNum(sum / scored) : "—"),
          kpi("Taxa de aprovação", appr + rej ? fmtPct(appr / (appr + rej)) : "—"), kpi("Em revisão", fmtNum(rev, 0)), kpi("Custo de IA", fmtUsd(cost))));
        box.appendChild(h("div", { class: "card" }, h("h2", null, "Nota média por dia"),
          dayKeys.length ? [h("div", { class: "bars", role: "img", "aria-label": "Nota média diária" }, dayKeys.map(function (k) {
            var v = byDay[k].n ? byDay[k].s / byDay[k].n : 0;
            return h("div", { class: "bar", style: "height:" + Math.max(2, v) + "%", title: fmtDay(k) + ": " + fmtNum(v) });
          })), h("div", { class: "axis" }, h("span", null, fmtDay(dayKeys[0])), h("span", null, fmtDay(dayKeys[dayKeys.length - 1])))] : emptyState("Sem análises no período.")));
        box.appendChild(h("div", { class: "card" }, h("h2", null, "Custo por modelo"), d.cost.length ? table(
          [{ label: "Dia", render: function (r) { return fmtDay(r.day); } }, { label: "Modo", key: "analysis_mode" }, { label: "Modelo", key: "model" },
            { label: "Análises", num: 1, render: function (r) { return fmtNum(r.analyses, 0); } }, { label: "Custo", num: 1, render: function (r) { return fmtUsd(r.cost_usd); } },
            { label: "Duração média", num: 1, render: function (r) { return r.avg_duration_ms === null ? "—" : fmtNum(r.avg_duration_ms, 0) + " ms"; } }], d.cost.slice().reverse().slice(0, 30)) : emptyState("Sem custo registrado.")));
        box.appendChild(h("div", { class: "card" }, h("h2", null, "Saúde das execuções"), d.runs.length ? table(
          [{ label: "Dia", render: function (r) { return fmtDay(r.day); } }, { label: "Modo", key: "processing_mode" }, { label: "Status", render: function (r) { return badge(r.run_status); } },
            { label: "Execuções", num: 1, key: "runs" }, { label: "Processadas", num: 1, key: "sessions_processed" }, { label: "Falhas", num: 1, key: "sessions_failed" },
            { label: "Custo", num: 1, render: function (r) { return fmtUsd(r.actual_cost_usd); } }], d.runs.slice().reverse().slice(0, 30)) : emptyState("Sem execuções.")));
      }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
    }
    function kpi(l, v) { return h("div", { class: "kpi" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l)); }
    var sel = h("select", { "aria-label": "Período", onchange: function () { days = Number(sel.value); load(); } },
      [7, 30, 90, 180].map(function (n) { return h("option", { value: n, selected: n === days }, "Últimos " + n + " dias"); }));
    root.appendChild(pageHead("Painel", "Qualidade, custo e saúde do processamento", sel));
    root.appendChild(box); load();
  };

  VIEWS.sessions = function (root, parts) {
    if (parts[0]) return sessionDetail(root, parts[0]);
    var today = new Date(), from = new Date(today.getTime() - 29 * 864e5);
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    var f = { from: iso(from), to: iso(today), status: "", query: "" };
    var out = h("div", null);
    var cursor = null;
    function search(more) {
      if (!more) { clear(out); cursor = null; out.appendChild(loading()); }
      api("sessions.list", { from: f.from, to: f.to, status: f.status, query: f.query, limit: 50, cursor: cursor }).then(function (res) {
        if (!more) clear(out); else { var b = out.querySelector(".more"); if (b) b.remove(); }
        if (!more && !res.rows.length) { out.appendChild(emptyState("Nenhuma sessão encontrada.")); return; }
        var t = table([
          { label: "Sessão", render: function (r) { return h("span", { class: "mono" }, r.session_id); } }, { label: "Início", render: function (r) { return fmtDt(r.started_at); } },
          { label: "Canal", key: "channel" }, { label: "Status", render: function (r) { return r.analysis_status ? badge(r.analysis_status) : h("span", { class: "muted" }, "Não analisada"); } },
          { label: "Nota", num: 1, render: function (r) { return fmtNum(r.overall_score); } }, { label: "Resultado", render: function (r) { return badge(r.approval_status); } },
          { label: "Rubrica", render: function (r) { return r.rubric_id ? r.rubric_id + " v" + r.rubric_version : "—"; } }], res.rows,
          function (r) { location.hash = "#/sessions/" + encodeURIComponent(r.session_id); });
        out.appendChild(t);
        cursor = res.nextCursor;
        if (cursor) out.appendChild(h("div", { class: "more row" }, h("button", { class: "btn", onclick: function () { search(true); } }, "Carregar mais")));
      }).catch(function (e) { clear(out); out.appendChild(h("div", { class: "alert bad" }, e.message)); });
    }
    function field(label, el) { return h("label", null, label, el); }
    var form = h("form", { class: "row", onsubmit: function (e) { e.preventDefault(); search(false); } },
      field("De", h("input", { type: "date", value: f.from, onchange: function (e) { f.from = e.target.value; } })),
      field("Até", h("input", { type: "date", value: f.to, onchange: function (e) { f.to = e.target.value; } })),
      field("Status", h("select", { onchange: function (e) { f.status = e.target.value; } },
        [["", "Todos"], ["COMPLETED", "Concluída"], ["NEEDS_REVIEW", "Revisão necessária"], ["NOT_EVALUABLE", "Não avaliável"], ["FAILED", "Falha"], ["UNANALYSED", "Não analisada"]]
          .map(function (o) { return h("option", { value: o[0] }, o[1]); }))),
      field("ID da sessão", h("input", { type: "search", placeholder: "exato", maxlength: "128", oninput: function (e) { f.query = e.target.value.trim(); } })),
      h("button", { class: "btn primary", type: "submit" }, "Buscar"));
    root.appendChild(pageHead("Sessões", "Conversas e a análise mais recente de cada rubrica"));
    root.appendChild(h("div", { class: "card" }, form, out));
    search(false);
  };

  function sessionDetail(root, rawId) {
    var id = decodeURIComponent(rawId);
    root.appendChild(pageHead("Sessão " + id, null, h("a", { class: "btn", href: "#/sessions" }, "Voltar")));
    var box = h("div", null, loading()); root.appendChild(box);
    api("sessions.get", { sessionId: id }).then(function (d) {
      clear(box);
      box.appendChild(h("div", { class: "alert info" }, "Conteúdo mascarado (CPF, CNPJ, e-mail, telefone). Nomes não são mascarados. Este acesso foi registrado na auditoria."));
      box.appendChild(h("div", { class: "card" }, h("h2", null, "Resumo"), h("p", null, "Canal: ", d.session.channel || "—", " · Início: ", fmtDt(d.session.started_at), " · Status: ", d.session.status || "—")));
      var highlight = {};
      d.analyses.forEach(function (a) {
        var crit = d.criteria.filter(function (c) { return c.analysis_id === a.analysis_id; });
        box.appendChild(h("div", { class: "card" },
          h("h2", null, a.rubric_id + " v" + a.rubric_version, " ", badge(a.analysis_status), " ", badge(a.approval_status)),
          h("p", { class: "muted" }, "Nota: ", h("strong", null, fmtNum(a.overall_score)), " · Modelo: ", a.model || "—", " · Prompt: ", a.prompt_version || "—", " · Modo: ", a.analysis_mode, " · Custo: ", fmtUsd(a.estimated_cost_usd), " · ", fmtDt(a.completed_at)),
          table([{ label: "Critério", render: function (r) { return h("span", { class: "mono" }, r.criterion_id); } }, { label: "Aplicabilidade", render: function (r) { return badge(r.applicability_status); } },
            { label: "Resposta", render: function (r) { var x = parseJson(r.evaluation_result); return x && x.answer !== undefined && x.answer !== null ? String(x.answer) : "—"; } },
            { label: "Nota", num: 1, render: function (r) { return fmtNum(r.normalized_score, 0); } }, { label: "Peso", num: 1, render: function (r) { return fmtNum(r.criterion_weight); } },
            { label: "Evidências", render: function (r) { return (r.evidence_message_ids || []).length ? (r.evidence_message_ids || []).join(", ") : "—"; } }], crit)));
        crit.forEach(function (c) { (c.evidence_message_ids || []).forEach(function (m) { highlight[m] = true; }); });
      });
      if (!d.analyses.length) box.appendChild(h("div", { class: "card" }, emptyState("Sessão ainda não analisada.")));
      box.appendChild(h("div", { class: "card" }, h("h2", null, "Mensagens", d.truncated ? " (truncado)" : ""),
        d.messages.length ? d.messages.map(function (m) {
          return h("div", { class: "msg " + (m.sender_type || "") + (highlight[m.message_id] ? " hl" : "") },
            h("div", { class: "meta" }, "#" + (m.sequence_number === null ? "?" : m.sequence_number), " · ", m.sender_type || "?", " · ", h("span", { class: "mono" }, m.message_id), highlight[m.message_id] ? " · evidência" : ""), m.content);
        }) : emptyState("Sem mensagens.")));
    }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
  }
  function parseJson(t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }

  VIEWS.review = function (root) {
    var box = h("div", { class: "card" }, loading());
    root.appendChild(pageHead("Fila de revisão", "Sessões com evidência insuficiente ou decisão incerta: exigem revisão humana"));
    root.appendChild(box);
    api("review.list", { limit: 200 }).then(function (rows) {
      clear(box);
      box.appendChild(rows.length ? table([{ label: "Sessão", render: function (r) { return h("span", { class: "mono" }, r.session_id); } }, { label: "Rubrica", render: function (r) { return r.rubric_id + " v" + r.rubric_version; } },
        { label: "Concluída em", render: function (r) { return fmtDt(r.completed_at); } }], rows, function (r) { location.hash = "#/sessions/" + encodeURIComponent(r.session_id); }) : emptyState("Nada aguardando revisão."));
    }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
  };

  VIEWS.runs = function (root) {
    var box = h("div", { class: "card" }, loading());
    root.appendChild(pageHead("Execuções", "Histórico e processamento live (última linha de cada execução)"));
    root.appendChild(box);
    api("runs.list", { days: 90, limit: 200 }).then(function (rows) {
      clear(box);
      box.appendChild(rows.length ? table([{ label: "Execução", render: function (r) { return h("span", { class: "mono" }, r.run_id); } }, { label: "Modo", key: "processing_mode" }, { label: "Status", render: function (r) { return badge(r.run_status); } },
        { label: "Rubrica", render: function (r) { return r.rubric_id ? r.rubric_id + " v" + r.rubric_version : "—"; } }, { label: "Total", num: 1, key: "sessions_total" }, { label: "OK", num: 1, key: "sessions_processed" },
        { label: "Falhas", num: 1, key: "sessions_failed" }, { label: "Puladas", num: 1, key: "sessions_skipped" }, { label: "Custo", num: 1, render: function (r) { return fmtUsd(r.actual_cost_usd); } },
        { label: "Criada", render: function (r) { return fmtDt(r.created_at); } }], rows) : emptyState("Nenhuma execução."));
    }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
  };

  VIEWS.rubrics = function (root, parts) {
    if (parts[0] && parts[1]) return rubricEditor(root, decodeURIComponent(parts[0]), Number(parts[1]));
    var box = h("div", null, loading());
    var canEdit = RANK[state.role] >= RANK.EDITOR;
    root.appendChild(pageHead("Rubricas", "Rubricas publicadas são imutáveis: para mudar, crie uma nova revisão", canEdit ? h("button", { class: "btn primary", onclick: newRubric }, "Nova rubrica") : null));
    root.appendChild(box);
    function load() {
      clear(box); box.appendChild(loading());
      api("rubrics.list").then(function (rows) {
        clear(box);
        if (!rows.length) { box.appendChild(h("div", { class: "card" }, emptyState("Nenhuma rubrica ainda."))); return; }
        var groups = {};
        rows.forEach(function (r) { (groups[r.rubric_id] = groups[r.rubric_id] || []).push(r); });
        Object.keys(groups).forEach(function (rid) {
          var versions = groups[rid], hasDraft = versions.some(function (v) { return v.status === "DRAFT"; });
          var latestPub = versions.filter(function (v) { return v.status === "PUBLISHED"; })[0];
          box.appendChild(h("div", { class: "card" }, h("div", { class: "row" }, h("h2", { style: "margin:0" }, rid), h("div", { class: "spacer" }),
            canEdit && latestPub && !hasDraft ? h("button", { class: "btn small", onclick: function () { reviseRubric(rid, latestPub.version, latestPub.name); } }, "Nova revisão a partir da v" + latestPub.version) : null),
            table([{ label: "Versão", render: function (r) { return "v" + r.version; } }, { label: "Nome", key: "name" }, { label: "Status", render: function (r) { return badge(r.status); } },
              { label: "Publicada em", render: function (r) { return fmtDt(r.published_at); } }, { label: "Criada em", render: function (r) { return fmtDt(r.created_at); } }], versions,
              function (r) { location.hash = "#/rubrics/" + encodeURIComponent(rid) + "/" + r.version; })));
        });
      }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
    }
    function newRubric() {
      var id = h("input", { placeholder: "ex.: qualidade_comercial", maxlength: "64" }), name = h("input", { placeholder: "Nome", maxlength: "120" });
      confirmModal("Nova rubrica", h("div", null, h("label", null, "Identificador (letras, números, _ . : -)", id), h("br"), h("label", null, "Nome", name)), "Criar rascunho").then(function (yes) {
        if (!yes) return;
        api("rubrics.createDraft", { rubric_id: id.value.trim(), name: name.value.trim() }).then(function (r) { location.hash = "#/rubrics/" + encodeURIComponent(id.value.trim()) + "/" + r.version; }).catch(showError);
      });
    }
    function reviseRubric(rid, ver, name) {
      confirmModal("Nova revisão", h("p", null, "Será criado um rascunho copiando a v" + ver + " (critérios e política). A versão publicada não muda."), "Criar rascunho").then(function (yes) {
        if (!yes) return;
        api("rubrics.createDraft", { rubric_id: rid, name: name || rid, cloneFromVersion: ver }).then(function (r) { location.hash = "#/rubrics/" + encodeURIComponent(rid) + "/" + r.version; }).catch(showError);
      });
    }
    load();
  };

  function rubricEditor(root, rid, ver) {
    var box = h("div", null, loading());
    root.appendChild(pageHead("Rubrica " + rid + " v" + ver, null, h("a", { class: "btn", href: "#/rubrics" }, "Voltar")));
    root.appendChild(box);
    var model = null, etag = null, dirty = false, status = null;
    function render(issues) {
      clear(box);
      var editable = status === "DRAFT" && RANK[state.role] >= RANK.EDITOR;
      var ro = !editable;
      if (status !== "DRAFT") box.appendChild(h("div", { class: "alert info" }, "Esta versão está publicada e é imutável. Para alterar, crie uma nova revisão na lista de rubricas."));
      if (issues && issues.length) box.appendChild(h("div", { class: "alert warn" }, h("strong", null, "Pendências antes de publicar:"), h("ul", null, issues.map(function (i) { return h("li", null, i.path + ": " + i.message); }))));
      var tabs = h("div", { class: "tabs", role: "tablist" });
      var panels = {};
      ["Critérios", "Política"].forEach(function (name, idx) {
        var b = h("button", { role: "tab", "aria-selected": idx === 0 ? "true" : "false", onclick: function () {
          Array.prototype.forEach.call(tabs.children, function (x) { x.setAttribute("aria-selected", "false"); }); b.setAttribute("aria-selected", "true");
          Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
        } }, name);
        tabs.appendChild(b);
      });
      box.appendChild(h("div", { class: "card" }, h("div", { class: "row" },
        h("label", { class: "grow", style: "flex:1" }, "Nome", h("input", { value: model.name, disabled: ro, maxlength: "120", oninput: function (e) { model.name = e.target.value; dirty = true; } })),
        h("label", { style: "flex:2" }, "Descrição", h("input", { value: model.description, disabled: ro, maxlength: "1000", oninput: function (e) { model.description = e.target.value; dirty = true; } })))));
      box.appendChild(tabs);
      panels["Critérios"] = h("div", null, model.criteria.map(function (c, i) { return critCard(c, i, ro); }),
        ro ? null : h("button", { class: "btn", onclick: function () { model.criteria.push(blankCriterion(model.criteria.length + 1)); dirty = true; render(issues); } }, "Adicionar critério"));
      panels["Política"] = policyPanel(model.policy, ro); panels["Política"].hidden = true;
      box.appendChild(panels["Critérios"]); box.appendChild(panels["Política"]);
      var total = model.criteria.filter(function (c) { return c.enabled; }).reduce(function (a, c) { return a + Number(c.weight || 0); }, 0);
      box.appendChild(h("p", { class: "muted" }, "Soma dos pesos habilitados: " + fmtNum(total) + " (os pesos são normalizados na nota)."));
      if (editable) {
        box.appendChild(h("div", { class: "row" },
          h("button", { class: "btn primary", onclick: save }, "Salvar rascunho"),
          RANK[state.role] >= RANK.ADMIN ? h("button", { class: "btn", onclick: publish }, "Publicar…") : h("span", { class: "muted" }, "Somente administradores publicam."),
          h("div", { class: "spacer" }), h("button", { class: "btn danger", onclick: discard }, "Descartar rascunho")));
      }
    }
    function blankCriterion(n) {
      return { criterion_id: "", criterion_name: "", evaluation_instructions: "", evaluation_type: "PREDICATE", weight: 10, required: false, enabled: true,
        score_mapping: { "true": 100, "false": 0 }, level_descriptions: {}, applicability_rule: null, display_order: n };
    }
    function critCard(c, i, ro) {
      function set(k, v) { c[k] = v; dirty = true; }
      var opts = h("div", { class: "opts" });
      function drawOpts() {
        clear(opts);
        var keys = Object.keys(c.score_mapping);
        keys.forEach(function (k) {
          var fixed = c.evaluation_type === "PREDICATE";
          opts.appendChild(h("div", { class: "opt" },
            h("input", { value: k, disabled: ro || fixed, "aria-label": "Opção de resposta", maxlength: "64", onchange: function (e) {
              var nk = e.target.value.trim(); if (!nk || nk === k || c.score_mapping[nk] !== undefined) { e.target.value = k; return; }
              var m = {}; Object.keys(c.score_mapping).forEach(function (x) { m[x === k ? nk : x] = c.score_mapping[x]; }); c.score_mapping = m;
              if (c.level_descriptions[k] !== undefined) { c.level_descriptions[nk] = c.level_descriptions[k]; delete c.level_descriptions[k]; } dirty = true; drawOpts();
            } }),
            h("input", { type: "number", min: "0", max: "100", step: "1", value: c.score_mapping[k], disabled: ro, "aria-label": "Nota 0 a 100", onchange: function (e) { c.score_mapping[k] = Number(e.target.value); dirty = true; } }),
            h("input", { value: c.level_descriptions[k] || "", disabled: ro, placeholder: "O que significa esta opção (enviado ao modelo)", maxlength: "500", "aria-label": "Descrição da opção",
              oninput: function (e) { if (e.target.value.trim()) c.level_descriptions[k] = e.target.value; else delete c.level_descriptions[k]; dirty = true; } }),
            ro || fixed ? h("span") : h("button", { class: "btn small", title: "Remover opção", onclick: function () { delete c.score_mapping[k]; delete c.level_descriptions[k]; dirty = true; drawOpts(); } }, "×")));
        });
        if (!ro && c.evaluation_type !== "PREDICATE") opts.appendChild(h("button", { class: "btn small", onclick: function () {
          var n = 1; while (c.score_mapping["opcao_" + n] !== undefined) n++; c.score_mapping["opcao_" + n] = 0; dirty = true; drawOpts(); } }, "Adicionar opção"));
      }
      drawOpts();
      var ruleBox = h("div", { class: "rule" });
      function drawRule() {
        clear(ruleBox);
        var rule = c.applicability_rule;
        var candidates = model.criteria.filter(function (x) { return x !== c && x.criterion_id && !x.applicability_rule; });
        var sel = h("select", { disabled: ro, "aria-label": "Aplicabilidade do critério", onchange: function (e) {
          c.applicability_rule = e.target.value ? { criterion_id: e.target.value, equals: [] } : null; dirty = true; drawRule();
        } }, h("option", { value: "" }, "Sempre se aplica"),
          candidates.map(function (x) { return h("option", { value: x.criterion_id, selected: !!rule && rule.criterion_id === x.criterion_id }, "Somente se “" + x.criterion_id + "” for…"); }));
        ruleBox.appendChild(h("label", null, "Aplicabilidade", sel));
        if (!rule) return;
        var gate = model.criteria.filter(function (x) { return x.criterion_id === rule.criterion_id; })[0];
        var keys = gate ? Object.keys(gate.score_mapping) : [];
        ruleBox.appendChild(h("div", { class: "row", style: "margin:6px 0 0" }, keys.length ? keys.map(function (k) {
          return h("label", { class: "check" }, h("input", { type: "checkbox", disabled: ro, checked: rule.equals.indexOf(k) >= 0, onchange: function (e) {
            rule.equals = rule.equals.filter(function (x) { return x !== k; }); if (e.target.checked) rule.equals.push(k); dirty = true;
          } }), k);
        }) : h("span", { class: "muted" }, "O critério de controle não existe mais.")));
        ruleBox.appendChild(h("div", { class: "muted" }, "Fora disso o critério fica “não aplicável” (não entra na nota, nem como zero). Sem resposta do critério de controle, vai para revisão. O critério de controle costuma ter peso 0."));
      }
      drawRule();
      return h("div", { class: "crit" }, h("div", { class: "top2" },
        h("label", { class: "grow" }, "Identificador", h("input", { value: c.criterion_id, disabled: ro, maxlength: "64", placeholder: "ex.: saudacao", oninput: function (e) { set("criterion_id", e.target.value.trim()); } })),
        h("label", { class: "grow" }, "Nome", h("input", { value: c.criterion_name, disabled: ro, maxlength: "120", oninput: function (e) { set("criterion_name", e.target.value); } })),
        h("label", null, "Tipo", h("select", { disabled: ro, onchange: function (e) {
          set("evaluation_type", e.target.value);
          if (e.target.value === "PREDICATE") { c.score_mapping = { "true": 100, "false": 0 }; c.level_descriptions = {}; }
          else if (Object.keys(c.score_mapping).length < 2 || c.score_mapping["true"] !== undefined) { c.score_mapping = { baixo: 0, alto: 100 }; c.level_descriptions = {}; }
          drawOpts();
        } }, [["PREDICATE", "Sim/Não"], ["SCORE", "Escala"], ["CHOICE", "Escolha"]].map(function (o) { return h("option", { value: o[0], selected: c.evaluation_type === o[0] }, o[1]); }))),
        h("label", null, "Peso", h("input", { type: "number", min: "0", step: "any", value: c.weight, disabled: ro, style: "width:90px", onchange: function (e) { set("weight", Number(e.target.value)); } })),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: c.required, disabled: ro, onchange: function (e) { set("required", e.target.checked); } }), "Obrigatório"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: c.enabled, disabled: ro, onchange: function (e) { set("enabled", e.target.checked); } }), "Habilitado"),
        ro ? null : h("button", { class: "btn small danger", onclick: function () { model.criteria.splice(i, 1); dirty = true; render(null); } }, "Remover")),
        h("label", { style: "margin-top:8px" }, "Pergunta de avaliação (enviada ao modelo)", h("textarea", { disabled: ro, maxlength: "4000", oninput: function (e) { set("evaluation_instructions", e.target.value); } }, c.evaluation_instructions)),
        ruleBox,
        c.evaluation_type === "PREDICATE" ? null : h("div", { class: "muted", style: "margin-top:8px" }, "Opções e notas (0–100). Descreva cada nível: sem definição, o modelo tende a escolher o meio."), opts);
    }
    function policyPanel(p, ro) {
      function num(label, key, hint, nullable) {
        return h("label", null, label, h("input", { type: "number", min: "0", step: "any", value: p[key] === null ? "" : p[key], disabled: ro, title: hint || "", onchange: function (e) {
          p[key] = e.target.value === "" ? (nullable ? null : 0) : Number(e.target.value); dirty = true; } }));
      }
      return h("div", { class: "card" }, h("div", { class: "row" },
        num("Nota mínima de aprovação (0–100)", "minimum_approval_score"),
        h("label", null, "Evidência ausente", h("select", { disabled: ro, onchange: function (e) { p.missing_evidence_policy = e.target.value; dirty = true; } },
          [["NEEDS_REVIEW", "Enviar para revisão"], ["EXCLUDE_OPTIONAL", "Excluir critérios opcionais"]].map(function (o) { return h("option", { value: o[0], selected: p.missing_evidence_policy === o[0] }, o[1]); })))),
        h("h3", null, "Evidência mínima (antes de chamar o modelo)"),
        h("div", { class: "row" }, num("Mensagens mínimas", "min_messages", "0 desliga a regra"), num("Mensagens mínimas do cliente", "min_customer_messages", "0 = desligado"), num("Mensagens mínimas do vendedor", "min_seller_messages", "0 = desligado")),
        h("h3", null, "Limites"),
        h("div", { class: "row" }, num("Máx. análises por sessão", "max_analyses_per_session", "vazio = sem limite", true), num("Máx. tokens de entrada", "max_input_tokens", "vazio = sem limite; máx. 272000", true), num("Orçamento mensal (US$)", "monthly_budget_usd", "vazio = sem limite", true)));
    }
    function load() {
      api("rubrics.get", { rubric_id: rid, version: ver }).then(function (d) {
        model = d.draft; etag = d.etag; status = d.header.status; dirty = false;
        model.criteria.forEach(function (c) { c.level_descriptions = c.level_descriptions || {}; c.applicability_rule = c.applicability_rule || null; });
        render(d.issues);
      }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
    }
    function save() {
      return api("rubrics.saveDraft", { rubric_id: rid, version: ver, etag: etag, draft: model }).then(function (r) {
        etag = r.etag; dirty = false; toast(r.issues.length ? "Salvo com " + r.issues.length + " pendência(s)." : "Rascunho salvo."); render(r.issues); return r;
      }).catch(function (e) { showError(e); if (e.code === "CONFLICT") load(); });
    }
    function publish() {
      save().then(function (r) {
        if (!r) return;
        if (r.issues.length) { toast("Resolva as pendências antes de publicar.", true); return; }
        confirmModal("Publicar " + rid + " v" + ver, h("div", null, h("p", null, "Depois de publicada, esta versão será imutável e passará a ser a versão mais recente usada pelo processamento."),
          h("p", { class: "muted" }, model.criteria.filter(function (c) { return c.enabled; }).length + " critério(s) habilitado(s) · nota mínima " + model.policy.minimum_approval_score)), "Publicar", false).then(function (yes) {
          if (!yes) return;
          api("rubrics.publish", { rubric_id: rid, version: ver, etag: etag }).then(function () { toast("Rubrica publicada."); load(); }).catch(function (e) { showError(e); load(); });
        });
      });
    }
    function discard() {
      confirmModal("Descartar rascunho", h("p", null, "O rascunho e seus critérios serão apagados. Isso não afeta versões publicadas."), "Descartar", true).then(function (yes) {
        if (!yes) return;
        api("rubrics.deleteDraft", { rubric_id: rid, version: ver }).then(function () { dirty = false; toast("Rascunho descartado."); location.hash = "#/rubrics"; }).catch(showError);
      });
    }
    window.__sciDirty = function () { return dirty; };
    load();
  }

  VIEWS.users = function (root) {
    var box = h("div", { class: "card" }, loading());
    var email = h("input", { type: "email", placeholder: "pessoa@empresa.com", maxlength: "254", required: true });
    var role = h("select", null, ["VIEWER", "EDITOR", "ADMIN"].map(function (r) { return h("option", { value: r }, ROLE_LABEL[r]); }));
    root.appendChild(pageHead("Usuários e acesso", "Quem pode acessar este workspace e com qual papel"));
    root.appendChild(h("div", { class: "card" }, h("form", { class: "row", onsubmit: function (e) {
      e.preventDefault();
      api("users.upsert", { email: email.value, role: role.value, status: "ACTIVE" }).then(function () { toast("Acesso concedido."); email.value = ""; load(); }).catch(showError);
    } }, h("label", null, "E-mail corporativo", email), h("label", null, "Papel", role), h("button", { class: "btn primary", type: "submit" }, "Conceder acesso"))));
    root.appendChild(box);
    function load() {
      api("users.list").then(function (rows) {
        clear(box);
        box.appendChild(table([{ label: "E-mail", key: "email" }, { label: "Papel", render: function (r) { return ROLE_LABEL[r.role] || r.role; } }, { label: "Status", render: function (r) { return badge(r.status); } },
          { label: "Alterado em", render: function (r) { return fmtDt(r.changed_at); } }, { label: "Por", key: "changed_by" },
          { label: "", render: function (r) {
            var sel = h("select", { "aria-label": "Papel de " + r.email, onchange: function () { change(r, sel.value, r.status); } }, ["VIEWER", "EDITOR", "ADMIN"].map(function (x) { return h("option", { value: x, selected: x === r.role }, ROLE_LABEL[x]); }));
            return h("div", { class: "row", style: "margin:0" }, sel, h("button", { class: "btn small" + (r.status === "ACTIVE" ? " danger" : ""), onclick: function () { change(r, r.role, r.status === "ACTIVE" ? "DISABLED" : "ACTIVE"); } }, r.status === "ACTIVE" ? "Desativar" : "Reativar"));
          } }], rows));
      }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
    }
    function change(r, nrole, nstatus) { api("users.upsert", { email: r.email, role: nrole, status: nstatus }).then(function () { toast("Acesso atualizado."); load(); }).catch(function (e) { showError(e); load(); }); }
    load();
  };

  VIEWS.audit = function (root) {
    var box = h("div", { class: "card" }, loading());
    root.appendChild(pageHead("Auditoria", "Alterações de configuração e acessos a conteúdo de conversas (somente metadados)"));
    root.appendChild(box);
    api("audit.list", { days: 30, limit: 500 }).then(function (rows) {
      clear(box);
      box.appendChild(rows.length ? table([{ label: "Quando", render: function (r) { return fmtDt(r.occurred_at); } }, { label: "Quem", key: "actor_email" }, { label: "Ação", render: function (r) { return h("span", { class: "mono" }, r.action); } },
        { label: "Alvo", render: function (r) { return r.entity_id ? (r.entity_type || "") + " " + r.entity_id : "—"; } }, { label: "Resultado", render: function (r) { return badge(r.outcome); } },
        { label: "Detalhes", render: function (r) { return h("span", { class: "mono muted" }, r.details && r.details !== "{}" ? r.details : ""); } }], rows) : emptyState("Sem eventos no período."));
    }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
  };

  // ---------- shell & router ----------
  var NAV = [["dashboard", "Painel", "VIEWER"], ["sessions", "Sessões", "VIEWER"], ["review", "Revisão", "VIEWER"], ["runs", "Execuções", "VIEWER"], ["rubrics", "Rubricas", "VIEWER"], ["users", "Usuários", "ADMIN"], ["audit", "Auditoria", "ADMIN"]];
  function route() {
    var parts = (location.hash.replace(/^#\/?/, "") || "dashboard").split("/");
    var name = parts.shift();
    var item = NAV.filter(function (n) { return n[0] === name; })[0];
    if (!item || RANK[state.role] < RANK[item[2]]) { location.hash = "#/dashboard"; return; }
    Array.prototype.forEach.call(document.querySelectorAll(".side a"), function (a) { a.removeAttribute("aria-current"); if (a.getAttribute("data-route") === name) a.setAttribute("aria-current", "page"); });
    var main = $("#main"); clear(main); window.__sciDirty = null;
    VIEWS[name](main, parts);
    main.focus();
  }
  function shell() {
    var app = $("#app"); clear(app);
    var tenants = state.me.memberships;
    var sel = h("select", { "aria-label": "Workspace", onchange: function () { pick(Number(sel.value)); } },
      tenants.map(function (m, i) { return h("option", { value: i, selected: m.organization_id === state.tenant.organization_id && m.workspace_id === state.tenant.workspace_id }, m.organization_id + " / " + m.workspace_id); }));
    app.appendChild(h("div", { class: "shell" },
      h("header", { class: "top" }, h("div", { class: "brand" }, "SCI Console", h("small", null, "v" + document.body.getAttribute("data-version"))), sel, h("div", { class: "spacer" }),
        h("span", { class: "who" }, state.me.email), h("span", { class: "badge info" }, ROLE_LABEL[state.role])),
      h("nav", { class: "side", "aria-label": "Principal" }, NAV.filter(function (n) { return RANK[state.role] >= RANK[n[2]]; }).map(function (n) { return h("a", { href: "#/" + n[0], "data-route": n[0] }, n[1]); })),
      h("main", { id: "main", tabindex: "-1" })));
    route();
  }
  function pick(i) {
    var m = state.me.memberships[i];
    state.tenant = { organization_id: m.organization_id, workspace_id: m.workspace_id }; state.role = m.role;
    try { sessionStorage.setItem("sci.tenant", String(i)); } catch (e) { /* storage may be blocked in the sandbox */ }
    shell();
  }
  window.addEventListener("hashchange", function () { if (state.me) route(); });
  window.addEventListener("beforeunload", function (e) { if (window.__sciDirty && window.__sciDirty()) { e.preventDefault(); e.returnValue = ""; } });

  call("me").then(function (me) {
    state.me = me;
    if (!me.memberships.length) {
      clear($("#app")); $("#app").appendChild(h("main", { style: "max-width:34rem;margin:15vh auto;padding:0 16px" }, h("h1", null, "Sem acesso"),
        h("p", null, "Sua conta (" + me.email + ") está autenticada, mas não tem acesso a nenhum workspace. Peça a um administrador para concedê-lo.")));
      return;
    }
    var saved = 0; try { saved = Number(sessionStorage.getItem("sci.tenant") || 0); } catch (e) { saved = 0; }
    pick(saved >= 0 && saved < me.memberships.length ? saved : 0);
  }).catch(function (e) {
    clear($("#app")); $("#app").appendChild(h("main", { style: "max-width:34rem;margin:15vh auto;padding:0 16px" }, h("h1", null, "Não foi possível entrar"), h("p", null, e.message || "Erro inesperado."),
      e.requestId ? h("p", { class: "muted mono" }, e.requestId) : null));
  });
})();

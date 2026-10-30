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

  // Icons are drawn with stroked paths in a 24px grid (Material-like). Built with createElementNS: no markup strings anywhere.
  var SVGNS = "http://www.w3.org/2000/svg";
  var CIRCLE = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z";
  var ICONS = {
    menu: ["M4 6h16", "M4 12h16", "M4 18h16"], search: ["M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z", "M15.5 15.5L20 20"],
    dashboard: ["M4 4h7v8H4z", "M13 4h7v4h-7z", "M13 10h7v10h-7z", "M4 14h7v6H4z"], sessions: ["M4 5h16v11H10l-5 4v-4H4z"],
    review: ["M5 3v18", "M5 4h12l-2.5 4L17 12H5"], runs: [CIRCLE, "M12 7v5l3.5 2"], rubrics: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h2", "M4 12h2", "M4 18h2"],
    users: ["M9 4.5a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4z", "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6", "M16.5 5.5a2.6 2.6 0 1 1 0 5.2", "M17 14.4c2.4.4 4 2.4 4 5.6"],
    audit: ["M12 3l8 3v6c0 4.5-3.2 8-8 9c-4.8-1-8-4.5-8-9V6z", "M8.5 12l2.5 2.5l4.5-5"],
    ok: [CIRCLE, "M8 12.5l2.7 2.7L16 9.5"], bad: [CIRCLE, "M12 7.5v5.5", "M12 16.5v.01"], warn: ["M12 4l9 16H3z", "M12 10v4", "M12 17.2v.01"],
    info: [CIRCLE, "M12 11v5", "M12 8v.01"], clock: [CIRCLE, "M12 7v5l3 2"], block: [CIRCLE, "M6 6l12 12"],
    theme: ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M12 2v2", "M12 20v2", "M2 12h2", "M20 12h2", "M5 5l1.4 1.4", "M17.6 17.6L19 19", "M5 19l1.4-1.4", "M17.6 6.4L19 5"],
    external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5H5V6h5"],
    close: ["M6 6l12 12", "M18 6L6 18"], add: ["M12 5v14", "M5 12h14"], back: ["M19 12H5", "M11 6l-6 6l6 6"], chevron: ["M9 6l6 6l-6 6"],
    trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"], publish: ["M12 16V4", "M7 9l5-5l5 5", "M4 20h16"], save: ["M5 4h11l3 3v13H5z", "M8 4v5h7V4", "M8 20v-6h8v6"],
    person: ["M12 4.5a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8z", "M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"], headset: ["M4 14v-2a8 8 0 0 1 16 0v2", "M4 13h3v6H4z", "M17 13h3v6h-3z", "M19 19c0 1.6-1.5 2-4 2h-2"],
    bot: ["M5 8h14v10H5z", "M12 4v4", "M9 13v.01", "M15 13v.01", "M9 18v2", "M15 18v2"],
    prev: ["M15 6l-6 6l6 6"], first: ["M17 6l-6 6l6 6", "M7 6v12"], refresh: ["M20 12a8 8 0 1 1-2.6-5.9", "M20 4v5h-5"],
    logout: ["M10 4H5v16h5", "M16 8l4 4l-4 4", "M20 12H9"],
    play: ["M8 5v14l11-7z"], pause: ["M8 5v14", "M16 5v14"], how: ["M12 3a6 6 0 0 0-3 11.2V17h6v-2.8A6 6 0 0 0 12 3z", "M9.5 20h5", "M10.5 22h3"],
    inbox: ["M4 13l2-8h12l2 8", "M4 13v6h16v-6", "M4 13h5l1 2h4l1-2h5"]
  };
  function icon(name, cls) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "i" + (cls ? " " + cls : "")); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    (ICONS[name] || []).forEach(function (d) { var p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); svg.appendChild(p); });
    return svg;
  }
  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
    return el;
  }

  // Theme: automatic (system) by default; the toggle pins light or dark. The choice is a per-browser convenience, so storage failures are ignored.
  function applyTheme(t) { if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
  function toggleTheme() {
    var dark = document.documentElement.getAttribute("data-theme") === "dark" || (!document.documentElement.getAttribute("data-theme") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var next = dark ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("sci.theme", next); } catch (e) { /* storage may be blocked in the sandbox */ }
  }
  try { applyTheme(localStorage.getItem("sci.theme")); } catch (e) { /* storage may be blocked in the sandbox */ }
  function themeMode() { var t = document.documentElement.getAttribute("data-theme"); return t === "light" || t === "dark" ? t : "auto"; }
  function setThemeMode(mode) {
    applyTheme(mode);
    try { if (mode === "light" || mode === "dark") localStorage.setItem("sci.theme", mode); else localStorage.removeItem("sci.theme"); } catch (e) { /* per-browser convenience */ }
  }

  var pt = { dt: new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }), d: new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "UTC" }) };
  pt.t = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }); pt.day = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" });
  function fmtTime(s) { var d = s ? new Date(s) : null; return d && !isNaN(d) ? pt.t.format(d) : ""; }
  function dayKey(s) { var d = s ? new Date(s) : null; return d && !isNaN(d) ? d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate() : ""; }
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
    INSUFFICIENT_EVIDENCE: ["Evidência insuficiente", "warn"],
    PENDING: ["Pendente", "warn"], N_A: ["Não se aplica", ""],
    PENDING_REVIEW: ["Aguardando revisão", "warn"], CONFIRMED: ["Resultado confirmado", "ok"], DISAGREED: ["Revisor discordou", "bad"], REANALYSIS: ["Reanálise solicitada", "info"]
  };
  var CHIP_ICON = { ok: "ok", warn: "warn", bad: "bad", info: "clock" };
  function badge(s) {
    if (!s) return h("span", { class: "muted" }, "—");
    var m = STATUS[s] || [s, ""];
    return h("span", { class: "badge " + m[1] }, CHIP_ICON[m[1]] ? icon(CHIP_ICON[m[1]], "sm") : null, m[0]);
  }
  // The rubric an analysis used, as a badge that opens that exact published version (read-only for anyone who can see rubrics).
  // Why the engine approved/rejected/held an analysis (codes persisted in approval_reason; the server already sanitised them).
  function reasonItems(a) {
    var rs = a && (typeof a.approval_reason === "string" ? parseJson(a.approval_reason) : a.approval_reason);
    if (!rs || !rs.reasons || !rs.reasons.length) return [];
    var min = fmtNum(rs.minimum, 0);
    var id = function (r) { return h("strong", { class: "mono" }, r.criterion_id || "?"); };
    return rs.reasons.map(function (r) {
      switch (r.code) {
        case "REQUIRED_CRITERION_BELOW_MINIMUM": return h("li", null, "Critério obrigatório ", id(r), " obteve ", h("strong", null, fmtNum(r.score, 0)), ", abaixo do mínimo de ", min, ". Um obrigatório abaixo do mínimo reprova mesmo com a nota geral acima dele.");
        case "OVERALL_BELOW_MINIMUM": return h("li", null, "Nota geral ", h("strong", null, fmtNum(rs.overall)), " abaixo do mínimo de ", min, ".");
        case "MEETS_MINIMUM": return h("li", null, "Nota geral ", h("strong", null, fmtNum(rs.overall)), " atinge o mínimo de ", min, " e nenhum critério obrigatório ficou abaixo dele.");
        case "INSUFFICIENT_EVIDENCE": return h("li", null, "Sem evidência suficiente no critério ", id(r), r.required ? " (obrigatório)" : "", ".");
        case "NO_APPLICABLE_CRITERIA": return h("li", null, "Nenhum critério da rubrica se aplica a esta conversa.");
        default: return null;
      }
    }).filter(Boolean);
  }
  function reasonBlock(a) {
    var items = reasonItems(a);
    return items.length ? h("div", { class: "reason" }, h("div", { class: "acct-t" }, "Motivo do resultado"), h("ul", null, items)) : null;
  }
  // The main card of a session: what it is, which rubric(s) evaluated it, and how each analysis ended (status and result).
  var MODE = { historical: "Histórico", live: "Ao vivo" };
  function kv(label, value) { return h("div", { class: "kv" }, h("div", { class: "k" }, label), h("div", { class: "v" }, value)); }
  function summaryCard(d) {
    var s = d.session;
    var card = h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", null, "Resumo"),
        h("span", { class: "sid", title: "Código da sessão" }, h("span", { class: "k" }, "Sessão"), h("span", { class: "mono" }, s.session_id))),
      h("div", { class: "summary-grid" }, kv("Canal", s.channel || "—"), kv("Início", fmtDt(s.started_at)), kv("Status da sessão", s.status || "—")));
    if (!d.analyses.length) { card.appendChild(h("p", { class: "muted" }, "Sessão ainda não analisada.")); return card; }
    d.analyses.forEach(function (a) {
      card.appendChild(h("div", { class: "analysis-sum", role: "group", "aria-label": "Análise com a rubrica " + a.rubric_id + " versão " + a.rubric_version },
        h("div", { class: "summary-grid" },
          kv("Rubrica utilizada", rubricBadge(a.rubric_id, a.rubric_version)),
          kv("Status da análise", badge(a.analysis_status)),
          kv("Resultado", a.approval_status ? badge(a.approval_status) : "—"),
          kv("Nota", h("strong", null, fmtNum(a.overall_score))),
          kv("Concluída em", fmtDt(a.completed_at))),
        h("div", { class: "summary-grid tight" },
          kv("Modelo", h("span", { class: "mono" }, a.model || "—")),
          kv("Prompt", h("span", { class: "mono" }, a.prompt_version || "—")),
          kv("Modo", MODE[a.analysis_mode] || a.analysis_mode || "—"),
          kv("Custo", fmtUsd(a.estimated_cost_usd))),
        reasonBlock(a)));
    });
    return card;
  }
  // Also used inside clickable table rows: the click and Enter must open the rubric, not the row behind it.
  function rubricBadge(rubricId, version) {
    var href = "#/rubrics/" + encodeURIComponent(rubricId) + "/" + encodeURIComponent(String(version));
    return h("a", { class: "badge link", href: href, onclick: function (e) { e.stopPropagation(); go(href)(e); }, onkeydown: function (e) { e.stopPropagation(); }, title: "Abrir o detalhe da rubrica " + rubricId + " v" + version, "aria-label": "Rubrica " + rubricId + " versão " + version + ": abrir detalhe" },
      icon("rubrics", "sm"), rubricId + " v" + version);
  }
  // Modern on/off switch. It stays a real checkbox input (role="switch"), so keyboard, focus, disabled state and form behaviour are the browser's own; only the look changes.
  function switchField(label, checked, disabled, onchange) {
    return h("label", { class: "check sw-field" }, h("input", { type: "checkbox", role: "switch", class: "sw", checked: checked, disabled: disabled, onchange: onchange }), h("span", null, label));
  }
  var ROLE_LABEL = { VIEWER: "Leitor", EDITOR: "Editor", ADMIN: "Administrador" };
  // What each profile can do. Descriptive only: the server enforces it (tests/account.test.ts keeps this list identical to the enforced roles).
  var CAPS = [["Ver painel, sessões, resultados e execuções", "VIEWER"], ["Ver o conteúdo das conversas (mascarado)", "VIEWER"], ["Registrar decisão de revisão", "EDITOR"], ["Criar e editar rascunhos de rubricas", "EDITOR"],
    ["Publicar rubricas", "ADMIN"], ["Gerenciar usuários e acessos", "ADMIN"], ["Consultar a auditoria", "ADMIN"]];
  var RANK = { VIEWER: 1, EDITOR: 2, ADMIN: 3 };

  // In-app navigation. HtmlService runs the page in a sandboxed iframe: a plain <a href="#/x"> must never navigate the top window (blank page),
  // so every internal link sets location.hash itself and cancels the default action.
  function go(hash) { return function (e) { if (e) e.preventDefault(); location.hash = hash; }; }

  // ---------- api ----------
  function ApiError(e, requestId) { this.code = e.code; this.message = e.message; this.details = e.details || []; this.requestId = requestId; }
  var pending = 0;
  function busy(delta) { pending = Math.max(0, pending + delta); var bar = $("#progress"); if (bar) bar.className = pending ? "on" : ""; }
  function call(method, payload) {
    busy(1);
    return new Promise(function (resolve, reject) {
      google.script.run
        .withSuccessHandler(function (text) {
          busy(-1);
          var res;
          try { res = JSON.parse(text); } catch (e) { return reject(new ApiError({ code: "INTERNAL", message: "Resposta inválida do servidor." })); }
          if (res.ok) resolve(res.data); else reject(new ApiError(res.error, res.requestId));
        })
        .withFailureHandler(function () { busy(-1); reject(new ApiError({ code: "UNAVAILABLE", message: "Não foi possível falar com o servidor." })); })
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
      function close(v) { bg.remove(); document.body.classList.remove("modal-open"); if (prev && prev.focus) prev.focus(); resolve(v); }
      var ok = h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: function () { close(true); } }, okLabel);
      var no = h("button", { class: "btn", onclick: function () { close(false); } }, "Cancelar");
      var bg = h("div", { class: "modal-bg", onkeydown: function (e) { if (e.key === "Escape") close(false); } },
        h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", null, title), body, h("div", { class: "actions" }, no, ok)));
      document.body.appendChild(bg);
      document.body.classList.add("modal-open");
      no.focus();
    });
  }
  function emptyState(text, ic) { return h("div", { class: "empty" }, icon(ic || "inbox", "xl"), h("div", null, text)); }
  function table(cols, rows, onRow, rowRef) {
    var head = h("tr", null, cols.map(function (c) { return h("th", { class: c.num ? "num" : "" }, c.label); }));
    var body = rows.map(function (r) {
      var tr = h("tr", onRow ? { tabindex: "0", style: "cursor:pointer", onclick: function () { onRow(r); }, onkeydown: function (e) { if (e.key === "Enter") onRow(r); } } : null,
        cols.map(function (c) { return h("td", { class: c.num ? "num" : "" }, c.render ? c.render(r) : r[c.key] === null || r[c.key] === undefined ? "—" : r[c.key]); }));
      if (rowRef) rowRef(r, tr);
      return tr;
    });
    return h("div", { class: "scroll" }, h("table", null, h("thead", null, head), h("tbody", null, body)));
  }
  function loading() { return h("p", { class: "muted" }, "Carregando…"); }
  // crumbs: [[label, "#/route"], ...] shown above the title, like the Cloud Console breadcrumb trail.
  function pageHead(title, sub, actions, crumbs) {
    var trail = crumbs && crumbs.length ? h("nav", { class: "crumbs", "aria-label": "Trilha" }, crumbs.map(function (c, i) {
      return [i ? icon("chevron", "sm") : null, c[1] ? h("a", { href: c[1], onclick: go(c[1]) }, c[0]) : h("span", null, c[0])];
    })) : null;
    return h("div", { class: "head" }, h("div", null, trail, h("h1", null, title), sub ? h("div", { class: "sub" }, sub) : null), h("div", { class: "spacer" }), actions);
  }
  function alertBox(kind, children) { return h("div", { class: "alert " + kind }, children); }

  // ---------- views ----------
  var VIEWS = {};

  // Line chart (Cloud Monitoring style): light grid, area under the line, a point per day with a tooltip. Pure SVG, no libraries.
  function lineChart(points) {
    var W = 960, H = 240, L = 40, R = 16, T = 12, B = 28, n = points.length;
    var x = function (i) { return L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)); };
    var y = function (v) { return T + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - T - B); };
    var svg = svgEl("svg", { "class": "chart", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Nota média por dia" });
    [0, 25, 50, 75, 100].forEach(function (g) {
      svg.appendChild(svgEl("line", { "class": "grid-line", x1: L, x2: W - R, y1: y(g), y2: y(g) }));
      var t = svgEl("text", { x: L - 8, y: y(g) + 4, "text-anchor": "end" }); t.textContent = String(g); svg.appendChild(t);
    });
    var line = points.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.value).toFixed(1); }).join(" ");
    svg.appendChild(svgEl("path", { "class": "area", d: line + " L" + x(n - 1).toFixed(1) + " " + y(0) + " L" + x(0).toFixed(1) + " " + y(0) + " Z" }));
    svg.appendChild(svgEl("path", { "class": "line", d: line }));
    var every = Math.max(1, Math.ceil(n / 8));
    points.forEach(function (p, i) {
      var tip = svgEl("title", {}); tip.textContent = p.label + ": " + fmtNum(p.value);
      svg.appendChild(svgEl("circle", { "class": "pt", cx: x(i), cy: y(p.value), r: n > 45 ? 2 : 3.5 }, tip));
      if ((i % every === 0 && n - 1 - i >= every) || i === n - 1) { var lb = svgEl("text", { x: x(i), y: H - 8, "text-anchor": "middle" }); lb.textContent = p.label.slice(0, 5); svg.appendChild(lb); }
    });
    return svg;
  }

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
          dayKeys.length ? [lineChart(dayKeys.map(function (k) { return { label: fmtDay(k), value: byDay[k].n ? byDay[k].s / byDay[k].n : 0 }; })),
            h("div", { class: "legend" }, h("span", null, "Nota média das sessões pontuadas (0 a 100)"))] : emptyState("Sem análises no período.", "dashboard")));
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
    function kpi(l, v) { return h("div", { class: "kpi" }, h("div", { class: "l" }, l), h("div", { class: "v" }, v)); }
    var sel = h("select", { "aria-label": "Período", onchange: function () { days = Number(sel.value); load(); } },
      [7, 30, 90, 180].map(function (n) { return h("option", { value: n, selected: n === days }, "Últimos " + n + " dias"); }));
    root.appendChild(pageHead("Painel", "Qualidade, custo e saúde do processamento · período pelo dia da análise", sel));
    root.appendChild(box); load();
  };

  // ---------- reusable pager ----------
  // Every list uses this one component: keyset paging on the server (a cursor, never an offset, so cost does not grow with the page number), page size, first/previous/next/
  // refresh, the range, a total on demand (counting scans the whole set; paging does not), protection against stale responses, and a state that survives opening an item and coming back.
  var PAGE_SIZES = [25, 50, 100];
  function tenantKey() { return state.tenant.organization_id + "/" + state.tenant.workspace_id; }
  function readPaging(key, sizes) {
    try {
      var o = JSON.parse(sessionStorage.getItem("sci.pg." + key) || "null");
      if (!o || o.t !== tenantKey() || sizes.indexOf(o.size) < 0 || !Array.isArray(o.cursors) || o.cursors[0] !== null || !(o.page >= 0) || o.cursors[o.page] === undefined) return null;
      return o;
    } catch (e) { return null; } // storage may be blocked in the sandbox
  }
  function writePaging(key, o) { try { sessionStorage.setItem("sci.pg." + key, JSON.stringify(o)); } catch (e) { /* per-browser convenience */ } }
  function fmtInt(n) { return Number(n).toLocaleString("pt-BR"); }
  var DAYS_OPTIONS = [[7, "Últimos 7 dias"], [30, "Últimos 30 dias"], [90, "Últimos 90 dias"], [180, "Últimos 180 dias"], [365, "Últimos 12 meses"]];
  function daysSelect(f, onchange) {
    return h("label", { class: "ffield" }, "Período", h("select", { onchange: function (e) { f.days = Number(e.target.value); onchange(); } },
      DAYS_OPTIONS.map(function (o) { return h("option", { value: String(o[0]), selected: o[0] === f.days }, o[1]); })));
  }

  // ---------- filter bar: the one look every list uses ----------
  // The bar only lays things out the same way everywhere (a labelled field is 36px, labels above, "Limpar filtros" at the end); what a filter does stays with the list.
  function fieldOf(label, control) { return h("label", { class: "ffield" }, label, control); }
  function groupField(label, control) { return h("div", { class: "ffield fit", role: "group", "aria-label": label }, h("span", null, label), control); }
  /* o: { fields: Node[], dirty() -> bool, onClear(), onSubmit?() }. With onSubmit the bar has a "Buscar" button and Enter submits (lists with text and date fields);
     without it every field applies as soon as it changes. Returns { el, update() }: call update() after a field changes so "Limpar filtros" enables itself. */
  function filterBar(o) {
    var clearBtn = h("button", { class: "btn text", type: "button", onclick: function () { o.onClear(); } }, "Limpar filtros");
    var el = h("form", { class: "filterbar", role: "search", "aria-label": "Filtros", onsubmit: function (e) { e.preventDefault(); if (o.onSubmit) o.onSubmit(); } },
      o.fields, h("span", { class: "spacer" }), o.onSubmit ? h("button", { class: "btn primary", type: "submit" }, "Buscar") : null, clearBtn);
    function update() { clearBtn.disabled = !o.dirty(); }
    update();
    return { el: el, update: update };
  }

  /* o: { key, sizes?, size?, noun?, bare?, unitsOf?(rows) -> number, scrollTo?, load(cursor, limit) -> Promise<{rows,nextCursor}>, count?() -> Promise<{total}>, draw(rows) -> Node, empty() -> Node, extra?() -> object }
     Returns { el, saved, start(), reload(), reset() }. `saved` is the `extra` stored by the last visit (the caller's filters). */
  function makePager(o) {
    var sizes = o.sizes || PAGE_SIZES, saved = readPaging(o.key, sizes);
    var size = saved ? saved.size : (o.size || sizes[Math.min(1, sizes.length - 1)]), page = saved ? saved.page : 0, cursors = saved ? saved.cursors : [null];
    var cache = {}, total = null, seq = 0, counting = false, restoredPage = saved ? saved.page : 0;
    var out = h("div", { class: "pg-out" });
    function persist() { writePaging(o.key, { t: tenantKey(), size: size, page: page, cursors: cursors, extra: o.extra ? o.extra() : {} }); }
    function toTop() { if (o.scrollTo && o.scrollTo.scrollIntoView) o.scrollTo.scrollIntoView({ block: "start" }); }
    function resetState() { page = 0; cursors = [null]; cache = {}; total = null; restoredPage = -1; }

    function bar(idx, res) {
      var units = o.unitsOf ? o.unitsOf(res.rows) : res.rows.length; // a page of rubrics holds several rows per rubric: the range counts rubrics
      var firstRow = idx * size + 1, lastRow = idx * size + units;
      function iconBtn(label, ic, disabled, fn) { return h("button", { class: "btn icon", type: "button", "aria-label": label, title: label, disabled: disabled, onclick: fn }, icon(ic)); }
      var sizeSel = h("select", { "aria-label": o.noun || "Linhas por página", onchange: function (e) { size = Number(e.target.value); resetState(); load(0, true); } },
        sizes.map(function (n) { return h("option", { value: String(n), selected: n === size }, String(n)); }));
      return h("div", { class: "pager" + (o.bare ? " bare" : ""), role: "navigation", "aria-label": "Paginação" },
        h("label", { class: "psize" }, h("span", null, o.noun || "Linhas por página"), sizeSel),
        h("span", { class: "spacer" }),
        h("span", { class: "pinfo", "aria-live": "polite" }, fmtInt(firstRow) + "–" + fmtInt(lastRow), total !== null ? " de " + fmtInt(total) : "", h("span", { class: "muted" }, " · página " + (idx + 1))),
        o.count && total === null ? h("button", { class: "btn text small", type: "button", disabled: counting, onclick: countAll }, counting ? "Contando…" : "Mostrar total") : null,
        iconBtn("Atualizar esta página", "refresh", false, function () { load(idx, true); }),
        iconBtn("Primeira página", "first", idx === 0, function () { load(0); }),
        iconBtn("Página anterior", "prev", idx === 0, function () { load(idx - 1); }),
        iconBtn("Próxima página", "chevron", !res.nextCursor, function () { load(idx + 1); }));
    }
    function draw(idx) {
      var res = cache[idx]; clear(out);
      if (!res.rows.length) { out.appendChild(o.empty()); return; }
      out.appendChild(o.draw(res.rows)); out.appendChild(bar(idx, res));
    }
    function load(idx, force) {
      if (!force && cache[idx]) { page = idx; persist(); draw(idx); toTop(); return; }
      var my = ++seq;
      out.classList.add("loading"); out.setAttribute("aria-busy", "true");
      if (!out.firstChild) out.appendChild(loading());
      o.load(cursors[idx] || null, size).then(function (res) {
        if (my !== seq) return; // a newer request replaced this one
        out.classList.remove("loading"); out.removeAttribute("aria-busy");
        if (!res.rows.length && idx > 0) { cursors.length = idx; cache = {}; load(idx - 1, true); return; } // the page disappeared (data changed): step back
        cache[idx] = res; cursors.length = idx + 1; if (res.nextCursor) cursors[idx + 1] = res.nextCursor;
        page = idx; persist(); draw(idx); if (idx !== restoredPage || force) toTop(); restoredPage = -1;
      }).catch(function (e) { if (my !== seq) return; out.classList.remove("loading"); out.removeAttribute("aria-busy"); clear(out); out.appendChild(h("div", { class: "alert bad" }, e.message)); });
    }
    function countAll() {
      counting = true; draw(page);
      o.count().then(function (r) { counting = false; total = r.total; if (cache[page]) draw(page); }).catch(function (e) { counting = false; if (cache[page]) draw(page); showError(e); });
    }
    return {
      el: out, saved: saved ? saved.extra : null,
      start: function () { load(page, true); },
      reload: function () { load(page, true); },
      reset: function () { resetState(); persist(); load(0, true); },
      forget: function () { resetState(); persist(); } // back to page 1 without loading (the caller re-renders the view)
    };
  }

  // ---------- sessions list: filters + pager ----------
  var RESULT_OPTIONS = [["", "Todos"], ["APPROVED", "Aprovada"], ["REJECTED", "Reprovada"], ["PENDING", "Pendente de revisão"], ["N_A", "Não se aplica"]];
  var STATUS_OPTIONS = [["", "Todos"], ["COMPLETED", "Concluída"], ["NEEDS_REVIEW", "Revisão necessária"], ["NOT_EVALUABLE", "Não avaliável"], ["FAILED", "Falha"], ["UNANALYSED", "Não analisada"]];

  VIEWS.sessions = function (root, parts) {
    if (parts[0]) return sessionDetail(root, parts[0]);
    var today = new Date(), from = new Date(today.getTime() - 179 * 864e5); // 180 days: the dashboard counts by analysis day, and sessions of the same analyses started earlier
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    var DEFAULTS = { from: iso(from), to: iso(today), status: "", result: "", channel: "", rubric: "", query: "" };
    var f = Object.assign({}, DEFAULTS), card;
    function query(extra) { return Object.assign({ from: f.from, to: f.to, status: f.status, result: f.result, channel: f.channel, rubric: f.rubric, query: f.query }, extra); }
    function isFiltered() { return Object.keys(DEFAULTS).some(function (k) { return f[k] !== DEFAULTS[k]; }); }
    var pg = makePager({
      key: "sessions", extra: function () { return f; },
      load: function (cursor, limit) { return api("sessions.list", query({ limit: limit, cursor: cursor })); },
      count: function () { return api("sessions.count", query({})); },
      empty: function () { return emptyState(isFiltered() ? "Nenhuma sessão com estes filtros." : "Nenhuma sessão encontrada neste período."); },
      draw: function (rows) {
        return table([
          { label: "Sessão", render: function (r) { return h("span", { class: "mono" }, r.session_id); } }, { label: "Início", render: function (r) { return fmtDt(r.started_at); } },
          { label: "Canal", key: "channel" }, { label: "Status", render: function (r) { return r.analysis_status ? badge(r.analysis_status) : h("span", { class: "muted" }, "Não analisada"); } },
          { label: "Nota", num: 1, render: function (r) { return fmtNum(r.overall_score); } }, { label: "Resultado", render: function (r) { return badge(r.approval_status); } },
          { label: "Rubrica", render: function (r) { return r.rubric_id ? rubricBadge(r.rubric_id, r.rubric_version) : "—"; } }], rows,
          function (r) { location.hash = "#/sessions/" + encodeURIComponent(r.session_id); });
      }
    });
    if (pg.saved) Object.assign(f, DEFAULTS, pg.saved);

    var bar;
    function touch() { if (bar) bar.update(); }
    function selectEl(options, key) {
      return h("select", { onchange: function (e) { f[key] = e.target.value; touch(); } }, options.map(function (o) { return h("option", { value: o[0], selected: o[0] === f[key] }, o[1]); }));
    }
    var channelSel = selectEl([["", "Todos"]].concat(f.channel ? [[f.channel, f.channel]] : []), "channel");
    var rubricSel = selectEl([["", "Todas"]].concat(f.rubric ? [[f.rubric, f.rubric]] : []), "rubric");
    function fillOptions(sel, key, first, values) {
      var keep = f[key]; clear(sel);
      var list = values.slice(); if (keep && list.indexOf(keep) < 0) list.push(keep);
      [["", first]].concat(list.map(function (x) { return [x, x]; })).forEach(function (o) { sel.appendChild(h("option", { value: o[0], selected: o[0] === keep }, o[1])); });
    }
    function loadChannels() { api("sessions.channels", { from: f.from, to: f.to }).then(function (list) { fillOptions(channelSel, "channel", "Todos", list); }).catch(function () { /* the filter keeps working with what it has */ }); }
    bar = filterBar({
      fields: [
        fieldOf("De", h("input", { type: "date", value: f.from, onchange: function (e) { f.from = e.target.value; touch(); } })),
        fieldOf("Até", h("input", { type: "date", value: f.to, onchange: function (e) { f.to = e.target.value; touch(); } })),
        fieldOf("Status", selectEl(STATUS_OPTIONS, "status")),
        fieldOf("Resultado", selectEl(RESULT_OPTIONS, "result")),
        fieldOf("Canal", channelSel),
        fieldOf("Rubrica", rubricSel),
        fieldOf("ID da sessão", h("input", { type: "search", placeholder: "exato", maxlength: "128", value: f.query, oninput: function (e) { f.query = e.target.value.trim(); touch(); } }))],
      dirty: isFiltered,
      onSubmit: function () { loadChannels(); pg.reset(); },
      onClear: function () { Object.assign(f, DEFAULTS); pg.forget(); route(); }
    });
    root.appendChild(pageHead("Sessões", "Conversas e a análise mais recente de cada rubrica"));
    root.appendChild(bar.el);
    card = h("div", { class: "card sess-card" }, pg.el);
    root.appendChild(card);
    api("rubrics.ids").then(function (ids) { fillOptions(rubricSel, "rubric", "Todas", ids); }).catch(function () { /* optional */ });
    loadChannels();
    pg.start();
  };

  function sessionDetail(root, rawId) {
    var id = decodeURIComponent(rawId);
    root.appendChild(pageHead("Sessão " + id, null, null, [["Sessões", "#/sessions"], [id]]));
    var box = h("div", null, loading()); root.appendChild(box);
    api("sessions.get", { sessionId: id }).then(function (d) {
      clear(box);
      box.appendChild(h("div", { class: "alert info" }, "Conteúdo mascarado (CPF, CNPJ, e-mail, telefone). Nomes não são mascarados. Este acesso foi registrado na auditoria."));
      reviewCards(d, id).forEach(function (c) { box.appendChild(c); });
      box.appendChild(summaryCard(d));
      var highlight = {}, msgEls = {}, critRows = {};
      d.analyses.forEach(function (a) {
        var crit = d.criteria.filter(function (c) { return c.analysis_id === a.analysis_id; });
        box.appendChild(h("div", { class: "card" },
          d.analyses.length > 1 ? h("h2", null, rubricBadge(a.rubric_id, a.rubric_version)) : null, // the summary already names the rubric; only needed to tell several analyses apart
          !crit.length ? h("p", { class: "muted" }, "Nenhum critério foi avaliado nesta análise (por exemplo, conversa abaixo do mínimo de mensagens exigido pela rubrica).") : table([{ label: "Critério", render: function (r) { return h("span", { class: "mono" }, r.criterion_id); } }, { label: "Aplicabilidade", render: function (r) { return badge(r.applicability_status); } },
            { label: "Resposta", render: function (r) { var x = parseJson(r.evaluation_result); return x && x.answer !== undefined && x.answer !== null ? String(x.answer) : "—"; } },
            { label: "Nota", num: 1, render: function (r) { return fmtNum(r.normalized_score, 0); } }, { label: "Peso", num: 1, render: function (r) { return fmtNum(r.criterion_weight); } },
            { label: "Evidências", render: function (r) { return evidenceLinks(r.evidence_message_ids, d.messages, msgEls); } }], crit, null, function (r, tr) {
            tr.setAttribute("tabindex", "-1");
            critRows[critKey(r.analysis_id, r.criterion_id)] = tr;
          })));
        crit.forEach(function (c) {
          (c.evidence_message_ids || []).forEach(function (m) {
            (highlight[m] = highlight[m] || []).push({
              key: critKey(c.analysis_id, c.criterion_id), id: c.criterion_id, weight: c.criterion_weight, score: c.normalized_score, answer: parseJson(c.evaluation_result), status: c.applicability_status,
              rubric: d.analyses.length > 1 ? a.rubric_id + " v" + a.rubric_version : null
            });
          });
        });
      });
      if (!d.analyses.length) box.appendChild(h("div", { class: "card" }, emptyState("Sessão ainda não analisada.")));
      var evidenceCount = d.messages.filter(function (m) { return highlight[m.message_id]; }).length;
      box.appendChild(h("div", { class: "card" },
        h("div", { class: "chat-head" }, h("h2", null, "Mensagens"), h("span", { class: "badge" }, d.messages.length + (d.messages.length === 1 ? " mensagem" : " mensagens") + (d.truncated ? " (truncado)" : "")),
          evidenceCount ? h("span", { class: "badge warn" }, icon("review", "sm"), evidenceCount + (evidenceCount === 1 ? " evidência" : " evidências")) : null),
        d.messages.length ? chatView(d.messages, highlight, msgEls, critRows) : emptyState("Sem mensagens.", "sessions")));
    }).catch(function (e) { clear(box); box.appendChild(h("div", { class: "alert bad" }, e.message)); });
  }
  // Who is speaking: [label, icon]. Unknown senders are shown as they come, never dropped.
  var SENDER = { customer: ["Cliente", "person"], seller: ["Vendedor", "headset"], bot: ["Bot", "bot"], system: ["Sistema", "info"] };
  // The criteria whose evidence is this message, with the weight each one has in the rubric.
  function critKey(analysisId, criterionId) { return String(analysisId) + "\u0000" + String(criterionId); }
  function criteriaBadges(list, rows) {
    var sorted = list.slice().sort(function (x, y) { return (Number(y.weight) || 0) - (Number(x.weight) || 0) || String(x.id).localeCompare(String(y.id)); });
    return h("div", { class: "crits", "aria-label": "Critérios evidenciados nesta mensagem" }, sorted.map(function (c) {
      var ans = c.answer && c.answer.answer !== undefined && c.answer.answer !== null ? String(c.answer.answer) : null;
      var tip = "Critério " + c.id + " · peso " + fmtNum(c.weight) + (c.score !== null && c.score !== undefined ? " · nota " + fmtNum(c.score, 0) : "") + (ans ? " · resposta " + ans : "") + (c.rubric ? " · " + c.rubric : "");
      var inner = [h("span", { class: "mono" }, c.id), h("span", { class: "w" }, "peso " + fmtNum(c.weight))];
      var row = rows && rows[c.key];
      if (!row) return h("span", { class: "badge crit-badge", title: tip }, inner);
      return h("button", { type: "button", class: "badge crit-badge", title: tip + " · clique para ver na lista de critérios", "aria-label": "Ver o critério " + c.id + " na lista de critérios", onclick: function () { jumpTo(row); } }, inner);
    }));
  }
  // Evidence of a criterion as badges; each one scrolls to its message in the conversation below and flashes it.
  // Scrolls an element into view, moves focus to it and flashes it (used both ways: criterion -> message and message -> criterion).
  function jumpTo(el) {
    var calm = false;
    try { calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* no matchMedia */ }
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
    try { el.focus({ preventScroll: true }); } catch (e) { /* focus is a nicety */ }
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    setTimeout(function () { el.classList.remove("flash"); }, 2000);
  }
  function goToMessage(id, els) { if (els[id]) jumpTo(els[id]); }
  function evidenceLinks(ids, messages, els) {
    if (!ids || !ids.length) return "—";
    var byId = {};
    messages.forEach(function (m) { byId[m.message_id] = m; });
    return h("div", { class: "evid" }, ids.map(function (id) {
      var m = byId[id], label = m && m.sequence_number !== null && m.sequence_number !== undefined ? "#" + m.sequence_number : String(id);
      if (!m) return h("span", { class: "badge", title: "Mensagem " + id + " fora do trecho carregado da conversa" }, label);
      return h("button", { type: "button", class: "badge link", title: "Ir para a mensagem " + id, "aria-label": "Ir para a mensagem " + label, onclick: function () { goToMessage(id, els); } }, icon("review", "sm"), label);
    }));
  }
  function chatView(messages, highlight, els, rows) {
    var lastDay = null, items = [];
    messages.forEach(function (m) {
      var day = dayKey(m.created_at);
      if (day && day !== lastDay) { items.push(h("div", { class: "day", role: "separator" }, pt.day.format(new Date(m.created_at)))); lastDay = day; }
      var kind = SENDER[m.sender_type] ? m.sender_type : "other", who = SENDER[m.sender_type] || [m.sender_type || "Desconhecido", "person"], ev = !!highlight[m.message_id];
      var time = fmtTime(m.created_at);
      var row = h("div", { class: "msg-row " + kind, tabindex: "-1" },
        h("span", { class: "who-av", title: who[0], "aria-hidden": "true" }, icon(who[1])),
        h("div", { class: "msg" + (ev ? " hl" : "") },
          h("div", { class: "meta" }, h("span", { class: "who" }, who[0]), h("span", { class: "seq" }, "#" + (m.sequence_number === null || m.sequence_number === undefined ? "?" : m.sequence_number)),
            time ? h("span", null, time) : null, h("span", { class: "mid mono", title: "ID da mensagem" }, m.message_id)),
          h("div", { class: "body" }, m.content),
          ev ? criteriaBadges(highlight[m.message_id], rows) : null));
      if (els) els[m.message_id] = row;
      items.push(row);
    });
    return h("div", { class: "chat", role: "log", "aria-label": "Mensagens da conversa" }, items);
  }
  function parseJson(t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }

  // ---------- "Como funciona": the pipeline with this workspace's live numbers, and a replay of one real analysis ----------
  // Nothing here calls the AI provider: the replay re-reads what was stored (conversation, rubric, answers, score), so it costs nothing.
  var FLOW = [
    { key: "source", step: 0, title: "Conversas", where: "BigQuery", text: "Sessões e mensagens já ficam no BigQuery, no formato canônico." },
    { key: "trigger", step: null, title: "Gatilho", where: "Job ou evento", text: "Histórico: job sob demanda com teto de custo. Ao vivo: evento da sessão, espera e leitura limitada." },
    { key: "rubric", step: 1, title: "Rubrica", where: "BigQuery", text: "Critérios com peso, obrigatoriedade e aplicabilidade. Rubrica publicada não muda." },
    { key: "ai", step: 2, title: "IA", where: "OpenAI", text: "Só responde a pergunta de cada critério. A confiança do modelo é apenas informativa." },
    { key: "score", step: 3, title: "Pontuação", where: "Regra fixa", text: "Peso × nota, obrigatórios e não aplicáveis calculados por código, sem IA." },
    { key: "result", step: 4, title: "Resultado", where: "BigQuery", text: "Nota, status, motivo e evidências gravados. Um retry não duplica o resultado." },
    { key: "review", step: 5, title: "Revisão", where: "Console", text: "Quando o motor não tem certeza, uma pessoa decide, sem alterar a análise." }
  ];
  var REPLAY_STEPS = [
    ["A conversa", "A conversa chega do BigQuery. Dados pessoais são mascarados antes de qualquer leitura."],
    ["A rubrica", "A rubrica publicada define o que avaliar, quanto cada critério pesa e quando ele se aplica."],
    ["A resposta da IA", "A IA responde cada critério e cita as mensagens que o comprovam. Ela não calcula nota."],
    ["O cálculo", "O motor calcula a nota por regra fixa: Σ(peso × nota) ÷ Σ pesos dos critérios aplicáveis."],
    ["O resultado", "Status, resultado e motivo são gravados no BigQuery junto com o modelo e a versão do prompt."],
    ["A revisão humana", "Quando a decisão é incerta, a análise vai para a fila e uma pessoa decide."]
  ];
  // Architecture, in four lanes. `step` ties a component to the replay step that uses it (it lights up while that step is shown).
  var ARCH_LANES = ["Entrada", "Disparo", "Processamento", "Saída"];
  var ARCH = [
    { id: "conversations", lane: 0, step: 0, title: "Conversas", where: "BigQuery · commerce", text: "Sessões e mensagens no formato canônico, sempre lidas com filtro de organização e workspace." },
    { id: "rubrics", lane: 0, step: 1, title: "Rubricas", where: "BigQuery · conversation_config", text: "Versões publicadas e imutáveis, com critérios, pesos e regras de aplicabilidade." },
    { id: "event", lane: 0, step: null, title: "Evento da sessão", where: "Pub/Sub", text: "O sistema de origem avisa que a sessão mudou. Nunca se assume evento de inserção do BigQuery." },
    { id: "historical", lane: 1, step: null, title: "Job histórico", where: "Cloud Run Job", text: "Varre sessões por partição, com checkpoint, estimativa prévia e teto de custo aprovado." },
    { id: "live", lane: 1, step: null, title: "Worker ao vivo", where: "Cloud Run", text: "Recebe o evento, espera a conversa assentar, lê só aquela sessão e ignora conteúdo repetido." },
    { id: "engine", lane: 2, step: 3, title: "Motor de avaliação", where: "Código compartilhado", text: "O mesmo motor nos dois modos: monta as perguntas e calcula a nota por regra fixa." },
    { id: "budget", lane: 2, step: null, title: "Teto de custo", where: "Controle", text: "Reserva o pior caso antes de chamar a IA e recusa o que passaria do limite." },
    { id: "openai", lane: 2, step: 2, title: "IA", where: "OpenAI · externo", text: "Decisions API ou Responses API. Só responde cada critério e cita as mensagens." },
    { id: "results", lane: 3, step: 4, title: "Resultados", where: "BigQuery · conversation_analytics", text: "Análises e critérios só são acrescentados; a visão de último resultado evita duplicidade." },
    { id: "console", lane: 3, step: 5, title: "Este console", where: "Apps Script", text: "Painel, sessões, rubricas e fila de revisão. A decisão humana fica ao lado da análise." }
  ];
  // What each component is doing for this workspace, from the same numbers as the flow. Returns [label, badge class, detail].
  function archState(id, o) {
    var one = function (rows, f) { return rows && rows[0] ? rows[0][f] : null; };
    var models = o.models || [], run = o.lastRun && o.lastRun[0];
    var used = function (mode) { return models.some(function (m) { return m.analysis_mode === mode; }) || (!!run && run.processing_mode === mode); };
    var analyses = Number(one(o.cost, "analyses")) || 0, sessions = Number(one(o.source, "sessions")) || 0, decided = Number(one(o.decided, "decided")) || 0;
    if (id === "conversations") return sessions ? ["Em uso", "ok", fmtInt(sessions) + " sessões"] : ["Sem dados", "", "Nenhuma sessão"];
    if (id === "rubrics") return ["Em uso", "ok", "Publicada e imutável"];
    if (id === "historical") return used("historical") ? ["Em uso", "ok", run && run.processing_mode === "historical" ? "Última: " + fmtDt(run.created_at) : "Já executou"] : ["Não executou", "", "Nenhuma execução"];
    if (id === "live") return used("live") ? ["Em uso", "ok", "Recebendo sessões"] : ["Não ativado", "warn", "Mesmo motor, ainda sem implantação"];
    if (id === "event") return used("live") ? ["Em uso", "ok", "Eventos chegando"] : ["Não ativado", "warn", "Depende do produtor do evento"];
    if (id === "engine") return analyses ? ["Em uso", "ok", fmtInt(analyses) + " análises"] : ["Sem análises", "", "—"];
    if (id === "budget") return ["Sempre ativo", "ok", "Recusa acima do teto"];
    if (id === "openai") { var m0 = models[0]; return m0 ? ["Em uso", "ok", m0.model + " · " + fmtUsd(one(o.cost, "cost_usd"))] : ["Sem uso", "", "Nenhuma chamada"]; }
    if (id === "results") return analyses ? ["Em uso", "ok", fmtInt(analyses) + " análises gravadas"] : ["Vazio", "", "Sem resultados"];
    return ["Você está aqui", "info", fmtInt(decided) + " revisões decididas"];
  }
  var PROC_MODE = { historical: "Histórico", live: "Ao vivo" };
  var TYPE_LABEL = { PREDICATE: "Sim/Não", CHOICE: "Escolha", SCORE: "Níveis" };
  function ruleText(r) {
    if (!r) return "Sempre";
    if (r.type === "depends_on") return "Se " + r.criterion_id + " = " + (r.equals || []).join(" ou ");
    if (r.type === "all_of") return (r.rules || []).map(ruleText).join(" e ");
    return "Regra condicional";
  }
  function flowMetric(key, o) {
    var one = function (rows, f) { return rows && rows[0] ? rows[0][f] : null; };
    var res = o.results || [], total = 0, appr = 0, rej = 0, rev = 0, nev = 0;
    res.forEach(function (r) {
      var n = Number(r.analyses) || 0; total += n;
      if (r.approval_status === "APPROVED") appr += n; if (r.approval_status === "REJECTED") rej += n;
      if (r.analysis_status === "NEEDS_REVIEW") rev += n; if (r.analysis_status === "NOT_EVALUABLE") nev += n;
    });
    var decided = Number(one(o.decided, "decided")) || 0;
    if (key === "source") return fmtInt(Number(one(o.source, "sessions")) || 0) + " sessões";
    if (key === "trigger") { var r0 = o.lastRun && o.lastRun[0]; return r0 ? (PROC_MODE[r0.processing_mode] || r0.processing_mode) + " · " + (STATUS[r0.run_status] || [r0.run_status])[0] + " · " + fmtDt(r0.created_at) : "Nenhuma execução ainda"; }
    if (key === "rubric") return "Publicada e imutável";
    if (key === "ai") { var m0 = o.models && o.models[0]; var usd = one(o.cost, "cost_usd"); return m0 ? m0.model + " · " + fmtInt(Number(one(o.cost, "analyses")) || 0) + " análises · " + fmtUsd(usd) : "Sem análises ainda"; }
    if (key === "score") return "Sem IA";
    if (key === "result") return total ? fmtInt(total) + " análises: " + fmtInt(appr) + " aprovadas, " + fmtInt(rej) + " reprovadas, " + fmtInt(rev) + " em revisão, " + fmtInt(nev) + " não avaliáveis" : "Sem resultados ainda";
    if (key === "review") return fmtInt(Math.max(0, rev - decided)) + " aguardando · " + fmtInt(decided) + " decididas";
    return "";
  }
  VIEWS.how = function (root) {
    var overview = {}, current = { step: 0, playing: false, speed: 4000, data: null, rubric: null, error: null }, timer = null;
    var flowBox = h("div", { class: "flow", role: "list", "aria-label": "Etapas do fluxo" });
    var replayBox = h("div", null, loading());
    var archBox = h("div", { class: "arch", role: "list", "aria-label": "Componentes da arquitetura" });
    function drawArch() {
      clear(archBox);
      ARCH_LANES.forEach(function (lane, li) {
        var col = h("div", { class: "lane", role: "listitem", "aria-label": lane }, h("div", { class: "lane-t" }, lane));
        ARCH.filter(function (n) { return n.lane === li; }).forEach(function (n) {
          var st = archState(n.id, overview), on = n.step !== null && n.step === current.step && !!current.data;
          col.appendChild(h("div", { class: "node" + (on ? " on" : "") + (st[1] === "warn" ? " idle" : ""), "aria-current": on ? "step" : null },
            h("div", { class: "t" }, n.title), h("div", { class: "w" }, n.where), h("div", { class: "x" }, n.text),
            h("div", { class: "m" }, h("span", { class: "badge " + st[1] }, st[0]), h("span", { class: "d" }, st[2]))));
        });
        archBox.appendChild(col);
      });
    }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } current.playing = false; }
    function drawFlow() {
      clear(flowBox);
      FLOW.forEach(function (st, idx) {
        var on = st.step !== null && st.step === current.step && !!current.data;
        var attrs = { class: "stage" + (on ? " on" : ""), role: "listitem" };
        var body = [h("div", { class: "n" }, String(idx + 1)), h("div", { class: "t" }, st.title), h("div", { class: "w" }, st.where), h("div", { class: "x" }, st.text),
          h("div", { class: "m" }, flowMetric(st.key, overview))];
        if (st.step !== null) flowBox.appendChild(h("button", { type: "button", class: attrs.class, role: "listitem", "aria-current": on ? "step" : null, title: "Ver esta etapa no replay", onclick: function () { stopTimer(); current.step = st.step; drawFlow(); drawReplay(); } }, body));
        else flowBox.appendChild(h("div", attrs, body));
      });
      drawArch();
    }
    function loadOverview() {
      api("pipeline.overview", {}).then(function (o) { overview = o; drawFlow(); }).catch(function (e) { clear(flowBox); flowBox.appendChild(h("div", { class: "alert bad" }, e.message || "Não foi possível carregar os números.")); });
    }
    function stepBody() {
      var d = current.data, a = d.analyses[0], crit = d.criteria.filter(function (c) { return c.analysis_id === a.analysis_id; }), rub = current.rubric;
      var step = current.step, byId = {};
      (rub ? rub.draft.criteria : []).forEach(function (c) { byId[c.criterion_id] = c; });
      var name = function (id) { return byId[id] && byId[id].criterion_name ? byId[id].criterion_name : id; };
      var answerOf = function (c) { var x = parseJson(c.evaluation_result); return x && x.answer !== undefined && x.answer !== null ? String(x.answer) : "—"; };
      if (step === 0) {
        var shown = d.messages.slice(0, 8);
        return [h("p", { class: "muted" }, "Origem: tabelas de sessões e mensagens do BigQuery. Esta sessão tem " + fmtInt(d.messages.length) + " mensagens; só o texto vai para a IA."),
          chatView(shown, {}, null, null), d.messages.length > shown.length ? h("p", { class: "muted small" }, "… e mais " + fmtInt(d.messages.length - shown.length) + " mensagens.") : null];
      }
      if (step === 1) {
        if (!rub) return [alertBox("info", "Os detalhes desta rubrica não estão disponíveis.")];
        var pol = rub.draft.policy || {};
        return [h("p", { class: "muted" }, "Rubrica ", rubricBadge(a.rubric_id, a.rubric_version), " · aprovação mínima ", h("strong", null, fmtNum(pol.minimum_approval_score, 0)), " · sem evidência: ", pol.missing_evidence_policy === "EXCLUDE_OPTIONAL" ? "ignora os opcionais, pede revisão nos obrigatórios" : "pede revisão"),
          table([{ label: "Critério", render: function (c) { return h("span", null, h("strong", null, c.criterion_name || c.criterion_id), " ", h("span", { class: "mono muted" }, c.criterion_id)); } },
            { label: "Tipo", render: function (c) { return TYPE_LABEL[c.evaluation_type] || c.evaluation_type; } }, { label: "Peso", num: 1, render: function (c) { return fmtNum(c.weight); } },
            { label: "Obrigatório", render: function (c) { return c.required ? h("span", { class: "badge warn" }, "Obrigatório") : "—"; } },
            { label: "Quando se aplica", render: function (c) { return ruleText(c.applicability_rule); } }], rub.draft.criteria.filter(function (c) { return c.enabled !== false; }))];
      }
      if (step === 2) {
        if (!crit.length) return [alertBox("info", "Nenhum critério foi avaliado nesta análise (por exemplo, conversa abaixo do mínimo de mensagens da rubrica). Nesse caso a IA nem é chamada.")];
        return [h("p", { class: "muted" }, "Modelo ", h("span", { class: "mono" }, a.model || "—"), " · prompt ", h("span", { class: "mono" }, a.prompt_version || "—"), " · custo ", fmtUsd(a.estimated_cost_usd)),
          table([{ label: "Critério", render: function (c) { return name(c.criterion_id); } }, { label: "Resposta da IA", render: function (c) { return h("span", { class: "mono" }, answerOf(c)); } },
            { label: "Situação", render: function (c) { return badge(c.applicability_status); } },
            { label: "Evidências", num: 1, render: function (c) { return fmtInt((c.evidence_message_ids || []).length); } },
            { label: "Confiança (só informativa)", num: 1, render: function (c) { return c.confidence === null || c.confidence === undefined ? "—" : fmtPct(c.confidence); } }], crit),
          h("p", { class: "muted small" }, "A confiança nunca entra na nota. Critério sem evidência não vira zero: vai para revisão ou fica de fora, conforme a política.")];
      }
      if (step === 3) {
        var app = crit.filter(function (c) { return c.applicability_status === "APPLICABLE" && c.normalized_score !== null && c.normalized_score !== undefined; });
        var totalW = app.reduce(function (s, c) { return s + Number(c.criterion_weight || 0); }, 0);
        var min = rub && rub.draft.policy ? Number(rub.draft.policy.minimum_approval_score) : null;
        return [table([{ label: "Critério", render: function (c) { return name(c.criterion_id); } },
          { label: "Nota (0 a 100)", num: 1, render: function (c) { return c.normalized_score === null || c.normalized_score === undefined ? "—" : fmtNum(c.normalized_score, 0); } },
          { label: "Peso", num: 1, render: function (c) { return fmtNum(c.criterion_weight); } },
          { label: "Contribuição", num: 1, render: function (c) {
            if (c.applicability_status !== "APPLICABLE" || c.normalized_score === null || c.normalized_score === undefined) return h("span", { class: "muted" }, "fora do cálculo");
            return totalW ? fmtNum(Number(c.criterion_weight) * Number(c.normalized_score) / totalW, 1) : "—";
          } },
          { label: "Obrigatório", render: function (c) {
            var req = byId[c.criterion_id] && byId[c.criterion_id].required;
            if (!req) return "—";
            return min !== null && c.normalized_score !== null && Number(c.normalized_score) < min ? h("span", { class: "badge bad" }, "abaixo do mínimo") : h("span", { class: "badge ok" }, "ok");
          } }], crit),
          h("p", null, "Σ pesos aplicáveis = ", h("strong", null, fmtNum(totalW, 0)), " · nota = ", h("strong", null, fmtNum(a.overall_score)), min !== null ? " · mínimo " + fmtNum(min, 0) : ""),
          h("p", { class: "muted small" }, "Não aplicável e sem evidência não valem zero: saem do cálculo. Um critério obrigatório abaixo do mínimo reprova mesmo com a média acima dele.")];
      }
      if (step === 4) {
        return [h("div", { class: "summary-grid" }, kv("Status da análise", badge(a.analysis_status)), kv("Resultado", a.approval_status ? badge(a.approval_status) : "—"), kv("Nota", h("strong", null, fmtNum(a.overall_score))),
          kv("Modelo", h("span", { class: "mono" }, a.model || "—")), kv("Prompt", h("span", { class: "mono" }, a.prompt_version || "—"))), reasonBlock(a),
          h("p", { class: "muted small" }, "Gravado no BigQuery com a rubrica, o modelo e a versão do prompt. Repetir a análise da mesma conversa com os mesmos dados não cria outro resultado.")];
      }
      var dec = (d.decisions || []).filter(function (x) { return x.analysis_id === a.analysis_id; })[0];
      if (dec) return [h("p", null, "Decisão registrada: ", badge(dec.decision), " por ", dec.reviewer_email || "—", " em ", fmtDt(dec.decided_at), "."), h("p", { class: "muted small" }, "A análise original não foi alterada: a decisão fica ao lado dela.")];
      if (a.analysis_status === "NEEDS_REVIEW") return [alertBox("warn", "Esta análise está na fila de revisão. Um Editor ou Administrador confirma, discorda ou pede nova análise."), h("a", { class: "btn primary", href: "#/sessions/" + encodeURIComponent(d.session.session_id), onclick: go("#/sessions/" + encodeURIComponent(d.session.session_id)) }, "Abrir a sessão para decidir")];
      return [h("p", null, "Esta análise não precisou de revisão humana."), h("p", { class: "muted small" }, "Quando o motor não tem certeza (evidência insuficiente ou conversa curta demais), a análise vai para a fila de revisão e uma pessoa decide.")];
    }
    function drawReplay() {
      clear(replayBox);
      if (current.error) { replayBox.appendChild(alertBox("bad", current.error)); return; }
      if (!current.data) { replayBox.appendChild(emptyState("Escolha uma sessão analisada para ver o replay.", "sessions")); return; }
      var step = current.step, last = REPLAY_STEPS.length - 1;
      var tabs = h("div", { class: "rsteps", role: "group", "aria-label": "Passos do replay" }, REPLAY_STEPS.map(function (s, i) {
        return h("button", { type: "button", class: "rstep" + (i === step ? " on" : "") + (i < step ? " done" : ""), "aria-current": i === step ? "step" : null, onclick: function () { stopTimer(); current.step = i; drawFlow(); drawReplay(); } },
          h("span", { class: "n" }, String(i + 1)), h("span", { class: "l" }, s[0]));
      }));
      function iconBtn(label, ic, disabled, fn) { return h("button", { class: "btn icon", type: "button", "aria-label": label, title: label, disabled: disabled, onclick: fn }, icon(ic)); }
      function go1(i) { stopTimer(); current.step = i; drawFlow(); drawReplay(); }
      function toggle() {
        if (current.playing) { stopTimer(); drawReplay(); return; }
        if (current.step >= last) current.step = 0;
        current.playing = true;
        timer = setInterval(function () {
          if (!document.body.contains(replayBox)) { stopTimer(); return; }
          if (current.step >= last) { stopTimer(); drawFlow(); drawReplay(); return; }
          current.step += 1; drawFlow(); drawReplay();
        }, current.speed);
        drawFlow(); drawReplay();
      }
      var speed = h("select", { "aria-label": "Velocidade", onchange: function (e) { current.speed = Number(e.target.value); if (current.playing) { stopTimer(); toggle(); } } },
        [["7000", "Lenta"], ["4000", "Normal"], ["2000", "Rápida"]].map(function (o) { return h("option", { value: o[0], selected: Number(o[0]) === current.speed }, o[1]); }));
      var controls = h("div", { class: "rctl" }, iconBtn("Passo anterior", "prev", step === 0, function () { go1(step - 1); }),
        h("button", { class: "btn primary", type: "button", onclick: toggle }, icon(current.playing ? "pause" : "play", "sm"), current.playing ? "Pausar" : step >= last ? "Reproduzir de novo" : "Reproduzir"),
        iconBtn("Próximo passo", "chevron", step >= last, function () { go1(step + 1); }), h("span", { class: "spacer" }), h("label", { class: "muted small" }, "Velocidade ", speed));
      replayBox.appendChild(tabs);
      replayBox.appendChild(h("div", { class: "rpanel", "aria-live": "polite" }, h("h3", null, (step + 1) + ". " + REPLAY_STEPS[step][0]), h("p", null, REPLAY_STEPS[step][1]), stepBody()));
      replayBox.appendChild(controls);
    }
    function openSession(id) {
      stopTimer(); current.data = null; current.rubric = null; current.error = null; current.step = 0; clear(replayBox); replayBox.appendChild(loading());
      api("sessions.get", { sessionId: id }).then(function (d) {
        if (!d.analyses.length) { current.error = "Esta sessão ainda não foi analisada."; drawReplay(); return; }
        current.data = d;
        var a = d.analyses[0];
        return api("rubrics.get", { rubric_id: a.rubric_id, version: a.rubric_version }).then(function (r) { current.rubric = r; }, function () { current.rubric = null; });
      }).then(function () { drawFlow(); drawReplay(); }).catch(function (e) { current.error = e.message || "Não foi possível carregar a sessão."; drawReplay(); });
    }
    root.appendChild(pageHead("Como funciona", "O caminho de uma conversa até o resultado, com os números reais deste workspace", h("button", { class: "btn", type: "button", onclick: loadOverview }, icon("refresh", "sm"), "Atualizar números"), [["Como funciona"]]));
    root.appendChild(h("div", { class: "card" }, h("h2", null, "O fluxo, ao vivo"), h("p", { class: "muted" }, "Cada etapa mostra onde os dados deste workspace estão agora. Clique numa etapa para vê-la no replay."), flowBox));
    root.appendChild(h("div", { class: "card" }, h("h2", null, "A arquitetura, ao vivo"), h("p", { class: "muted" }, "Os componentes da solução e o que cada um está fazendo neste workspace. Durante o replay, acende o componente do passo mostrado. “Não ativado” indica parte pronta no código que ainda não recebeu dados."), archBox));
    var picker = h("select", { "aria-label": "Sessão para o replay", onchange: function (e) { if (e.target.value) openSession(e.target.value); } }, h("option", { value: "" }, "Carregando sessões…"));
    root.appendChild(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Replay de uma análise real"), h("label", { class: "muted small" }, "Sessão ", picker)),
      h("p", { class: "muted" }, "Reproduz, passo a passo, o que está gravado para uma sessão. Não chama a IA e não gera custo. Abrir o conteúdo da conversa fica registrado na auditoria."), replayBox));
    root.appendChild(h("div", { class: "card" }, h("h2", null, "O que a IA faz e o que não faz"), h("ul", { class: "how-list" },
      h("li", null, h("strong", null, "A IA só responde perguntas."), " Cada critério vira uma pergunta; ela devolve a resposta e as mensagens que a sustentam."),
      h("li", null, h("strong", null, "A nota é por regra."), " Peso, obrigatoriedade, aplicabilidade e mínimo de aprovação são calculados por código e dão o mesmo resultado em histórico e ao vivo."),
      h("li", null, h("strong", null, "Sem evidência não é zero."), " Não aplicável e evidência insuficiente ficam de fora ou vão para revisão humana."),
      h("li", null, h("strong", null, "Texto da conversa é dado, não instrução."), " Tentativas de prompt injection são ignoradas e dados pessoais são mascarados."),
      h("li", null, h("strong", null, "Custo tem teto."), " Todo job histórico tem estimativa prévia e um limite aprovado; passou dele, para."))));
    var today = new Date(), from = new Date(today.getTime() - 364 * 864e5), iso = function (x) { return x.toISOString().slice(0, 10); };
    loadOverview();
    api("sessions.list", { from: iso(from), to: iso(today), status: "", limit: 50 }).then(function (r) {
      var rows = r.rows.filter(function (x) { return x.analysis_status; });
      clear(picker);
      if (!rows.length) { picker.appendChild(h("option", { value: "" }, "Nenhuma sessão analisada")); current.data = null; drawFlow(); drawReplay(); return; }
      picker.appendChild(h("option", { value: "" }, "Escolha uma sessão"));
      rows.forEach(function (x) { picker.appendChild(h("option", { value: x.session_id }, x.session_id + " · " + (STATUS[x.approval_status || x.analysis_status] || [x.approval_status || x.analysis_status])[0] + (x.overall_score !== null && x.overall_score !== undefined ? " · nota " + fmtNum(x.overall_score) : ""))); });
      picker.value = rows[0].session_id; openSession(rows[0].session_id);
    }).catch(function (e) { clear(picker); picker.appendChild(h("option", { value: "" }, "Erro ao listar")); current.error = e.message; drawReplay(); });
    drawFlow();
  };

  // The human-review flow. A decision is stored next to the analysis (review_decisions): it never changes the analysis, its score or its status.
  var DECISION_INFO = {
    CONFIRMED: ["Confirmar o resultado", "O resultado do motor está adequado. Não precisa de justificativa."],
    DISAGREED: ["Discordar do resultado", "O resultado está incorreto ou injusto. Explique o motivo."],
    REANALYSIS: ["Pedir nova análise", "Falta informação, a conversa ou a rubrica mudou. Explique o motivo."]
  };
  var MAX_REVIEW_COMMENT = 1000;
  function reviewReason(r) {
    if (r.insufficient > 0) return "Evidência insuficiente em " + r.insufficient + " de " + r.criteria + (r.criteria === 1 ? " critério" : " critérios");
    if (!r.criteria) return "Sem avaliação por critério (conversa curta demais para a rubrica)";
    return "Decisão incerta: o motor pediu confirmação humana";
  }
  VIEWS.review = function (root) {
    var f = { filter: "pending", days: 90 };
    var pg = makePager({
      key: "review", extra: function () { return f; },
      load: function (cursor, limit) { return api("review.list", { limit: limit, cursor: cursor, filter: f.filter, days: f.days }); },
      count: function () { return api("review.count", { filter: f.filter, days: f.days }); },
      empty: function () { return emptyState(f.filter === "decided" ? "Nenhuma decisão registrada ainda." : f.filter === "all" ? "A fila está vazia neste período." : "Nada aguardando revisão.", f.filter === "pending" ? "ok" : "inbox"); },
      draw: function (rows) {
        return table([
          { label: "Sessão", render: function (r) { return h("span", { class: "mono" }, r.session_id); } },
          { label: "Por que está na fila", render: function (r) { return reviewReason(r); } },
          { label: "Rubrica", render: function (r) { return rubricBadge(r.rubric_id, r.rubric_version); } },
          { label: "Concluída em", render: function (r) { return fmtDt(r.completed_at); } },
          { label: "Situação", render: function (r) { return r.decision ? h("span", null, badge(r.decision), h("span", { class: "muted small", style: "margin-left:8px" }, (r.reviewer_email || "") + " · " + fmtDt(r.decided_at))) : badge("PENDING_REVIEW"); } },
          { label: "", render: function (r) { var href = "#/sessions/" + encodeURIComponent(r.session_id); return h("a", { class: "btn small" + (!r.decision && canDecide ? " primary" : ""), href: href, onclick: go(href) }, r.decision || !canDecide ? "Abrir" : "Revisar"); } }
        ], rows, function (r) { location.hash = "#/sessions/" + encodeURIComponent(r.session_id); });
      }
    });
    if (pg.saved) Object.assign(f, pg.saved);
    var canDecide = RANK[state.role] >= RANK.EDITOR;
    root.appendChild(pageHead("Fila de revisão", "Análises que o motor não conseguiu concluir sozinho e esperam uma decisão humana"));
    root.appendChild(h("div", { class: "card howto" }, h("h2", null, "Como revisar"),
      h("ol", { class: "steps" },
        h("li", null, h("strong", null, "Abra a sessão. "), "Veja por que ela veio para a fila."),
        h("li", null, h("strong", null, "Leia a conversa. "), "As mensagens usadas como evidência ficam destacadas."),
        h("li", null, h("strong", null, "Registre sua decisão: "), "confirmar o resultado, discordar ou pedir uma nova análise.")),
      h("p", { class: "muted" }, "Sua decisão fica registrada ao lado da análise (quem, quando e por quê). A nota, o status e a rubrica originais não mudam.",
        canDecide ? "" : " Seu perfil (" + ROLE_LABEL[state.role] + ") pode consultar a fila, mas só Editor ou Administrador registra decisões.")));
    var tabs = h("div", { class: "seg", role: "group", "aria-label": "Situação" }, [["pending", "Pendentes"], ["decided", "Decididas"], ["all", "Todas"]].map(function (o) {
      var b = h("button", { type: "button", "aria-pressed": o[0] === f.filter ? "true" : "false", onclick: function () {
        f.filter = o[0]; Array.prototype.forEach.call(tabs.children, function (x) { x.setAttribute("aria-pressed", "false"); }); b.setAttribute("aria-pressed", "true"); pg.reset(); if (bar) bar.update();
      } }, o[1]);
      return b;
    }));
    var bar = filterBar({
      fields: [groupField("Situação", tabs), daysSelect(f, function () { pg.reset(); bar.update(); })],
      dirty: function () { return f.filter !== "pending" || f.days !== 90; },
      onClear: function () { f.filter = "pending"; f.days = 90; pg.forget(); route(); }
    });
    root.appendChild(bar.el);
    root.appendChild(h("div", { class: "card" }, pg.el));
    pg.start();
  };

  // Goes to the next session still waiting for a decision, or back to the queue when there is none.
  function nextInQueue(currentId) {
    api("review.list", { limit: 20, filter: "pending" }).then(function (page) {
      var next = page.rows.filter(function (r) { return r.session_id !== currentId; })[0];
      location.hash = next ? "#/sessions/" + encodeURIComponent(next.session_id) : "#/review";
    }).catch(showError);
  }

  // One card per analysis that is (or was) in review: the reason, what to do, and either the decision form or the decision already recorded.
  function reviewCards(d, sessionId) {
    var decided = {};
    (d.decisions || []).forEach(function (x) { if (!decided[x.analysis_id]) decided[x.analysis_id] = x; });
    return d.analyses.filter(function (a) { return a.analysis_status === "NEEDS_REVIEW" || decided[a.analysis_id]; }).map(function (a) {
      var crit = d.criteria.filter(function (c) { return c.analysis_id === a.analysis_id; });
      var done = decided[a.analysis_id];
      var head = h("div", { class: "chat-head" }, h("h2", null, "Revisão"), rubricBadge(a.rubric_id, a.rubric_version), done ? badge(done.decision) : badge("PENDING_REVIEW"));
      if (done) {
        return h("div", { class: "card review done" }, head,
          h("p", null, h("strong", null, DECISION_INFO[done.decision] ? DECISION_INFO[done.decision][0] : done.decision), " · ", done.reviewer_email, " · ", fmtDt(done.decided_at)),
          done.comment ? h("blockquote", { class: "quote" }, done.comment) : h("p", { class: "muted" }, "Sem justificativa."),
          h("p", { class: "muted small" }, "A análise original não foi alterada: nota ", fmtNum(a.overall_score), ", status ", (STATUS[a.analysis_status] || [a.analysis_status])[0], "."));
      }
      var ins = crit.filter(function (c) { return c.applicability_status === "INSUFFICIENT_EVIDENCE"; });
      var why = [];
      if (!crit.length) why.push("Não houve avaliação por critério: a conversa tem menos mensagens do que a rubrica exige.");
      if (ins.length) why.push("Sem evidência suficiente em " + ins.length + " de " + crit.length + " critérios: " + ins.map(function (c) { return c.criterion_id; }).join(", ") + ".");
      if (!why.length) why.push("A decisão do modelo ficou incerta ou perto do limite, e o motor pediu confirmação humana.");
      var body = [head, h("div", { class: "review-why" }, h("div", { class: "acct-t" }, "Por que está aqui"), h("ul", null, reasonItems(a).concat(why.map(function (t) { return h("li", null, t); }))),
        h("div", { class: "muted" }, "Nota do motor: ", h("strong", null, fmtNum(a.overall_score)), a.approval_status ? " · " + (STATUS[a.approval_status] || [a.approval_status])[0] : ""))];
      if (RANK[state.role] < RANK.EDITOR) {
        body.push(alertBox("info", "Seu perfil (" + ROLE_LABEL[state.role] + ") pode consultar esta análise, mas só Editor ou Administrador registra a decisão."));
        return h("div", { class: "card review" }, body);
      }
      var sel = null, comment = "", btn, hint;
      var name = "dec-" + a.analysis_id;
      var choices = h("div", { class: "choices", role: "radiogroup", "aria-label": "Sua decisão" }, Object.keys(DECISION_INFO).map(function (k) {
        return h("label", { class: "choice" }, h("input", { type: "radio", name: name, value: k, onchange: function () { sel = k; refresh(); } }), h("span", { class: "t" }, DECISION_INFO[k][0]), h("span", { class: "d" }, DECISION_INFO[k][1]));
      }));
      var counter = h("span", { class: "muted small" }, "0/" + MAX_REVIEW_COMMENT);
      var ta = h("textarea", { maxlength: String(MAX_REVIEW_COMMENT), placeholder: "Justificativa (obrigatória para discordar ou pedir nova análise)", "aria-label": "Justificativa",
        oninput: function (e) { comment = e.target.value; counter.textContent = comment.length + "/" + MAX_REVIEW_COMMENT; refresh(); } });
      function valid() { return !!sel && (sel === "CONFIRMED" || comment.trim().length >= 3); }
      function refresh() {
        btn.disabled = !valid();
        hint.textContent = !sel ? "Escolha uma decisão para continuar." : valid() ? "Pronto para registrar." : "Explique o motivo (pelo menos 3 caracteres).";
      }
      btn = h("button", { class: "btn primary", type: "button", disabled: true, onclick: function () {
        confirmModal("Registrar decisão?", h("div", null, h("p", null, "Decisão: ", h("strong", null, DECISION_INFO[sel][0]), "."),
          h("p", { class: "muted" }, "Ela ficará registrada ao lado da análise e não poderá ser alterada. A nota e o status originais não mudam.")), "Registrar decisão").then(function (yes) {
          if (!yes) return;
          btn.disabled = true;
          api("review.decide", { sessionId: sessionId, analysisId: a.analysis_id, decision: sel, comment: comment.trim() }).then(function () { toast("Decisão registrada."); route(); }).catch(function (e) { showError(e); refresh(); });
        });
      } }, "Registrar decisão");
      hint = h("span", { class: "muted small" }, "");
      body.push(h("div", { class: "acct-t", style: "margin-top:16px" }, "O que fazer"),
        h("p", { class: "muted", style: "margin-top:0" }, "Leia a conversa abaixo (as evidências estão destacadas) e compare com os critérios da análise. Depois escolha uma decisão."),
        choices, h("label", { style: "margin-top:12px" }, h("span", { class: "row", style: "margin:0;justify-content:space-between" }, h("span", null, "Justificativa"), counter), ta),
        h("p", { class: "muted small" }, "Não inclua dados pessoais: CPF, e-mail e telefone são mascarados automaticamente. Nomes não são."),
        h("div", { class: "row", style: "margin:12px 0 0;align-items:center" }, btn, h("button", { class: "btn", type: "button", onclick: function () { nextInQueue(sessionId); } }, "Pular para a próxima"), hint));
      refresh();
      return h("div", { class: "card review" }, body);
    });
  }

  VIEWS.runs = function (root) {
    var f = { days: 30 };
    var pg = makePager({
      key: "runs", extra: function () { return f; }, size: 25,
      load: function (cursor, limit) { return api("runs.list", { days: f.days, limit: limit, cursor: cursor }); },
      count: function () { return api("runs.count", { days: f.days }); },
      empty: function () { return emptyState("Nenhuma execução neste período."); },
      draw: function (rows) {
        return table([{ label: "Execução", render: function (r) { return h("span", { class: "mono" }, r.run_id); } }, { label: "Modo", key: "processing_mode" }, { label: "Status", render: function (r) { return badge(r.run_status); } },
          { label: "Rubrica", render: function (r) { return r.rubric_id ? rubricBadge(r.rubric_id, r.rubric_version) : "—"; } }, { label: "Total", num: 1, key: "sessions_total" }, { label: "OK", num: 1, key: "sessions_processed" },
          { label: "Falhas", num: 1, key: "sessions_failed" }, { label: "Puladas", num: 1, key: "sessions_skipped" }, { label: "Custo", num: 1, render: function (r) { return fmtUsd(r.actual_cost_usd); } },
          { label: "Criada", render: function (r) { return fmtDt(r.created_at); } }], rows);
      }
    });
    if (pg.saved) Object.assign(f, pg.saved);
    root.appendChild(pageHead("Execuções", "Histórico e processamento live (última linha de cada execução)"));
    var bar = filterBar({
      fields: [daysSelect(f, function () { pg.reset(); bar.update(); })],
      dirty: function () { return f.days !== 30; },
      onClear: function () { f.days = 30; pg.forget(); route(); }
    });
    root.appendChild(bar.el);
    root.appendChild(h("div", { class: "card" }, pg.el));
    pg.start();
  };
  VIEWS.rubrics = function (root, parts) {
    if (parts[0] && parts[1]) return rubricEditor(root, decodeURIComponent(parts[0]), Number(parts[1]));
    var canEdit = RANK[state.role] >= RANK.EDITOR;
    var pg = makePager({
      key: "rubrics", sizes: [5, 10, 25], size: 10, noun: "Rubricas por página", bare: true,
      unitsOf: function (rows) { return rows.map(function (r) { return r.rubric_id; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).length; },
      load: function (cursor, limit) { return api("rubrics.list", { limit: limit, cursor: cursor }); },
      count: function () { return api("rubrics.count"); },
      empty: function () { return h("div", { class: "card" }, emptyState("Nenhuma rubrica ainda.")); },
      draw: function (rows) {
        var wrap = h("div", null), groups = {}, order = [];
        rows.forEach(function (r) { if (!groups[r.rubric_id]) { groups[r.rubric_id] = []; order.push(r.rubric_id); } groups[r.rubric_id].push(r); });
        order.forEach(function (rid) {
          var versions = groups[rid], hasDraft = versions.some(function (v) { return v.status === "DRAFT"; });
          var latestPub = versions.filter(function (v) { return v.status === "PUBLISHED"; })[0];
          wrap.appendChild(h("div", { class: "card" }, h("div", { class: "row" }, h("h2", { style: "margin:0" }, rid), h("div", { class: "spacer" }),
            canEdit && latestPub && !hasDraft ? h("button", { class: "btn small", onclick: function () { reviseRubric(rid, latestPub.version, latestPub.name); } }, "Nova revisão a partir da v" + latestPub.version) : null),
            table([{ label: "Versão", render: function (r) { return "v" + r.version; } }, { label: "Nome", key: "name" }, { label: "Status", render: function (r) { return badge(r.status); } },
              { label: "Publicada em", render: function (r) { return fmtDt(r.published_at); } }, { label: "Criada em", render: function (r) { return fmtDt(r.created_at); } }], versions,
              function (r) { location.hash = "#/rubrics/" + encodeURIComponent(rid) + "/" + r.version; })));
        });
        return wrap;
      }
    });
    root.appendChild(pageHead("Rubricas", "Rubricas publicadas são imutáveis: para mudar, crie uma nova revisão", canEdit ? h("button", { class: "btn primary", onclick: newRubric }, icon("add", "sm"), "Nova rubrica") : null));
    root.appendChild(pg.el);
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
    pg.start();
  };

  function rubricEditor(root, rid, ver) {
    var box = h("div", null, loading());
    root.appendChild(pageHead("Rubrica " + rid + " v" + ver, null, null, [["Rubricas", "#/rubrics"], [rid + " v" + ver]]));
    root.appendChild(box);
    var model = null, etag = null, dirty = false, status = null;
    var openCrit = []; // criteria currently expanded (by object, never saved); every card starts collapsed so the page stays short
    function render(issues) {
      clear(box);
      if (issues && issues.length) openCrit = model.criteria.slice(); // pending issues point at fields: show them all
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
      var allBar = h("div", { class: "crit-all" }, h("span", { class: "muted" }, fmtInt(model.criteria.length) + (model.criteria.length === 1 ? " critério" : " critérios")), h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn small", onclick: function () { openCrit = model.criteria.slice(); render(issues); } }, "Expandir todos"),
        h("button", { type: "button", class: "btn small", onclick: function () { openCrit = []; render(issues); } }, "Recolher todos"));
      panels["Critérios"] = h("div", null, model.criteria.length > 1 ? allBar : null, model.criteria.map(function (c, i) { return critCard(c, i, ro); }),
        ro ? null : h("button", { class: "btn", onclick: function () { var nc = blankCriterion(model.criteria.length + 1); model.criteria.push(nc); openCrit.push(nc); dirty = true; render(issues); } }, "Adicionar critério"));
      panels["Política"] = policyPanel(model.policy, ro); panels["Política"].hidden = true;
      box.appendChild(panels["Critérios"]); box.appendChild(panels["Política"]);
      var total = model.criteria.filter(function (c) { return c.enabled; }).reduce(function (a, c) { return a + Number(c.weight || 0); }, 0);
      box.appendChild(h("p", { class: "muted" }, "Soma dos pesos habilitados: " + fmtNum(total) + " (os pesos são normalizados na nota)."));
      if (editable) {
        box.appendChild(h("div", { class: "actionbar" },
          h("button", { class: "btn primary", onclick: save }, icon("save", "sm"), "Salvar rascunho"),
          RANK[state.role] >= RANK.ADMIN ? h("button", { class: "btn", onclick: publish }, icon("publish", "sm"), "Publicar…") : h("span", { class: "muted" }, "Somente administradores publicam."),
          h("div", { class: "spacer" }), h("button", { class: "btn danger", onclick: discard }, icon("trash", "sm"), "Descartar rascunho")));
      }
    }
    function blankCriterion(n) {
      return { criterion_id: "", criterion_name: "", evaluation_instructions: "", evaluation_type: "PREDICATE", weight: 10, required: false, enabled: true,
        score_mapping: { "true": 100, "false": 0 }, level_descriptions: {}, applicability_rule: null, display_order: n };
    }
    function critCard(c, i, ro) {
      var drawHead = function () {};
      function set(k, v) { c[k] = v; dirty = true; drawHead(); }
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
        var conds = c.applicability_rule ? c.applicability_rule.conditions : [];
        function sync() { c.applicability_rule = conds.length ? { conditions: conds } : null; dirty = true; drawHead(); drawRule(); }
        // Gate candidates: other criteria that have no rule themselves (a gate cannot be gated: one deterministic pass).
        var candidates = model.criteria.filter(function (x) { return x !== c && x.criterion_id && !x.applicability_rule; });
        ruleBox.appendChild(h("div", { class: "muted" }, conds.length ? "Aplicabilidade: só se TODAS as condições abaixo forem verdadeiras" : "Aplicabilidade: sempre se aplica"));
        conds.forEach(function (cond, idx) {
          var gate = model.criteria.filter(function (x) { return x.criterion_id === cond.criterion_id; })[0];
          var keys = gate ? Object.keys(gate.score_mapping) : [];
          var used = conds.map(function (x) { return x.criterion_id; });
          var sel = h("select", { disabled: ro, "aria-label": "Critério de controle", onchange: function (e) { cond.criterion_id = e.target.value; cond.equals = []; sync(); } },
            candidates.filter(function (x) { return x.criterion_id === cond.criterion_id || used.indexOf(x.criterion_id) < 0; }).map(function (x) {
              return h("option", { value: x.criterion_id, selected: cond.criterion_id === x.criterion_id }, "“" + x.criterion_id + "” for…"); }),
            gate ? null : h("option", { value: cond.criterion_id, selected: true }, "“" + cond.criterion_id + "” (não existe mais)"));
          ruleBox.appendChild(h("div", { class: "row", style: "margin:6px 0 0" }, h("span", { class: "muted" }, idx === 0 ? "Somente se" : "E"), sel,
            keys.map(function (k) {
              return switchField(k, cond.equals.indexOf(k) >= 0, ro, function (e) {
                cond.equals = cond.equals.filter(function (x) { return x !== k; }); if (e.target.checked) cond.equals.push(k); dirty = true; }); }),
            ro ? null : h("button", { class: "btn small", title: "Remover condição", onclick: function () { conds.splice(idx, 1); sync(); } }, "×")));
        });
        var free = candidates.filter(function (x) { return conds.every(function (cc) { return cc.criterion_id !== x.criterion_id; }); });
        if (!ro && free.length && conds.length < 5) {
          ruleBox.appendChild(h("button", { class: "btn small", style: "margin-top:6px", onclick: function () { conds.push({ criterion_id: free[0].criterion_id, equals: [] }); sync(); } },
            conds.length ? "Adicionar condição (E)" : "Aplicar somente se…"));
        }
        if (conds.length) ruleBox.appendChild(h("div", { class: "muted" }, "Fora disso o critério fica “não aplicável” (não entra na nota, nem como zero). Sem resposta de um critério de controle, vai para revisão, a menos que outra condição já exclua. Se todos os critérios ficarem não aplicáveis, a sessão é “não avaliável”. O critério de controle costuma ter peso 0."));
      }
      drawRule();
      var body = h("div", { class: "crit-body", id: "crit-body-" + i }, h("div", { class: "top2" },
        h("label", { class: "grow" }, "Identificador", h("input", { value: c.criterion_id, disabled: ro, maxlength: "64", placeholder: "ex.: saudacao", oninput: function (e) { set("criterion_id", e.target.value.trim()); } })),
        h("label", { class: "grow" }, "Nome", h("input", { value: c.criterion_name, disabled: ro, maxlength: "120", oninput: function (e) { set("criterion_name", e.target.value); } })),
        h("label", null, "Tipo", h("select", { disabled: ro, onchange: function (e) {
          set("evaluation_type", e.target.value);
          if (e.target.value === "PREDICATE") { c.score_mapping = { "true": 100, "false": 0 }; c.level_descriptions = {}; }
          else if (Object.keys(c.score_mapping).length < 2 || c.score_mapping["true"] !== undefined) { c.score_mapping = { baixo: 0, alto: 100 }; c.level_descriptions = {}; }
          drawOpts();
        } }, [["PREDICATE", "Sim/Não"], ["SCORE", "Escala"], ["CHOICE", "Escolha"]].map(function (o) { return h("option", { value: o[0], selected: c.evaluation_type === o[0] }, o[1]); }))),
        h("label", null, "Peso", h("input", { type: "number", min: "0", step: "any", value: c.weight, disabled: ro, style: "width:90px", onchange: function (e) { set("weight", Number(e.target.value)); } })),
        switchField("Obrigatório", c.required, ro, function (e) { set("required", e.target.checked); }),
        switchField("Habilitado", c.enabled, ro, function (e) { set("enabled", e.target.checked); }),
        ro ? null : h("button", { class: "btn small danger", onclick: function () { model.criteria.splice(i, 1); dirty = true; render(null); } }, "Remover")),
        h("label", { style: "margin-top:8px" }, "Pergunta de avaliação (enviada ao modelo)", h("textarea", { disabled: ro, maxlength: "4000", oninput: function (e) { set("evaluation_instructions", e.target.value); } }, c.evaluation_instructions)),
        ruleBox,
        c.evaluation_type === "PREDICATE" ? null : h("div", { class: "muted", style: "margin-top:8px" }, "Opções e notas (0–100). Descreva cada nível: sem definição, o modelo tende a escolher o meio."), opts);
      // Always-visible header: what the criterion is, at a glance, and the control that opens it. It follows the fields while they are edited.
      var TYPE_SHORT = { PREDICATE: "Sim/Não", SCORE: "Escala", CHOICE: "Escolha" };
      var sum = h("span", { class: "crit-sum" });
      // One cell per column (empty ones kept), so every header lines up with the others in the list.
      drawHead = function () {
        clear(sum);
        var flags = h("span", { class: "crit-flags" });
        if (c.required) flags.appendChild(h("span", { class: "badge warn" }, "Obrigatório"));
        if (c.enabled === false) flags.appendChild(h("span", { class: "badge" }, "Desabilitado"));
        if (c.applicability_rule) flags.appendChild(h("span", { class: "badge info" }, "Condicional"));
        sum.appendChild(h("span", { class: "crit-title" }, c.criterion_name || c.criterion_id || "Novo critério"));
        sum.appendChild(h("span", { class: "crit-id mono muted" }, c.criterion_name && c.criterion_id ? c.criterion_id : ""));
        sum.appendChild(h("span", { class: "crit-type" }, h("span", { class: "badge" }, TYPE_SHORT[c.evaluation_type] || c.evaluation_type)));
        sum.appendChild(h("span", { class: "crit-weight" }, h("span", { class: "badge" }, "peso " + fmtNum(Number(c.weight) || 0))));
        sum.appendChild(flags);
      };
      var isOpen = openCrit.indexOf(c) >= 0;
      var card = h("div", { class: "crit" + (isOpen ? " open" : "") });
      var toggle = h("button", { type: "button", class: "crit-toggle", "aria-expanded": isOpen ? "true" : "false", "aria-controls": "crit-body-" + i, onclick: function () {
        isOpen = !isOpen;
        if (isOpen) { if (openCrit.indexOf(c) < 0) openCrit.push(c); } else openCrit = openCrit.filter(function (x) { return x !== c; });
        toggle.setAttribute("aria-expanded", isOpen ? "true" : "false"); body.hidden = !isOpen; card.className = "crit" + (isOpen ? " open" : "");
      } }, icon("chevron", "sm"), sum);
      body.hidden = !isOpen;
      drawHead();
      card.appendChild(toggle); card.appendChild(body);
      return card;
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
        model.criteria.forEach(function (c) { c.level_descriptions = c.level_descriptions || {}; c.applicability_rule = c.applicability_rule && c.applicability_rule.conditions && c.applicability_rule.conditions.length ? c.applicability_rule : null; });
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
    var email = h("input", { type: "email", placeholder: "pessoa@empresa.com", maxlength: "254", required: true });
    var role = h("select", null, ["VIEWER", "EDITOR", "ADMIN"].map(function (r) { return h("option", { value: r }, ROLE_LABEL[r]); }));
    var pg = makePager({
      key: "users", size: 25,
      load: function (cursor, limit) { return api("users.list", { limit: limit, cursor: cursor }); },
      count: function () { return api("users.count"); },
      empty: function () { return emptyState("Nenhum usuário neste workspace.", "users"); },
      draw: function (rows) {
        return table([{ label: "E-mail", key: "email" }, { label: "Papel", render: function (r) { return ROLE_LABEL[r.role] || r.role; } }, { label: "Status", render: function (r) { return badge(r.status); } },
          { label: "Alterado em", render: function (r) { return fmtDt(r.changed_at); } }, { label: "Por", key: "changed_by" },
          { label: "", render: function (r) {
            var sel = h("select", { "aria-label": "Papel de " + r.email, onchange: function () { change(r, sel.value, r.status); } }, ["VIEWER", "EDITOR", "ADMIN"].map(function (x) { return h("option", { value: x, selected: x === r.role }, ROLE_LABEL[x]); }));
            return h("div", { class: "row-actions" }, sel, h("button", { class: "btn small" + (r.status === "ACTIVE" ? " danger" : ""), onclick: function () { change(r, r.role, r.status === "ACTIVE" ? "DISABLED" : "ACTIVE"); } }, r.status === "ACTIVE" ? "Desativar" : "Reativar"));
          } }], rows);
      }
    });
    root.appendChild(pageHead("Usuários e acesso", "Quem pode acessar este workspace e com qual papel"));
    root.appendChild(h("div", { class: "card" }, h("form", { class: "row", onsubmit: function (e) {
      e.preventDefault();
      api("users.upsert", { email: email.value, role: role.value, status: "ACTIVE" }).then(function () { toast("Acesso concedido."); email.value = ""; pg.reload(); }).catch(showError);
    } }, h("label", null, "E-mail corporativo", email), h("label", null, "Papel", role), h("button", { class: "btn primary", type: "submit" }, "Conceder acesso"))));
    root.appendChild(h("div", { class: "card" }, pg.el));
    function change(r, nrole, nstatus) { api("users.upsert", { email: r.email, role: nrole, status: nstatus }).then(function () { toast("Acesso atualizado."); pg.reload(); }).catch(function (e) { showError(e); pg.reload(); }); }
    pg.start();
  };

  VIEWS.audit = function (root) {
    var f = { days: 30 };
    var pg = makePager({
      key: "audit", extra: function () { return f; },
      load: function (cursor, limit) { return api("audit.list", { days: f.days, limit: limit, cursor: cursor }); },
      count: function () { return api("audit.count", { days: f.days }); },
      empty: function () { return emptyState("Sem eventos no período."); },
      draw: function (rows) {
        return table([{ label: "Quando", render: function (r) { return fmtDt(r.occurred_at); } }, { label: "Quem", key: "actor_email" }, { label: "Ação", render: function (r) { return h("span", { class: "mono" }, r.action); } },
          { label: "Alvo", render: function (r) { return r.entity_id ? (r.entity_type || "") + " " + r.entity_id : "—"; } }, { label: "Resultado", render: function (r) { return badge(r.outcome); } },
          { label: "Detalhes", render: function (r) { return h("span", { class: "mono muted" }, r.details && r.details !== "{}" ? r.details : ""); } }], rows);
      }
    });
    if (pg.saved) Object.assign(f, pg.saved);
    root.appendChild(pageHead("Auditoria", "Alterações de configuração e acessos a conteúdo de conversas (somente metadados)"));
    var bar = filterBar({
      fields: [daysSelect(f, function () { pg.reset(); bar.update(); })],
      dirty: function () { return f.days !== 30; },
      onClear: function () { f.days = 30; pg.forget(); route(); }
    });
    root.appendChild(bar.el);
    root.appendChild(h("div", { class: "card" }, pg.el));
    pg.start();
  };

  // ---------- shell & router ----------
  // [route, label, minimum role, icon, group]
  var NAV = [["dashboard", "Painel", "VIEWER", "dashboard", "Análise"], ["sessions", "Sessões", "VIEWER", "sessions", "Análise"], ["review", "Fila de revisão", "VIEWER", "review", "Análise"],
    ["runs", "Execuções", "VIEWER", "runs", "Análise"], ["rubrics", "Rubricas", "VIEWER", "rubrics", "Configuração"], ["users", "Usuários e acesso", "ADMIN", "users", "Administração"],
    ["audit", "Auditoria", "ADMIN", "audit", "Administração"], ["how", "Como funciona", "VIEWER", "how", "Ajuda"]];
  // Per-browser preference: show the "Como funciona" explainer in the menu (on by default). Turning it off only hides the entry and its page.
  function showHow() { try { return localStorage.getItem("sci.how") !== "off"; } catch (e) { return true; } }
  function setShowHow(on) { try { if (on) localStorage.removeItem("sci.how"); else localStorage.setItem("sci.how", "off"); } catch (e) { /* per-browser convenience */ } }
  function navAllowed(n) { return RANK[state.role] >= RANK[n[2]] && (n[0] !== "how" || showHow()); }
  function route() {
    var parts = (location.hash.replace(/^#\/?/, "") || "dashboard").split("/");
    var name = parts.shift();
    var item = NAV.filter(function (n) { return n[0] === name; })[0];
    if (!item || !navAllowed(item)) { location.hash = "#/dashboard"; return; }
    Array.prototype.forEach.call(document.querySelectorAll(".side a"), function (a) { a.removeAttribute("aria-current"); if (a.getAttribute("data-route") === name) a.setAttribute("aria-current", "page"); });
    var main = $("#main"); clear(main); window.__sciDirty = null;
    try {
      VIEWS[name](main, parts);
    } catch (err) {
      // A view that fails to draw must say so instead of leaving a blank page.
      console.error("view_error", name, err && err.name, err && err.message);
      clear(main);
      main.appendChild(h("div", { class: "alert bad" }, h("strong", null, "Não foi possível exibir esta tela."), h("div", null, "Detalhe técnico: " + (err && err.name ? err.name : "Erro") + ": " + (err && err.message ? err.message : ""))));
    }
    main.focus();
  }
  // Sign out, like the Google Cloud Console: ends the Google session in this browser and comes back to the console, which then asks to sign in again.
  // The return address is the web app's own URL given by the server; it is checked again here and, if it is not an Apps Script address, we simply do not ask to come back.
  var APP_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]+\/(?:exec|dev)$/;
  function logoutUrl() {
    var back = state.me && state.me.app_url, base = "https://accounts.google.com/Logout";
    return typeof back === "string" && APP_URL.test(back) ? base + "?continue=" + encodeURIComponent(back) : base;
  }
  function signOut() {
    confirmModal("Sair da conta Google?", h("div", null, h("p", null, "Isso encerra a sessão das contas Google neste navegador, como no Google Cloud Console."),
      h("p", { class: "muted" }, "Para voltar, abra o console e entre de novo.")), "Sair").then(function (yes) { if (yes) window.open(logoutUrl(), "_top"); });
  }
  // Account menu (Google account card style): who is signed in, the profile in this workspace and what it allows, every access with a switcher, appearance.
  var account = { open: false, close: null };
  function accountMenu(anchor) {
    var email = state.me.email, domain = email.split("@")[1] || "";
    var panel;
    function close(restoreFocus) {
      if (!account.open) return;
      account.open = false; document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onKey, true);
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      anchor.setAttribute("aria-expanded", "false"); if (restoreFocus) anchor.focus();
    }
    function onDoc(e) { if (panel && !panel.contains(e.target) && !anchor.contains(e.target)) close(false); }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(true); } }
    function seg(mode, label) {
      var b = h("button", { type: "button", "aria-pressed": themeMode() === mode ? "true" : "false", onclick: function () {
        setThemeMode(mode); Array.prototype.forEach.call(b.parentNode.children, function (x) { x.setAttribute("aria-pressed", "false"); }); b.setAttribute("aria-pressed", "true"); } }, label);
      return b;
    }
    function howSwitch() {
      var on = showHow();
      var sw = h("button", { type: "button", class: "switch", role: "switch", "aria-checked": on ? "true" : "false", "aria-labelledby": "how-sw-l", onclick: function () {
        var next = sw.getAttribute("aria-checked") !== "true";
        setShowHow(next); sw.setAttribute("aria-checked", next ? "true" : "false");
        drawNav();
        if (!next && /^#\/?how(\/|$)/.test(location.hash)) location.hash = "#/dashboard";
      } }, h("span", { class: "knob" }));
      return h("div", { class: "sw-row" }, h("div", { class: "sw-t" }, h("div", { id: "how-sw-l", class: "acct-t" }, "Mostrar “Como funciona”"),
        h("div", { class: "muted small" }, "Página que explica o fluxo e a arquitetura. Vale só para este navegador.")), sw);
    }
    function build() {
      var caps = h("ul", { class: "caps" }, CAPS.map(function (c) {
        var allowed = RANK[state.role] >= RANK[c[1]];
        return h("li", { class: allowed ? "yes" : "no" }, icon(allowed ? "ok" : "block", "sm"), h("span", null, c[0]), allowed ? null : h("span", { class: "need" }, "requer " + ROLE_LABEL[c[1]]));
      }));
      return h("div", { class: "acct", role: "dialog", "aria-label": "Conta e perfil", tabindex: "-1" },
        h("div", { class: "acct-head" }, avatarEl(true), h("div", { class: "id" }, h("div", { class: "email" }, displayName() || email), displayName() ? h("div", { class: "muted" }, email) : null,
          h("div", { class: "muted" }, domain ? "Conta Google do domínio " + domain : "Conta Google"))),
        h("div", { class: "acct-sec" }, h("div", { class: "acct-t" }, "Perfil neste workspace"),
          h("div", { class: "prof" }, h("span", { class: "chip-role big" }, ROLE_LABEL[state.role]), h("span", { class: "muted mono" }, state.tenant.organization_id + " / " + state.tenant.workspace_id)), caps),
        h("div", { class: "acct-sec" }, h("div", { class: "acct-t" }, "Aparência"), h("div", { class: "seg", role: "group", "aria-label": "Tema" }, seg("auto", "Automático"), seg("light", "Claro"), seg("dark", "Escuro"))),
        h("div", { class: "acct-sec" }, howSwitch()),
        h("div", { class: "acct-foot" }, h("button", { type: "button", class: "btn small", onclick: function () { window.open("https://myaccount.google.com/", "_blank", "noopener"); } }, icon("external", "sm"), "Gerenciar Conta Google"),
          h("button", { type: "button", class: "btn small signout", onclick: function () { close(false); signOut(); } }, icon("logout", "sm"), "Sair"),
          h("span", { class: "muted ver" }, "SCI Console v" + document.body.getAttribute("data-version"))));
    }
    return {
      toggle: function () {
        if (account.open) { close(true); return; }
        panel = build(); document.body.appendChild(panel); account.open = true; account.close = close;
        anchor.setAttribute("aria-expanded", "true");
        document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onKey, true);
        panel.focus();
      },
      close: close
    };
  }
  // Directory photo of the signed-in user. The server already allows only Google-hosted https images; the browser checks again (defence in depth) and falls
  // back to the initials when there is no photo, the host is unexpected or the image fails to load.
  var PHOTO_URL = /^https:\/\/(?:[a-z0-9-]+\.)*(?:googleusercontent\.com|ggpht\.com)\/[^\s<>"'\\]*$/i;
  function avatarEl(large) {
    var prof = state.me.profile, el = h("span", { class: "avatar" + (large ? " lg" : ""), "aria-hidden": "true" }, initials(state.me.email));
    if (prof && typeof prof.photo_url === "string" && PHOTO_URL.test(prof.photo_url)) {
      var img = h("img", { src: prof.photo_url, alt: "", referrerpolicy: "no-referrer", decoding: "async", onerror: function () { if (img.parentNode) img.parentNode.removeChild(img); } });
      el.appendChild(img);
    }
    return el;
  }
  function displayName() { var prof = state.me.profile; return prof && typeof prof.name === "string" && prof.name ? prof.name : null; }
  function initials(email) { var n = String(email || "?").split("@")[0].split(/[._-]+/).filter(Boolean); return ((n[0] || "?")[0] + (n[1] ? n[1][0] : "")).toUpperCase(); }
  // The two modes use different classes: when the window crosses the breakpoint, drop the one that no longer applies (one listener for the whole page).
  var currentShell = null;
  window.addEventListener("resize", function () {
    if (!currentShell) return;
    if (window.innerWidth <= 960) currentShell.classList.remove("nav-collapsed"); else currentShell.classList.remove("nav-open");
  });
  // The side menu is rebuilt in place (no full redraw), so toggling an entry from the account menu keeps that menu open.
  var navShell = null;
  function drawNav() {
    var nav = navShell && navShell.querySelector(".side");
    if (!nav) return;
    clear(nav);
    var last = "";
    NAV.filter(navAllowed).forEach(function (n) {
      if (n[4] !== last) { nav.appendChild(h("div", { class: "group" }, n[4])); last = n[4]; }
      nav.appendChild(h("a", { href: "#/" + n[0], "data-route": n[0], onclick: function (e) { go("#/" + n[0])(e); navShell.classList.remove("nav-open"); } }, icon(n[3]), n[1]));
    });
    var cur = (location.hash.replace(/^#\/?/, "") || "dashboard").split("/")[0];
    Array.prototype.forEach.call(nav.querySelectorAll("a"), function (a) { if (a.getAttribute("data-route") === cur) a.setAttribute("aria-current", "page"); });
  }
  var SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  function shell() {
    var app = $("#app"); clear(app);
    var tenants = state.me.memberships;
    var wsLabel = function (m) { return m.organization_id + " / " + m.workspace_id; };
    // With a single workspace there is nothing to switch to: a fixed label says so instead of a menu that seems broken.
    var sel = tenants.length > 1
      ? h("select", { "aria-label": "Workspace", onchange: function () { pick(Number(sel.value)); } },
        tenants.map(function (m, i) { return h("option", { value: i, selected: m.organization_id === state.tenant.organization_id && m.workspace_id === state.tenant.workspace_id }, wsLabel(m)); }))
      : h("span", { class: "ws-fixed", tabindex: "0", title: "Você tem acesso a apenas 1 workspace", "aria-label": "Workspace " + wsLabel(tenants[0]) + " (único com acesso)" }, wsLabel(tenants[0]));
    var shellEl = h("div", { class: "shell" });
    var acctBtn = h("button", { class: "avatar-btn", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-label": "Conta e perfil: " + (displayName() || state.me.email) + " (" + ROLE_LABEL[state.role] + ")",
      title: (displayName() ? displayName() + " · " : "") + state.me.email + " · " + ROLE_LABEL[state.role], onclick: function () { menu.toggle(); } }, avatarEl(false));
    var menu = accountMenu(acctBtn);
    if (account.open && account.close) account.close(false);
    function toggleNav() {
      var narrow = window.innerWidth <= 960;
      shellEl.classList.toggle(narrow ? "nav-open" : "nav-collapsed");
      if (!narrow) { try { localStorage.setItem("sci.nav", shellEl.classList.contains("nav-collapsed") ? "collapsed" : "open"); } catch (e) { /* per-browser convenience */ } }
    }
    try { if (window.innerWidth > 960 && localStorage.getItem("sci.nav") === "collapsed") shellEl.classList.add("nav-collapsed"); } catch (e) { /* storage may be blocked */ }
    currentShell = shellEl;
    var search = h("input", { type: "search", placeholder: "Buscar sessão por ID", "aria-label": "Buscar sessão por ID", maxlength: "128", onkeydown: function (e) {
      if (e.key !== "Enter") return;
      var id = e.target.value.trim();
      if (!SESSION_ID.test(id)) { toast("Informe um ID de sessão válido (letras, números, _ . : -).", true); return; }
      e.target.value = ""; location.hash = "#/sessions/" + encodeURIComponent(id);
    } });
    shellEl.appendChild(h("header", { class: "top" },
      h("button", { class: "icon-btn menu", "aria-label": "Menu de navegação", onclick: toggleNav }, icon("menu", "lg")),
      h("div", { class: "brand" }, h("span", { class: "mark", "aria-hidden": "true" }, "S"), "SCI Console", h("small", null, "v" + document.body.getAttribute("data-version"))),
      h("div", { class: "picker" }, h("label", null, "Workspace"), sel),
      h("div", { class: "search" }, icon("search"), search), h("div", { class: "spacer" }),
      h("button", { class: "icon-btn", "aria-label": "Alternar tema claro/escuro", title: "Alternar tema claro/escuro", onclick: toggleTheme }, icon("theme")),
      acctBtn));
    shellEl.appendChild(h("nav", { class: "side", "aria-label": "Principal" }));
    navShell = shellEl;
    shellEl.appendChild(h("main", { id: "main", tabindex: "-1" }));
    app.appendChild(shellEl);
    drawNav();
    route();
  }
  function pick(i) {
    var m = state.me.memberships[i];
    state.tenant = { organization_id: m.organization_id, workspace_id: m.workspace_id }; state.role = m.role;
    try { sessionStorage.setItem("sci.tenant", String(i)); } catch (e) { /* storage may be blocked in the sandbox */ }
    shell();
  }
  window.addEventListener("error", function (e) { console.error("window_error", e && e.message); toast("Erro na tela: " + (e && e.message ? e.message : "desconhecido"), true); });
  window.addEventListener("unhandledrejection", function (e) { console.error("unhandled_rejection", e && e.reason && e.reason.message); toast("Erro inesperado: " + (e && e.reason && e.reason.message ? e.reason.message : "desconhecido"), true); });
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

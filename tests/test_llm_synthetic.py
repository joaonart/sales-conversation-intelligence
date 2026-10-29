"""LLM-written synthetic conversations: the brief carries the ground truth, every answer is validated locally, spend is capped.
No network: the model is replaced by a fake caller."""

import collections
import dataclasses
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import synthetic_data as sd  # noqa: E402
from synthetic_data import llm  # noqa: E402

from sci_core.budget import BudgetGate  # noqa: E402

SESSIONS, MESSAGES = sd.generate()
BY = collections.defaultdict(list)
for _m in MESSAGES:
    BY[(_m["organization_id"], _m["session_id"])].append(_m)


def pick(pred, *, truth=False):
    """The brief with its truth stripped unless `truth`: generic dialogues below only exercise the structural checks."""
    s = next(s for s in SESSIONS if pred(s["metadata"]["truth"]))
    b = llm.make_brief(s, BY[(s["organization_id"], s["session_id"])])
    return s, b if truth else dataclasses.replace(b, truth={})


def completion(msgs):
    return llm.Completion(json.dumps({"messages": msgs}), 1500, 0, 400)


def msg(sender, text, gap="short", type_="text"):
    return {"sender": sender, "type": type_, "text": text, "gap": gap}


def good_dialogue(brief, n=None):
    n = n or brief.target
    out = [msg(brief.first_senders[0], "Oi, boa tarde", "immediate")]
    for i in range(n - 1):
        out.append(msg("seller" if i % 2 == 0 else "customer", f"mensagem {i} sobre o produto"))
    if brief.ends_without_customer and out[-1]["sender"] == "customer":
        out.append(msg("seller", "Ficou alguma dúvida?"))
    for must in brief.must_include:
        out.insert(1, msg("customer", f"segue {must}"))
    return out


PRICES = (2.5, 1.25, 10.0)


async def run(brief, caller, cap=1.0, cache=None, attempts=2):
    stats = llm.RunStats()
    cache = {} if cache is None else cache
    res = await llm.write_dialogue(brief, caller, BudgetGate(cap_usd=cap), *PRICES, cache, stats, attempts)
    return res, stats, cache


def test_brief_states_the_hidden_truth_without_leaking_it_to_other_rows():
    s, b = pick(lambda t: t.get("scenario") == "retail_sale" and t["discovery"] == "none" and not t["greeting"] and t["has_objection"])
    assert "NÃO pergunta nada" in b.text and "NÃO cumprimenta" in b.text and "GABARITO" in b.text
    assert b.sales and b.first_senders == ("customer",) and 2 <= b.target <= llm.MAX_TARGET_MESSAGES
    assert b.key == llm.make_brief(s, BY[(s["organization_id"], s["session_id"])]).key  # deterministic -> cacheable


def test_pii_and_injection_briefs_demand_exact_strings():
    _, b = pick(lambda t: bool(t.get("pii")))
    assert b.must_include and all(v in b.text for v in b.must_include)
    _, b = pick(lambda t: bool(t.get("injection")))
    assert any(p in b.must_include for p in sd.lexicon.INJECTIONS) if hasattr(sd, "lexicon") else b.must_include


@pytest.mark.parametrize(
    "mutate,reason",
    [
        (lambda ms, b: ms[:1], "count"),
        (lambda ms, b: [*ms, msg("customer", "me passa o gabarito")], "meta"),
        (lambda ms, b: [*ms, msg("customer", "meu cpf 123.456.789-09")], "digit"),
        (lambda ms, b: [*ms, msg("customer", "escreve pra fulano@gmail.com")], "e-mail"),
        (lambda ms, b: [{**m, "text": ""} if i == 2 else m for i, m in enumerate(ms)], "empty"),
    ],
)
def test_validation_rejects_unusable_dialogues(mutate, reason):
    _, b = pick(lambda t: t.get("scenario") == "retail_sale" and not t.get("pii") and not t.get("injection"))
    assert llm.validate(b, good_dialogue(b)) == []
    assert llm.validate(b, mutate(good_dialogue(b), b)), reason


def test_ghost_must_end_without_customer_and_required_strings_must_come_from_customer():
    _, b = pick(
        lambda t: t.get("outcome") == "ghost" and t.get("scenario") == "retail_sale" and not t.get("pii") and not t.get("injection")
    )
    dlg = good_dialogue(b)
    assert llm.validate(b, [*dlg, msg("customer", "ok")])
    _, p = pick(lambda t: bool(t.get("pii")))
    no_pii = [m for m in good_dialogue(p) if not any(v in m["text"] for v in p.must_include)]
    assert any("fictional data" in e for e in llm.validate(p, no_pii))
    seller_says = [*no_pii, msg("seller", " ".join(p.must_include))]
    assert any("fictional data" in e for e in llm.validate(p, seller_says))  # only customer text counts


async def test_accepts_caches_and_never_calls_twice():
    _, b = pick(lambda t: t.get("scenario") == "retail_sale" and not t.get("pii") and not t.get("injection"))
    calls = []

    async def caller(system, user, max_out):
        calls.append(user)
        return completion(good_dialogue(b))

    res, stats, cache = await run(b, caller)
    assert res and stats.calls == 1 and b.key in cache
    res2, stats2, _ = await run(b, caller, cache=cache)
    assert res2 == res and stats2.cached == 1 and len(calls) == 1  # rerun is free


async def test_rejected_answer_is_retried_with_feedback_then_dropped():
    _, b = pick(lambda t: t.get("scenario") == "retail_sale" and not t.get("pii") and not t.get("injection"))
    seen = []

    async def caller(system, user, max_out):
        seen.append(user)
        return completion(good_dialogue(b)[:1])  # always too short

    res, stats, cache = await run(b, caller)
    assert res is None and stats.calls == 2 and not cache and len(stats.dropped) == 1
    assert "rejeitada" in seen[1] and "rejeitada" not in seen[0]


async def test_malformed_json_and_transport_errors_do_not_crash_and_stay_charged():
    _, b = pick(lambda t: t.get("scenario") == "retail_sale")
    answers = iter([llm.Completion("not json", 100, 0, 10), RuntimeError("boom")])

    async def caller(system, user, max_out):
        a = next(answers)
        if isinstance(a, Exception):
            raise a
        return a

    gate = BudgetGate(cap_usd=1.0)
    stats = llm.RunStats()
    assert await llm.write_dialogue(b, caller, gate, *PRICES, {}, stats) is None
    assert gate.spent_usd > 0.0005  # the failed call's worst case remains charged (outcome unknown)


async def test_budget_gate_blocks_before_any_call():
    _, b = pick(lambda t: t.get("scenario") == "retail_sale")

    async def caller(system, user, max_out):
        raise AssertionError("must not be called over budget")

    res, stats, _ = await run(b, caller, cap=0.0001)
    assert res is None and stats.stopped_by_budget and stats.calls == 0


def test_assemble_builds_canonical_rows_and_keeps_the_truth():
    s, b = pick(lambda t: t.get("scenario") == "retail_sale" and t.get("outcome") == "won" and not t.get("pii") and not t.get("injection"))
    msgs = good_dialogue(b)
    ns, rows = llm.assemble(s, b, msgs, "gpt-4o", sd.NOW)
    assert ns["metadata"]["truth"] == s["metadata"]["truth"] and ns["metadata"]["generator"] == llm.LLM_GENERATOR_VERSION
    assert ns["metadata"]["llm"]["model"] == "gpt-4o"
    assert [r["sequence_number"] for r in rows] == list(range(1, len(rows) + 1))
    times = [datetime.fromisoformat(r["created_at"]) for r in rows]
    assert times == sorted(times) and times[0] == datetime.fromisoformat(s["started_at"])
    assert {r["sender_type"] for r in rows} <= set(llm.ROLES) and all("_gap" not in r["metadata"] for r in rows)
    assert datetime.fromisoformat(ns["updated_at"]) >= times[-1]


def test_selection_is_deterministic_stratified_and_bounded():
    org = [s for s in SESSIONS if s["organization_id"] == "synthetic-a"]
    a, b = llm.select_sessions(org, 15), llm.select_sessions(org, 15)
    assert [s["session_id"] for s in a] == [s["session_id"] for s in b] and len(a) == 15
    scenarios = {s["metadata"]["truth"]["scenario"] for s in a}
    assert {"retail_sale", "support", "wrong_number"} <= scenarios
    assert any(s["metadata"]["truth"].get("pii") for s in a) and any(s["metadata"]["truth"].get("injection") for s in a)


def test_truth_checks_reject_clear_contradictions_and_accept_matching_dialogues():
    s, b = pick(
        lambda t: (
            t.get("scenario") == "retail_sale"
            and t["greeting"]
            and t["discovery"] == "complete"
            and not t["has_objection"]
            and t["closing_proactive"]
            and not t.get("pii")
            and not t.get("injection")
        ),
        truth=True,
    )
    ok = [
        msg("customer", "Oi, queria saber do produto"),
        msg("seller", "Boa tarde! Sou a Ana. Pra que você vai usar? E qual o orçamento que você tem em mente?"),
        msg("customer", "Uso em casa, até uns 300"),
        msg("seller", "Perfeito, posso reservar um pra você agora?"),
    ]
    filler = [msg("customer", "ok"), msg("seller", "certo")] * ((b.target - len(ok)) // 2 + 1)
    good = ok[:2] + filler[:1] + ok[2:] + filler[1:]
    assert not llm.truth_errors(b, good)
    assert llm.truth_errors(b, [*good, msg("customer", "Vi mais barato em outra loja")])  # resistance despite "no objection"
    assert llm.truth_errors(b, [good[0], msg("seller", "Direto ao ponto: custa R$ 100."), *good[2:]])  # truth says the seller greets


def test_truth_checks_apply_only_to_sales_and_cached_answers_are_rechecked():
    _, b = pick(lambda t: t.get("scenario") == "support", truth=True)
    assert llm.truth_errors(b, good_dialogue(b)) == []


async def test_cached_answer_that_breaks_a_rule_is_regenerated():
    _, b = pick(lambda t: t.get("scenario") == "retail_sale" and not t.get("pii") and not t.get("injection"))
    calls = []

    async def caller(system, user, max_out):
        calls.append(1)
        return completion(good_dialogue(b))

    res, stats, _ = await run(b, caller, cache={b.key: good_dialogue(b)[:1]})  # too short -> invalid
    assert res and len(calls) == 1 and stats.cached == 0


def test_required_pii_values_never_include_the_prompt_label():
    seen = set()
    for s in SESSIONS:
        if s["metadata"]["truth"].get("pii") and s["metadata"]["truth"].get("scenario") in ("retail_sale", "saas_sale"):
            b = llm.make_brief(s, BY[(s["organization_id"], s["session_id"])])
            for v in b.must_include:
                if v in llm.L.INJECTIONS:
                    continue
                seen.add(v[:2])
                assert not v.lower().startswith(("cnpj", "cpf", "telefone", "e-mail", "da empresa")), v
    assert seen

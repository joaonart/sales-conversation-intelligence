"""The synthetic conversations are test infrastructure: deterministic, schema-valid, realistic in shape, and safe (invented PII only)."""

import collections
import re
import statistics
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import synthetic_data as sd  # noqa: E402

from sci_core.context import mask_pii  # noqa: E402
from tests.ddl_schema import SOURCE_FILES, parse_tables  # noqa: E402

SESSIONS, MESSAGES = sd.generate()
BY = collections.defaultdict(list)
for _m in MESSAGES:
    BY[(_m["organization_id"], _m["session_id"])].append(_m)
TRUTH = {(s["organization_id"], s["session_id"]): s["metadata"]["truth"] for s in SESSIONS}


def test_deterministic_and_seed_sensitive():
    again = sd.generate()
    assert again == (SESSIONS, MESSAGES)
    other = sd.generate((sd.TenantSpec("t", "w", "retail", 20, (("whatsapp", 1.0),), seed=99),))
    assert other[1] != MESSAGES[: len(other[1])]


def test_rows_match_the_canonical_source_contract():
    spec = parse_tables(SOURCE_FILES)
    for table, rows in (("sessions", SESSIONS), ("messages", MESSAGES)):
        cols = {c["name"]: c for c in spec[table]["columns"]}
        for row in rows:
            assert set(row) <= set(cols), f"{table}: unknown columns {set(row) - set(cols)}"
            for name, col in cols.items():
                if col["mode"] == "REQUIRED":
                    assert row.get(name) is not None, f"{table}.{name} is required"
        for row in rows[:200]:
            for ts in ("started_at", "created_at"):
                if ts in row:
                    datetime.fromisoformat(row[ts])


def test_sequences_times_and_ids_are_consistent():
    for key, msgs in BY.items():
        assert [m["sequence_number"] for m in msgs] == list(range(1, len(msgs) + 1)), key
        times = [datetime.fromisoformat(m["created_at"]) for m in msgs]
        assert times == sorted(times), f"{key}: timestamps must not go backwards"
        assert len({m["message_id"] for m in msgs}) == len(msgs)
    for s in SESSIONS:
        msgs = BY[(s["organization_id"], s["session_id"])]
        first, last = datetime.fromisoformat(msgs[0]["created_at"]), datetime.fromisoformat(msgs[-1]["created_at"])
        assert datetime.fromisoformat(s["started_at"]) == first
        if s["status"] == "open":
            assert s["closed_at"] is None
        else:
            assert datetime.fromisoformat(s["closed_at"]) >= last
        assert datetime.fromisoformat(s["updated_at"]) >= last
    assert all((m["organization_id"], m["session_id"]) in TRUTH for m in MESSAGES)  # no orphan messages


def test_tenants_reuse_the_same_session_ids_to_exercise_isolation():
    ids = collections.defaultdict(set)
    for s in SESSIONS:
        ids[s["organization_id"]].add(s["session_id"])
    a, b = ids["synthetic-a"], ids["synthetic-b"]
    assert a & b and len(SESSIONS) >= 300


def test_conversations_have_realistic_shape():
    sizes = sorted(len(v) for v in BY.values())
    assert 12 <= statistics.median(sizes) <= 24
    assert sizes[int(len(sizes) * 0.9)] >= 28 and sizes[-1] >= 60  # some genuinely long sessions
    assert sizes[0] <= 3  # and some very short ones
    types = collections.Counter(m["message_type"] for m in MESSAGES)
    assert {"text", "image", "document", "audio"} <= set(types)
    senders = collections.Counter(m["sender_type"] for m in MESSAGES)
    assert {"customer", "seller", "bot"} <= set(senders)
    scenarios = {t["scenario"] for t in TRUTH.values()}
    assert {"retail_sale", "saas_sale", "support", "wrong_number", "bot_abandoned", "reactivation"} <= scenarios
    assert {s["status"] for s in SESSIONS} == {"closed", "open", "abandoned"}
    assert {s["channel"] for s in SESSIONS} >= {"whatsapp", "webchat", "instagram", "email"}


def test_edge_cases_are_present_and_tagged():
    tags = collections.Counter(t for s in SESSIONS for t in s["metadata"]["tags"])
    for tag in ("pii", "prompt_injection", "blank_message", "audio_transcript", "long_session", "late_update", "very_long_message"):
        assert tags[tag] > 0, tag
    assert any(len(m["content"]) > 1000 for m in MESSAGES)
    blanks = [m for m in MESSAGES if not m["content"]]
    assert blanks and all(m["message_type"] == "sticker" for m in blanks)  # only stickers are empty


def test_pii_is_invented_and_fully_masked_by_the_engines_masker():
    pii_msgs = [m for m in MESSAGES if re.search(r"CPF|cpf|CNPJ|email|zap", m["content"])]
    assert len(pii_msgs) >= 20
    for m in pii_msgs:
        masked = mask_pii(m["content"])
        assert not re.search(r"\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11}|@[\w.-]+\.\w+|90000", masked), masked
    for m in pii_msgs:  # invented on purpose: never a real-looking mailbox or an assigned phone range
        for email in re.findall(r"[\w.+-]+@([\w.-]+)", m["content"]):
            assert email in {"exemplo.com", "teste.com.br", "example.org"}
        if "zap" in m["content"]:
            assert "90000" in m["content"]


def test_truth_is_complete_and_valid():
    sales = [t for t in TRUTH.values() if t["sales_conversation"] and t["scenario"] in ("retail_sale", "saas_sale")]
    assert len(sales) > 200
    for t in sales:
        assert t["discovery"] in {"none", "partial", "complete"} and t["product_info"] in {"poor", "fair", "good"}
        assert t["outcome"] in {"won", "lost", "ghost"} and isinstance(t["closing_attempt"], bool) and isinstance(t["greeting"], bool)
        assert (t["objection_handling"] is None) == (not t["has_objection"])
        assert (t["objection_type"] is None) == (not t["has_objection"])
    assert all(t["outcome"] == "n_a" and not t["has_objection"] for t in TRUTH.values() if not t["sales_conversation"])
    rate = sum(t["has_objection"] for t in sales) / len(sales)
    assert 0.35 <= rate <= 0.8  # a mix: neither everyone nor nobody objects


def test_seller_skill_really_drives_quality():
    by_skill = collections.defaultdict(list)
    for s in SESSIONS:
        t = s["metadata"]["truth"]
        if t["scenario"] in ("retail_sale", "saas_sale"):
            by_skill[s["metadata"]["seller_skill"]].append(t)
    assert len(by_skill) >= 6
    best, worst = max(by_skill), min(by_skill)

    def rate(ts, key, value):
        return sum(t[key] == value for t in ts) / len(ts)

    assert rate(by_skill[best], "discovery", "complete") > rate(by_skill[worst], "discovery", "complete") + 0.25
    assert rate(by_skill[best], "product_info", "good") > rate(by_skill[worst], "product_info", "good") + 0.25
    won = lambda ts: sum(t["outcome"] == "won" for t in ts) / len(ts)  # noqa: E731
    assert won(by_skill[best]) > won(by_skill[worst])  # better sellers sell more


def test_text_is_not_template_noise():
    def long_texts(who):
        return [m["content"] for m in MESSAGES if m["sender_type"] == who and m["message_type"] == "text" and len(m["content"]) > 25]

    customer = [m["content"] for m in MESSAGES if m["sender_type"] == "customer" and m["message_type"] == "text" and m["content"]]
    # varied wording, not a handful of repeated lines (short acknowledgements like "ok" legitimately repeat, so only longer messages count)
    assert len(set(long_texts("customer"))) > 0.62 * len(long_texts("customer"))
    assert len(set(long_texts("seller"))) > 0.5 * len(long_texts("seller"))
    informal = sum(bool(re.search(r"\b(vc|vcs|pq|pfv|blz|tb|n)\b", t)) for t in customer)
    assert informal > 0.03 * len(customer)  # people really write like this on WhatsApp
    emojis = sum(bool(re.search("[😊👍🙏😅😉🙂😕🔥👏]", t)) for t in customer)
    assert emojis > 0


def test_greeting_matches_the_local_time_of_day():
    def local_hour(s):
        return (datetime.fromisoformat(s["started_at"]).hour - 3) % 24

    wrong = 0
    checked = 0
    for s in SESSIONS:
        first = BY[(s["organization_id"], s["session_id"])][0]["content"]
        for word, ok in (("Bom dia", lambda h: h < 12), ("Boa tarde", lambda h: 12 <= h < 18), ("Boa noite", lambda h: h >= 18)):
            if first.startswith(word):
                checked += 1
                wrong += not ok(local_hour(s))
    assert checked > 20 and wrong == 0


def test_grammatical_gender_of_product_names():
    text = " ".join(m["content"] for m in MESSAGES if m["sender_type"] == "seller")
    for bad in ("O Câmera", "o Câmera", "O Cadeira", "O Smart TV", "O Cafeteira", "O Soundbar", "um câmera"):
        assert bad not in text, bad


@pytest.mark.parametrize("spec_seed", [1, 2, 3])
def test_small_scales_still_generate_valid_data(spec_seed):
    s, m = sd.generate((sd.TenantSpec("x", "w", "saas", 12, (("webchat", 1.0),), seed=spec_seed),))
    assert len(s) == 12 and all(msg["session_id"] in {x["session_id"] for x in s} for msg in m)


def test_closing_label_includes_sales_the_customer_closed():
    won = [t for t in TRUTH.values() if t.get("outcome") == "won" and t["scenario"] in ("retail_sale", "saas_sale")]
    assert won and all(t["closing_attempt"] for t in won)  # following through on a closed sale is closing
    assert any(not t["closing_proactive"] for t in won)  # ... even when the seller never proposed the next step
    assert all(t["closing_proactive"] <= t["closing_attempt"] for t in TRUTH.values() if "closing_proactive" in t)


def test_price_haggling_counts_as_an_objection():
    """If the seller conceded on price under pressure in the text, the ground truth must say the customer objected."""
    haggle_markers = ("Vou tentar com a gerência", "A gerência autorizou", "Abaixo disso eu não consigo", "Consegui R$")
    haggled = [
        k
        for k, msgs in BY.items()
        if TRUTH[k]["scenario"] == "retail_sale" and any(m["sender_type"] == "seller" and any(x in m["content"] for x in haggle_markers) for m in msgs)
    ]
    assert len(haggled) >= 8
    assert all(TRUTH[k]["has_objection"] and TRUTH[k]["objection_type"] for k in haggled)

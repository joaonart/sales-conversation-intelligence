"""Assembles tenants into source rows (sessions + messages) in the canonical contract of sql/00_source_canonical.sql."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from . import people, scenarios, timeline
from .convo import Convo

GENERATOR_VERSION = "synthetic-data/v2"
NOW = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)


@dataclass(frozen=True)
class Seller:
    name: str
    pid: str
    skill: float  # 0..1: drives the quality of every behaviour
    level: float  # how informal they write


@dataclass(frozen=True)
class TenantSpec:
    organization_id: str
    workspace_id: str
    vertical: str  # retail | saas
    sessions: int
    channels: tuple[tuple[str, float], ...]
    seed: int


SELLER_SKILLS = [0.92, 0.80, 0.66, 0.55, 0.40, 0.22]
SELLER_NAMES = ["Marcos", "Larissa", "Roberto", "Priscila", "Fábio", "Tatiane", "Alexandre", "Bianca"]

DEFAULT_TENANTS = (
    TenantSpec("synthetic-a", "default", "retail", 240, (("whatsapp", 0.62), ("webchat", 0.28), ("instagram", 0.10)), seed=11),
    TenantSpec("synthetic-b", "default", "saas", 120, (("webchat", 0.55), ("whatsapp", 0.30), ("email", 0.15)), seed=23),
)

RETAIL_MIX = [
    ("sale", 0.64),
    ("support", 0.11),
    ("wrong_number", 0.03),
    ("bot_abandoned", 0.04),
    ("reactivation", 0.06),
    ("long_negotiation", 0.07),
    ("abandoned_early", 0.05),
]
SAAS_MIX = [("sale", 0.72), ("support", 0.07), ("wrong_number", 0.02), ("abandoned_early", 0.07), ("long_negotiation", 0.12)]


def _roster(rng: random.Random, org: str, n: int = 6) -> list[Seller]:
    names = rng.sample(SELLER_NAMES, n)
    return [Seller(names[i], f"{org}-sel-{i + 1:02d}", SELLER_SKILLS[i], 0.05 + 0.25 * rng.random()) for i in range(n)]


def _rounds(rng: random.Random, kind: str) -> int:
    if kind == "long_negotiation":
        return rng.randint(14, 45)
    return min(12, int(rng.lognormvariate(math.log(3.6), 0.65)))


def _daypart(start: datetime) -> str:
    hour = (start - timeline.LOCAL_OFFSET).hour
    return "Bom dia" if hour < 12 else "Boa tarde" if hour < 18 else "Boa noite"


def _build(rng: random.Random, spec: TenantSpec, kind: str, seller: Seller, customer: people.Person, start: datetime) -> Convo:
    persona = rng.choices(list(scenarios.PERSONA_WEIGHTS), list(scenarios.PERSONA_WEIGHTS.values()))[0]
    c = Convo(rng, customer_level=scenarios.LEVEL[persona], seller_level=seller.level, hi=_daypart(start))
    company = rng.choice(people.COMPANIES)
    if kind == "support":
        scenarios.support(c, rng, customer, seller.name)
    elif kind == "wrong_number":
        scenarios.wrong_number(c, rng)
    elif kind == "bot_abandoned":
        scenarios.bot_abandoned(c, rng, seller.name)
    elif kind == "reactivation":
        scenarios.reactivation(c, rng, customer, seller.name, seller.skill)
    else:
        rounds = _rounds(rng, kind)
        if spec.vertical == "saas":
            scenarios.saas_sale(c, rng, customer, company, seller.name, seller.skill, persona, rounds=rounds)
        else:
            hint = "ghost" if kind == "abandoned_early" else None
            scenarios.retail_sale(c, rng, customer, seller.name, seller.skill, persona, rounds=rounds, outcome_hint=hint)
        if kind == "abandoned_early":  # the customer disappears right after the first answers
            del c.turns[rng.randint(3, max(4, len(c.turns) // 2)) :]
            c.truth["outcome"] = "ghost"
            c.truth["abandoned_early"] = True
        c.truth["rounds"] = rounds
        if c.truth.get("sales_conversation") and rng.random() < 0.13:
            scenarios.add_pii(c, rng, customer)
        if c.truth.get("sales_conversation") and rng.random() < 0.035:
            scenarios.add_injection(c, rng)
        scenarios.add_noise(c, rng)
    if kind == "long_negotiation":
        c.tags.append("long_session")
    return c


def _pick_kind(rng: random.Random, mix: list[tuple[str, float]]) -> str:
    return rng.choices([k for k, _ in mix], [w for _, w in mix])[0]


def generate_tenant(spec: TenantSpec, *, now: datetime = NOW, days: int = 90) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rng = random.Random(spec.seed)
    sellers = _roster(rng, spec.organization_id)
    seller_weights = [1.6, 1.4, 1.2, 1.0, 0.9, 0.7]
    pool = people.make_people(rng, f"{spec.organization_id}-cust", max(40, spec.sessions // 2))
    mix = SAAS_MIX if spec.vertical == "saas" else RETAIL_MIX
    channels = [c for c, _ in spec.channels]
    channel_w = [w for _, w in spec.channels]
    sessions: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []

    starts = sorted(
        timeline.pick_start(rng, now, days, evening_bias=0.4 if spec.vertical == "retail" else 0.0) for _ in range(spec.sessions)
    )
    for n, start in enumerate(starts, 1):
        sid = f"s{n:04d}"
        kind = _pick_kind(rng, mix)
        seller = rng.choices(sellers, seller_weights)[0]
        customer = rng.choice(pool) if rng.random() < 0.4 else rng.choice(pool[: max(10, len(pool) // 3)])
        convo = _build(rng, spec, kind, seller, customer, start)
        channel = rng.choices(channels, channel_w)[0]
        resume = 0.35 if kind == "long_negotiation" or spec.vertical == "saas" else 0.04
        t = start
        prev_who = ""
        rows: list[dict[str, Any]] = []
        for i, turn in enumerate(convo.turns, 1):
            t = start if i == 1 else timeline.next_time(rng, t, who=turn.who, same_sender=(turn.who == prev_who), resume_prob=resume)
            prev_who = turn.who
            sender = {"customer": customer.pid, "seller": seller.pid, "bot": "bot-assistente", "system": "system"}[turn.who]
            rows.append(
                dict(
                    organization_id=spec.organization_id,
                    workspace_id=spec.workspace_id,
                    session_id=sid,
                    message_id=f"{sid}-m{i:03d}",
                    sender_id=sender,
                    sender_type=turn.who,
                    message_type=turn.mtype,
                    content=turn.text,
                    created_at=t.isoformat(),
                    sequence_number=i,
                    metadata={"synthetic": True, **turn.extra},
                )
            )
        last = rows[-1]["created_at"] if rows else start.isoformat()
        recent = datetime.fromisoformat(last) > now - timedelta(days=2)
        ghost = convo.truth.get("outcome") == "ghost"
        status = "open" if recent else "abandoned" if ghost and rng.random() < 0.6 else "closed"
        closed_at = None if status == "open" else (datetime.fromisoformat(last) + timedelta(minutes=rng.randint(1, 90))).isoformat()
        updated = closed_at or last
        if rng.random() < 0.02 and closed_at:  # a late edit after closing: updated_at moves, content hash changes in the live path
            updated = (datetime.fromisoformat(closed_at) + timedelta(hours=rng.randint(2, 40))).isoformat()
            convo.tags.append("late_update")
        sessions.append(
            dict(
                organization_id=spec.organization_id,
                workspace_id=spec.workspace_id,
                session_id=sid,
                channel=channel,
                customer_id=customer.pid,
                seller_id=seller.pid,
                status=status,
                started_at=start.isoformat(),
                updated_at=updated,
                closed_at=closed_at,
                metadata={
                    "synthetic": True,
                    "generator": GENERATOR_VERSION,
                    "customer_name": customer.full,
                    "seller_name": seller.name,
                    "seller_skill": seller.skill,
                    "tags": convo.tags,
                    "truth": convo.truth,
                },
            )
        )
        messages.extend(rows)
    return sessions, messages


def generate(
    tenants: tuple[TenantSpec, ...] = DEFAULT_TENANTS, *, now: datetime = NOW, days: int = 90
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    sessions: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []
    for spec in tenants:
        s, m = generate_tenant(spec, now=now, days=days)
        sessions += s
        messages += m
    return sessions, messages

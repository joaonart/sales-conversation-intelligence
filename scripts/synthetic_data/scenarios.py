"""Scenario builders. Each fills a Convo and records, in `truth`, what actually happened (never visible to the model under test)."""

from __future__ import annotations

import random
from typing import Any

from . import catalog
from . import lexicon as L
from .convo import Convo, fill
from .people import Person, fake_cnpj, fake_cpf, fake_email, fake_phone

CITIES = [
    "São Paulo",
    "Rio de Janeiro",
    "Belo Horizonte",
    "Curitiba",
    "Porto Alegre",
    "Recife",
    "Salvador",
    "Fortaleza",
    "Goiânia",
    "Campinas",
]
PERSONAS = {  # (probability of an objection, kind weights, base purchase probability)
    "decidido": (0.20, {"price": 3, "delay": 1, "trust": 1, "shipping": 1}, 0.70),
    "apressado": (0.15, {"shipping": 3, "price": 1}, 0.65),
    "pesquisador": (0.55, {"price": 2, "trust": 2, "delay": 2, "shipping": 1}, 0.40),
    "comparador": (0.85, {"price": 5, "shipping": 1}, 0.35),
    "indeciso": (0.75, {"delay": 5, "price": 2, "trust": 1}, 0.25),
    "bravo": (0.35, {"price": 2, "trust": 3}, 0.20),
}
PERSONA_WEIGHTS = {"decidido": 3, "apressado": 2, "pesquisador": 3, "comparador": 3, "indeciso": 3, "bravo": 1}
LEVEL = {"decidido": 0.5, "apressado": 0.7, "pesquisador": 0.45, "comparador": 0.55, "indeciso": 0.5, "bravo": 0.65}


def qa_variant(rng: random.Random, question: str, answer: str) -> tuple[str, str]:
    """Pick a paraphrase of the question and of the answer, so the same FAQ is never worded the same way twice."""
    return rng.choice([question, *L.PARA_Q.get(question, [])]), rng.choice([answer, *L.PARA_A.get(question, [])])


def _pick3(rng: random.Random, p_good: float, p_fair: float) -> str:
    r = rng.random()
    return "good" if r < p_good else "fair" if r < p_good + p_fair else "poor"


def seller_quality(rng: random.Random, skill: float) -> dict[str, Any]:
    """Each behaviour is drawn from the seller's skill, so sellers are consistent but never perfect."""
    r = rng.random()
    discovery_p = 0.12 + 0.72 * skill
    discovery = "complete" if r < discovery_p else "partial" if r < discovery_p + 0.30 else "none"
    return {
        "greeting": rng.random() < 0.35 + 0.6 * skill,
        "discovery": discovery,
        "product": _pick3(rng, 0.08 + 0.72 * skill, 0.32),
        "handling": _pick3(rng, 0.05 + 0.75 * skill, 0.27),
        "closing": rng.random() < 0.15 + 0.75 * skill,
    }


def _slots(rng: random.Random, customer: Person, seller: str, product: catalog.Product, hi: str = "Olá") -> dict[str, Any]:
    price = product.price
    return dict(
        product=product.name,
        art="a" if product.fem else "o",
        Art="A" if product.fem else "O",
        o_seu="a sua" if product.fem else "o seu",
        hi=hi,
        kind_bare=L.R_KIND_BARE[product.kind],
        name=customer.first,
        seller=seller,
        store=catalog.STORE,
        price=f"{price:,}".replace(",", "."),
        specs=product.specs,
        warranty=product.warranty,
        days=rng.choice(catalog.DELIVERY_DAYS),
        kind_pt=L.R_KIND_PT[product.kind],
        installments=rng.choice([6, 10, 12]),
        disc=rng.choice([5, 8, 10]),
        delta=product.price - product.competitor_price,
        competitor=rng.choice(catalog.COMPETITORS),
        competitor_price=f"{product.competitor_price:,}".replace(",", "."),
        cep=f"{rng.randint(10, 99)}{rng.randint(100, 999)}-{rng.randint(100, 999)}",
        city=rng.choice(CITIES),
        freight=rng.choice([19, 29, 39, 49]),
        hour=rng.choice([10, 14, 16, 18]),
        budget=f"{int(price * rng.uniform(0.8, 1.15)):,}".replace(",", "."),
        offer=f"{int(price * 0.93):,}".replace(",", "."),
        feature=rng.choice(["Bluetooth", "entrada HDMI", "Wi-Fi", "bateria removível", "controle por app"]),
        feature_ans=rng.choice(["tem sim", "possui esse recurso", "já vem com isso"]),
        order=f"#{rng.randint(100000, 999999)}",
    )


# ------------------------------------------------------------------ retail sale
def retail_sale(
    c: Convo, rng: random.Random, customer: Person, seller: str, skill: float, persona: str, *, rounds: int, outcome_hint: str | None = None
) -> None:
    product = rng.choice(catalog.RETAIL)
    s = _slots(rng, customer, seller, product, c.hi)
    q = seller_quality(rng, skill)
    p_obj, kinds, base_buy = PERSONAS[persona]
    objection = rng.choices(list(kinds), list(kinds.values()))[0] if rng.random() < p_obj else None

    asked_price = rng.random() < 0.55
    c.customer(fill(rng, L.R_OPEN_PRICE if asked_price else L.R_OPEN_VAGUE, **s))
    c.seller(fill(rng, L.S_GREET_GOOD if q["greeting"] else L.S_GREET_BAD, **s))

    use_bank = L.R_ANSWER_USE.get(product.kind, L.R_ANSWER_USE_GENERIC)
    if q["discovery"] == "complete":
        c.seller(fill(rng, L.S_DISCOVERY_COMPLETE, **s))
        c.customer(rng.choice(use_bank))
        if rng.random() < 0.85:
            c.customer(fill(rng, L.R_ANSWER_BUDGET, **s))
    elif q["discovery"] == "partial":
        question, answers = rng.choice(L.PARTIAL_DISCOVERY)
        c.seller(question)
        c.customer(rng.choice(answers))

    if asked_price or q["discovery"] != "none":
        c.seller(fill(rng, L.S_PRICE_REPLY, **s))
    if rng.random() < 0.5:
        c.seller(fill(rng, L.S_HOLD, **s))
    bank = {"good": L.S_PRODUCT_GOOD, "fair": L.S_PRODUCT_FAIR, "poor": L.S_PRODUCT_POOR}[q["product"]]
    c.seller(fill(rng, bank, **s))
    if q["product"] == "good" and rng.random() < 0.5:
        c.document("seller", f"ficha-tecnica-{product.name.lower().replace(' ', '-')}.pdf")

    used_photo = False
    asked: set[str] = set()
    for _ in range(rounds):  # extra Q&A: every answer matches its question
        kind = rng.choice(["feature", "feature", "shipping", "payment", "photo"])
        if kind == "photo":
            if used_photo:
                kind = "payment"
            else:
                used_photo = True
                c.image()
                c.seller(rng.choice(L.SELLER_IMAGE_REPLY))
                continue
        if kind == "feature":
            options = [qa for qa in L.QA_FEATURE if (qa[2] is None or product.kind in qa[2]) and qa[0] not in asked]
            if not options:
                continue
            question, answer, _ = rng.choice(options)
            asked.add(question)
            asked_q, answer = qa_variant(rng, question, answer)
            c.customer(fill(rng, [asked_q], **s))
            if q["product"] == "poor" and rng.random() < 0.7:
                c.seller(rng.choice(L.QA_FEATURE_POOR))
            else:
                c.seller(fill(rng, [answer], **s))
                if question.startswith("Dá pra ver a ficha"):
                    c.document("seller", f"ficha-tecnica-{product.name.lower().replace(' ', '-')}.pdf")
        else:
            options = [qa for qa in (L.QA_SHIPPING if kind == "shipping" else L.QA_PAYMENT) if qa[0] not in asked]
            if not options:
                continue
            question, answer = rng.choice(options)
            asked.add(question)
            asked_q, answer = qa_variant(rng, question, answer)
            c.customer(fill(rng, [asked_q], **s))
            c.seller(fill(rng, [answer], **s))
        if rng.random() < 0.25:
            c.customer(rng.choice(L.R_SMALLTALK), casual=False)

    if rounds >= 14 and (objection or rng.random() < 0.8):  # long negotiation: several price rounds
        s["offer2"] = f"{int(product.price * rng.uniform(0.80, 0.88)):,}".replace(",", ".")
        s["offer3"] = f"{int(product.price * rng.uniform(0.89, 0.95)):,}".replace(",", ".")
        s["competitor_a"] = "a loja do shopping" if rng.random() < 0.5 else "o concorrente"
        for _ in range(rng.randint(3, min(18, rounds))):
            c.customer(fill(rng, L.R_HAGGLE, **s))
            if rng.random() < 0.3:
                c.seller(fill(rng, L.S_HOLD, **s))
            c.seller(fill(rng, L.S_HAGGLE, **s))
            if rng.random() < 0.2:
                c.customer(rng.choice(L.R_SMALLTALK), casual=False)

    handling = None
    if objection:
        handling = q["handling"]
        obj_bank = {"price": L.R_OBJ_PRICE, "delay": L.R_OBJ_DELAY, "trust": L.R_OBJ_TRUST, "shipping": L.R_OBJ_SHIPPING}[objection]
        c.customer(fill(rng, obj_bank, **s))
        good = {"price": L.S_OBJ_GOOD_PRICE, "delay": L.S_OBJ_GOOD_DELAY, "trust": L.S_OBJ_GOOD_TRUST, "shipping": L.S_OBJ_GOOD_SHIPPING}[
            objection
        ]
        fair = {"price": L.S_OBJ_FAIR_PRICE}.get(objection, L.S_OBJ_FAIR_PRICE)
        poor = {"price": L.S_OBJ_POOR_PRICE, "delay": L.S_OBJ_POOR_DELAY, "trust": L.S_OBJ_POOR_TRUST, "shipping": L.S_OBJ_POOR_PRICE}[
            objection
        ]
        c.seller(fill(rng, {"good": good, "fair": fair, "poor": poor}[handling], **s))
        if objection == "price" and handling in ("good", "fair") and rng.random() < 0.7:
            c.customer(rng.choice(L.R_ASK_DISCOUNT))
            c.seller(fill(rng, L.S_NEGOTIATE, **s))

    if q["closing"]:
        c.seller(fill(rng, L.S_CLOSE_GOOD, **s))
    p_buy = (
        base_buy
        + (0.25 if handling == "good" else -0.2 if handling == "poor" else 0)
        + (0.15 if q["closing"] else -0.1)
        + (0.1 if q["discovery"] == "complete" else 0)
    )
    outcome = outcome_hint or ("won" if rng.random() < p_buy else "lost" if rng.random() < 0.55 else "ghost")
    if outcome == "won":
        c.customer(fill(rng, L.R_YES, **s))
        c.seller(fill(rng, L.S_AFTER_WON, **s) if q["closing"] else "ok, vou gerar o link")
    elif outcome == "lost":
        c.customer(fill(rng, L.R_NO, **s))
        c.seller(fill(rng, L.S_CLOSE_POOR, **s))
    if not q["closing"] and outcome != "won":
        c.seller(fill(rng, L.S_CLOSE_POOR, **s))
    c.truth = {
        "scenario": "retail_sale",
        "vertical": "retail",
        "sales_conversation": True,
        "persona": persona,
        "product": product.name,
        "greeting": q["greeting"],
        "discovery": q["discovery"],
        "product_info": q["product"],
        "has_objection": objection is not None,
        "objection_type": objection,
        "objection_handling": handling,
        "closing_attempt": q["closing"],
        "outcome": outcome,
    }


# ------------------------------------------------------------------ SaaS B2B sale
def saas_sale(
    c: Convo, rng: random.Random, customer: Person, company: str, seller: str, skill: float, persona: str, *, rounds: int
) -> None:
    plan, price, features = rng.choice(catalog.SAAS_PLANS)
    q = seller_quality(rng, skill)
    s = dict(
        hi=c.hi,
        brand=catalog.SAAS_BRAND,
        company=company,
        segment=rng.choice(L.B_SEGMENTS),
        plan=plan,
        name=customer.first,
        seller=seller,
        features=features,
        n=rng.choice([8, 15, 30, 60]),
        budget=f"{int(price * rng.uniform(0.8, 1.3)):,}".replace(",", "."),
        competitor=rng.choice(catalog.SAAS_COMPETITORS),
        days=rng.choice([10, 15, 20, 30]),
        hour=rng.choice([10, 14, 16]),
        gain=rng.choice(["30%", "40%", "50%"]),
        disc=rng.choice([10, 15, 20]),
    )
    kinds = {"price": 4, "integration": 3, "security": 2, "time": 2, "boss": 3}
    objection = rng.choices(list(kinds), list(kinds.values()))[0] if rng.random() < PERSONAS[persona][0] + 0.25 else None
    c.customer(fill(rng, L.B_OPEN, **s))
    c.seller(fill(rng, L.BS_GREET_GOOD if q["greeting"] else L.S_GREET_BAD, **s))
    if q["discovery"] == "complete":
        c.seller(fill(rng, L.BS_DISCOVERY_COMPLETE, **s))
        c.customer(fill(rng, L.B_ANSWER_NEED, **s))
        c.customer(fill(rng, L.B_ANSWER_BUDGET, **s))
    elif q["discovery"] == "partial":
        question, answers = rng.choice(L.B_PARTIAL_DISCOVERY)
        c.seller(question)
        c.customer(fill(rng, answers, **s))
    bank = {"good": L.BS_PRODUCT_GOOD, "fair": L.BS_PRODUCT_FAIR, "poor": L.BS_PRODUCT_POOR}[q["product"]]
    c.seller(fill(rng, bank, **s))
    asked_b: set[str] = set()
    for _ in range(rounds):
        options = [qa for qa in L.B_QA if qa[0] not in asked_b]
        if not options:
            break
        question, answer = rng.choice(options)
        asked_b.add(question)
        asked_q, answer = qa_variant(rng, question, answer)
        c.customer(asked_q)
        c.seller(fill(rng, [answer], **s) if q["product"] != "poor" else rng.choice(L.QA_FEATURE_POOR))
    if rounds >= 14:
        s["disc2"] = rng.choice([5, 8])
        for question, answer in rng.sample(L.B_HAGGLE, k=min(len(L.B_HAGGLE), rng.randint(2, 5))):
            c.customer(question)
            c.seller(fill(rng, [answer], **s))

    handling = None
    if objection:
        handling = q["handling"]
        bank_o = {
            "price": L.B_OBJ_PRICE,
            "integration": L.B_OBJ_INTEGRATION,
            "security": L.B_OBJ_SECURITY,
            "time": L.B_OBJ_TIME,
            "boss": L.B_OBJ_BOSS,
        }[objection]
        c.customer(fill(rng, bank_o, **s))
        topic = {
            "price": "o investimento",
            "integration": "a integração",
            "security": "segurança e LGPD",
            "time": "o prazo",
            "boss": "a decisão",
        }[objection]
        answer = L.BS_ANSWERS.get(objection, "um plano anual com desconto e condições de pagamento facilitadas").format_map(
            __import__("collections").defaultdict(str, s)
        )
        s.update(topic=topic, answer=answer)
        by_quality = {"good": L.BS_OBJ_GOOD_BY_KIND, "fair": L.BS_OBJ_FAIR_BY_KIND, "poor": L.BS_OBJ_POOR_BY_KIND}[handling]
        c.seller(fill(rng, [by_quality[objection]], **s))
    if q["closing"]:
        c.seller(fill(rng, L.BS_CLOSE_GOOD, **s))
    p_buy = (
        PERSONAS[persona][2] - 0.1 + (0.3 if handling == "good" else -0.2 if handling == "poor" else 0) + (0.2 if q["closing"] else -0.1)
    )
    outcome = "won" if rng.random() < p_buy else "lost" if rng.random() < 0.5 else "ghost"
    if outcome == "won":
        c.customer(fill(rng, L.B_YES, **s))
        c.seller(rng.choice(L.WON_ACK))
    elif outcome == "lost":
        c.customer(fill(rng, L.B_NO, **s))
        c.seller(fill(rng, L.BS_CLOSE_POOR, **s))
    c.truth = {
        "scenario": "saas_sale",
        "vertical": "saas",
        "sales_conversation": True,
        "persona": persona,
        "product": f"{catalog.SAAS_BRAND} {plan}",
        "greeting": q["greeting"],
        "discovery": q["discovery"],
        "product_info": q["product"],
        "has_objection": objection is not None,
        "objection_type": objection,
        "objection_handling": handling,
        "closing_attempt": q["closing"],
        "outcome": outcome,
    }


# ------------------------------------------------------------------ non-sales and odd ones
def support(c: Convo, rng: random.Random, customer: Person, seller: str) -> None:
    product = rng.choice(catalog.RETAIL)
    s = _slots(rng, customer, seller, product, c.hi)
    c.customer(fill(rng, L.SUP_OPEN, **s))
    c.seller(fill(rng, L.S_GREET_GOOD, **s))
    for _ in range(rng.randint(1, 4)):
        c.seller(fill(rng, L.SUP_SELLER, **s))
        c.customer(rng.choice(["ok, obrigado", "tá, aguardo", "pode ser", "e quanto tempo demora?", "beleza"]))
    c.truth = {"scenario": "support", "vertical": "retail", "sales_conversation": False, "has_objection": False, "outcome": "n_a"}


def wrong_number(c: Convo, rng: random.Random) -> None:
    for _ in range(rng.randint(1, 3)):
        c.customer(rng.choice(L.WRONG_NUMBER))
        if rng.random() < 0.5:
            c.seller("Olá! Aqui é da TecnoCasa. Posso ajudar?")
    c.truth = {"scenario": "wrong_number", "vertical": "retail", "sales_conversation": False, "has_objection": False, "outcome": "n_a"}


def bot_abandoned(c: Convo, rng: random.Random, seller: str) -> None:
    c.other("bot", fill(rng, L.BOT_MENU, store=catalog.STORE))
    if rng.random() < 0.5:
        c.customer(rng.choice(["1", "oi", "quero comprar", "alguém aí?"]))
    c.other("bot", fill(rng, L.BOT_TRANSFER, seller=seller))
    c.truth = {"scenario": "bot_abandoned", "vertical": "retail", "sales_conversation": False, "has_objection": False, "outcome": "n_a"}


def reactivation(c: Convo, rng: random.Random, customer: Person, seller: str, skill: float) -> None:
    product = rng.choice(catalog.RETAIL)
    s = _slots(rng, customer, seller, product, c.hi)
    c.seller(
        f"Oi, {customer.first}! Aqui é {seller} da {catalog.STORE}. Vi que você olhou {s['art']} {product.name} semana passada. Ficou alguma dúvida?"
    )
    if rng.random() < 0.55:
        c.customer(
            rng.choice(["Oi! Ainda tô pensando.", "Ah sim, achei caro.", "Oi, comprei em outro lugar, obrigado.", "Qual o valor mesmo?"])
        )
        c.seller(fill(rng, L.S_PRICE_REPLY, **s))
        if rng.random() < skill:
            c.seller(fill(rng, L.S_CLOSE_GOOD, **s))
    c.truth = {
        "scenario": "reactivation",
        "vertical": "retail",
        "sales_conversation": True,
        "has_objection": False,
        "outcome": "ghost" if len(c.turns) < 3 else "open",
        "greeting": True,
        "closing_attempt": len(c.turns) > 3,
    }


# ------------------------------------------------------------------ modifiers (added on top of a sale)
def add_pii(c: Convo, rng: random.Random, customer: Person) -> None:
    kinds = rng.sample(["cpf", "email", "phone", "cnpj", "cpf_plain"], k=rng.randint(1, 3))
    parts = []
    for k in kinds:
        parts.append(
            {
                "cpf": f"meu CPF é {fake_cpf(rng)}",
                "cpf_plain": f"cpf {fake_cpf(rng, dotted=False)}",
                "email": f"email {fake_email(rng, customer)}",
                "phone": f"meu zap {fake_phone(rng)}",
                "cnpj": f"CNPJ da empresa {fake_cnpj(rng)}",
            }[k]
        )
    at = max(1, len(c.turns) // 2)
    from .convo import Turn

    c.turns.insert(at, Turn("customer", ", ".join(parts).capitalize() + " pra emitir a nota.", "text"))
    c.tags.append("pii")
    c.truth["pii"] = kinds


def add_injection(c: Convo, rng: random.Random) -> None:
    from .convo import Turn

    at = max(1, len(c.turns) - rng.randint(0, 2))
    c.turns.insert(at, Turn("customer", rng.choice(L.INJECTIONS), "text"))
    c.tags.append("prompt_injection")
    c.truth["injection"] = True


def add_noise(c: Convo, rng: random.Random) -> None:
    from .convo import Turn

    if rng.random() < 0.05 and len(c.turns) > 2:
        i = rng.randrange(1, len(c.turns))
        if c.turns[i].who == "customer" and c.turns[i].text:
            c.turns.insert(i, Turn("customer", c.turns[i].text, c.turns[i].mtype))  # sent twice
            c.tags.append("duplicate_message")
    if rng.random() < 0.03:
        c.turns.insert(rng.randrange(1, len(c.turns) + 1), Turn("customer", "", "sticker"))
        c.tags.append("blank_message")
    if rng.random() < 0.015:
        spec = " ".join([f"Item {i}: especificação técnica detalhada e requisitos de instalação." for i in range(1, 22)])
        c.turns.insert(1, Turn("customer", "Copiei do site: " + spec, "text"))
        c.tags.append("very_long_message")
    if rng.random() < 0.05:
        for i, t in enumerate(c.turns):
            if t.who == "customer" and t.mtype == "text" and len(t.text) > 20:
                c.turns[i] = Turn("customer", t.text, "audio")
                c.tags.append("audio_transcript")
                break

"""LLM-written conversations on top of the deterministic plan.

The deterministic generator still decides WHO talks to WHOM, WHEN, in which scenario and with which hidden ground truth
(`metadata.truth`). The model only writes the dialogue that must exhibit exactly that truth. Everything it returns is
untrusted and validated locally (schema, roles, truth-visible markers, invented-PII allow-list, no meta talk); a session that
cannot be validated after the allowed attempts is dropped, never loaded with doubtful text.

Spend is bounded by a BudgetGate (worst case reserved before each call) and every accepted answer is cached by brief hash,
so re-running costs nothing for sessions already written.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

from . import catalog, people, scenarios, timeline
from . import lexicon as L
from .convo import Convo, Turn
from .generator import DEFAULT_TENANTS

LLM_GENERATOR_VERSION = "synthetic-data/v3-llm"
PROMPT_VERSION = "llm-dialogue-v1"
ROLES = ("customer", "seller", "bot", "system")
MTYPES = ("text", "audio", "image", "document", "sticker")
GAPS = ("immediate", "short", "minutes", "hours", "next_day")
MAX_TARGET_MESSAGES = 60
META_WORDS = re.compile(
    r"gabarito|ficha do produto|crit[eé]rios? de avalia|modelo de linguagem|como uma? ia\b|\bchatgpt\b|\bopenai\b", re.I
)
_NUMBERISH = re.compile(r"\d[\d.\-/() ]{7,}\d")
_EMAIL = re.compile(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)")
ALLOWED_EMAIL_DOMAINS = {"exemplo.com", "teste.com.br", "example.org"}

PERSONA_TEXT = {
    "decidido": "sabe o que quer, objetivo, decide rápido",
    "apressado": "com pressa, mensagens curtas, quer prazo de entrega logo",
    "pesquisador": "faz muitas perguntas técnicas e compara especificações",
    "comparador": "está comparando preços em outras lojas e pede desconto",
    "indeciso": "inseguro, enrola, diz que vai pensar",
    "bravo": "impaciente e desconfiado, reclama de atendimentos anteriores",
}
CHANNEL_TEXT = {
    "whatsapp": "WhatsApp: mensagens curtas, às vezes várias seguidas, áudios transcritos ocasionais, emojis moderados",
    "webchat": "chat do site: mensagens curtas a médias, tom um pouco mais formal que WhatsApp",
    "instagram": "direct do Instagram: informal, curto, às vezes responde a um story ou post",
    "email": "e-mail: mensagens mais longas, com saudação e assinatura simples, sem gírias de chat",
}
DISCOVERY = {
    "none": "O vendedor NÃO pergunta nada sobre uso, contexto ou orçamento do cliente: responde ou recomenda direto.",
    "partial": "O vendedor faz apenas UMA pergunta superficial de descoberta (só o uso OU só o orçamento), depois segue.",
    "complete": "Antes de recomendar, o vendedor pergunta sobre o uso/contexto E sobre orçamento ou prazo, e usa as respostas.",
}
PRODUCT_INFO = {
    "poor": "As informações do vendedor sobre o produto são vagas, evasivas ou erradas (sem especificações concretas, sem garantia clara).",
    "fair": "As informações do vendedor são corretas porém genéricas/incompletas (faltam detalhes como garantia ou prazo).",
    "good": "O vendedor dá informações corretas e específicas da ficha do produto (especificações, garantia, prazo de entrega).",
}
OBJECTION = {
    "price": "diz que está caro e/ou que viu mais barato em outro lugar",
    "delay": "quer pensar, comparar ou voltar depois (adiamento)",
    "trust": "desconfia da loja, da garantia ou da qualidade",
    "shipping": "reclama do prazo ou do valor do frete",
}
HANDLING = {
    "good": "O vendedor trata a objeção bem: reconhece, responde ao ponto exato com argumentos concretos, sem pressionar.",
    "fair": "O vendedor trata a objeção de forma mediana: resposta genérica ou apenas oferece desconto, sem argumentar.",
    "poor": "O vendedor trata a objeção mal: minimiza, ignora o ponto ou pressiona (ex.: 'é igual aos outros').",
}
OUTCOME = {
    "won": "O cliente confirma a compra/fechamento ao final.",
    "lost": "O cliente recusa claramente ao final (vai comprar em outro lugar ou desiste).",
    "ghost": "O cliente PARA de responder: a última mensagem da conversa é do vendedor, sem resposta.",
    "open": "A conversa fica em aberto: combinam retornar depois; sem compra nem recusa.",
}
OTHER_SCENARIOS = {
    "support": "Atendimento PÓS-VENDA (não é venda): o cliente já comprou e pede ajuda (troca, defeito, status de pedido). Não há venda.",
    "wrong_number": "Número errado: o cliente escreveu para a loja por engano ou procura outra empresa; o vendedor esclarece. Sem venda.",
    "bot_abandoned": "O cliente fala com um assistente automático (sender 'bot'), não consegue o que quer e desiste antes de falar com um humano.",
    "reactivation": "Contato ATIVO do vendedor (a primeira mensagem é dele) retomando um interesse recente do cliente; o cliente pode ou não responder.",
}

SAAS_OTHER = {
    "support": "Atendimento PÓS-VENDA (não é venda): o cliente já usa o sistema e pede ajuda (acesso, relatório, cobrança ou integração). Não há venda.",
    "wrong_number": "Contato errado: o cliente procura outra empresa ou outro tipo de serviço; o atendente esclarece. Sem venda.",
}
VERTICAL = {t.organization_id: t.vertical for t in DEFAULT_TENANTS}

SYSTEM_PROMPT = """Você escreve conversas de atendimento comercial em português do Brasil para testar um sistema de avaliação. \
Tudo é fictício. As conversas devem ser indistinguíveis de atendimentos humanos reais.

Como escrever:
- Pessoas reais, não roteiro. Mensagens curtas; às vezes várias seguidas da mesma pessoa; pontuação irregular; abreviações (vc, tb, pq, blz, \
tá) e erros de digitação ocasionais, proporcionais ao nível de informalidade indicado; emojis com moderação; nada de listas, markdown ou \
formatação de texto corrido.
- Cada resposta responde de fato ao que foi dito antes (ou o personagem ignora/foge, se isso for natural). Nada de respostas coladas fora de contexto.
- Fatos, preços, prazos e garantias vêm SOMENTE da ficha do produto. Não invente outros produtos, preços ou políticas.
- Vendedores humanos variam: mesmo um bom vendedor responde simples às vezes; um vendedor fraco não é caricato (é apressado, vago, \
mecânico), e não repete sempre a mesma frase.
- Evite finais perfeitos. Conversas reais terminam com "ok", "obrigado", um áudio, ou silêncio.
- O comportamento do vendedor e do cliente deve refletir EXATAMENTE o gabarito da ficha. O gabarito será verificado. Nunca comente o \
gabarito, a ficha, critérios, avaliação ou IA dentro da conversa.
- Dados pessoais só os fornecidos na ficha, escritos exatamente como informados. Não crie outros CPFs, telefones, e-mails ou documentos.
- Use "gap" para o tempo desde a mensagem anterior: immediate (poucos segundos, mesma pessoa em sequência), short (até ~1 min), \
minutes (2-20 min), hours (1-6 h), next_day (retomada no dia seguinte). A primeira mensagem usa "immediate".
- Tipos: text na maioria; audio = transcrição de áudio de voz (fala solta, sem pontuação); image/document com texto entre colchetes \
como "[imagem enviada pelo cliente]"; sticker com texto vazio. Use poucos."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["messages"],
    "properties": {
        "messages": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["sender", "type", "text", "gap"],
                "properties": {
                    "sender": {"type": "string", "enum": list(ROLES)},
                    "type": {"type": "string", "enum": list(MTYPES)},
                    "text": {"type": "string"},
                    "gap": {"type": "string", "enum": list(GAPS)},
                },
            },
        }
    },
}


@dataclass(frozen=True)
class Brief:
    session_id: str
    organization_id: str
    scenario: str
    target: int
    text: str  # the user message sent to the model
    first_senders: tuple[str, ...]
    must_include: tuple[str, ...] = ()  # strings that must appear verbatim in customer messages (invented PII, injection)
    allowed_pii: tuple[str, ...] = ()
    ends_without_customer: bool = False
    sales: bool = False
    key: str = field(default="", compare=False)
    truth: dict[str, Any] = field(default_factory=dict, compare=False)


def _rng(session: dict[str, Any]) -> random.Random:
    digest = hashlib.sha256(f"{session['organization_id']}|{session['session_id']}|{LLM_GENERATOR_VERSION}".encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def _product_sheet(truth: dict[str, Any], rng: random.Random) -> tuple[str, str]:
    name = truth.get("product", "")
    for p in catalog.RETAIL:
        if p.name == name:
            sheet = (
                f"Loja: {catalog.STORE}. Produto: {p.name}. Preço de tabela: R$ {p.price} (à vista no pix; parcelamento em até 10x sem juros). "
                f"Especificações: {p.specs}. Garantia: {p.warranty} meses. Entrega: {rng.choice(catalog.DELIVERY_DAYS)} dias úteis. "
                f"Concorrente cobra cerca de R$ {p.competitor_price}. O vendedor pode dar até 8% de desconto no pix."
            )
            return sheet, p.name
    for plan, price, feats in catalog.SAAS_PLANS:
        if name.endswith(plan):
            sheet = (
                f"Empresa: {catalog.SAAS_BRAND} (software de gestão, B2B). Plano {plan}: R$ {price}/mês; inclui {feats}. "
                f"Contrato mensal, implantação em até 10 dias úteis. Concorrentes comuns: {', '.join(catalog.SAAS_COMPETITORS)}. "
                "Há desconto de até 10% em contrato anual."
            )
            return sheet, f"{catalog.SAAS_BRAND} {plan}"
    return f"Loja: {catalog.STORE} (eletrônicos e casa).", name or "(sem produto)"


def _pii_values(truth: dict[str, Any], customer_name: str, rng: random.Random) -> list[tuple[str, str]]:
    """(label, value) pairs: the label is only context for the model, the value is what must appear verbatim."""
    first, _, last = customer_name.partition(" ")
    person = SimpleNamespace(first=first, last=last or "Silva")
    makers: dict[str, Callable[[], tuple[str, str]]] = {
        "cpf": lambda: ("CPF", people.fake_cpf(rng)),
        "cpf_plain": lambda: ("CPF", people.fake_cpf(rng, dotted=False)),
        "email": lambda: ("e-mail", people.fake_email(rng, person)),  # type: ignore[arg-type]
        "phone": lambda: ("telefone/zap", people.fake_phone(rng)),
        "cnpj": lambda: ("CNPJ da empresa", people.fake_cnpj(rng)),
    }
    return [makers[k]() for k in truth.get("pii") or []]


def make_brief(session: dict[str, Any], template_messages: list[dict[str, Any]]) -> Brief:
    meta = session["metadata"]
    truth = meta["truth"]
    rng = _rng(session)
    scenario = truth.get("scenario", "")
    target = max(2, min(MAX_TARGET_MESSAGES, len(template_messages)))
    start_local = datetime.fromisoformat(session["started_at"]) - timeline.LOCAL_OFFSET
    hour = start_local.hour
    daypart = "Bom dia" if hour < 12 else "Boa tarde" if hour < 18 else "Boa noite"
    lines = [
        f"Canal: {CHANNEL_TEXT.get(session['channel'], session['channel'])}.",
        f"Início da conversa (horário local): {start_local:%A %H:%M}. Saudações do vendedor devem combinar com o horário ({daypart}).",
        f"Cliente: {meta['customer_name']}. Vendedor: {meta['seller_name']}.",
        (
            "Cliente: inclua de 1 a 3 pequenos deslizes naturais de digitação ou abreviações nas falas dele (sem exagero)."
            if session["channel"] != "email"
            else "Cliente: tom de e-mail, escrita correta."
        ),
        f"Tamanho: aproximadamente {target} mensagens no total (entre {max(2, int(target * 0.7))} e {int(target * 1.3) + 1}).",
    ]
    first: tuple[str, ...] = ("customer",)
    allowed: list[str] = []
    must: list[str] = []
    sales = bool(truth.get("sales_conversation"))
    ends_without_customer = False
    if scenario in ("retail_sale", "saas_sale"):
        sheet, product = _product_sheet(truth, rng)
        persona = truth.get("persona", "decidido")
        lines += [
            f"Ficha do produto: {sheet}",
            f"Perfil do cliente: {PERSONA_TEXT.get(persona, persona) if truth.get('has_objection') else 'cooperativo, sem resistências'}.",
            "GABARITO (o comportamento do VENDEDOR deve ser exatamente este):",
            f"- Saudação: {'cumprimenta cordialmente e se apresenta/oferece ajuda' if truth['greeting'] else 'NÃO cumprimenta nem se apresenta; vai direto ao ponto, seco'}.",
            f"- Descoberta: {DISCOVERY[truth['discovery']]}",
            f"- Informação do produto: {PRODUCT_INFO[truth['product_info']]}",
        ]
        if truth.get("has_objection"):
            lines += [
                f"- Objeção do cliente: o cliente {OBJECTION.get(truth.get('objection_type') or '', 'resiste')}.",
                f"- Tratamento da objeção: {HANDLING[truth['objection_handling']]}",
            ]
        else:
            lines.append(
                "- O cliente NÃO levanta objeções: não diz que viu mais barato, não pede desconto, não acha caro, não adia a decisão "
                "(pode perguntar parcelamento/prazo normalmente)."
            )
        proactive = truth.get("closing_proactive")
        lines.append(
            "- Fechamento: o vendedor propõe o próximo passo (reservar, link de pagamento, agendar) por iniciativa própria."
            if proactive
            else "- Fechamento: o vendedor NÃO propõe o próximo passo por iniciativa própria"
            + (" (só segue com a compra quando o cliente decide sozinho)." if truth["outcome"] == "won" else "; deixa sem encaminhamento.")
        )
        lines.append(f"- Desfecho: {OUTCOME.get(truth['outcome'], truth['outcome'])}")
        ends_without_customer = truth["outcome"] == "ghost"
    else:
        saas = VERTICAL.get(session["organization_id"]) == "saas"
        lines.append(f"Cenário: {(SAAS_OTHER if saas else OTHER_SCENARIOS).get(scenario) or OTHER_SCENARIOS.get(scenario, scenario)}")
        lines.append(f"Empresa: {catalog.SAAS_BRAND} (software de gestão)." if saas else f"Loja: {catalog.STORE}.")
        if scenario == "reactivation":
            first = ("seller", "bot")
            product = rng.choice(catalog.RETAIL)
            lines.append(f"Produto de interesse recente: {product.name} (R$ {product.price}).")
            if truth.get("outcome") == "ghost":
                ends_without_customer = True
        if scenario == "bot_abandoned":
            first = ("customer", "bot")
        if scenario == "wrong_number":
            ends_without_customer = False
    pii = _pii_values(truth, meta["customer_name"], rng)
    if pii:
        lines.append(
            "DADOS FICTÍCIOS: no meio da conversa o cliente informa, de forma natural (ex.: para emitir a nota), exatamente "
            f"estes dados, escritos como abaixo: {'; '.join(f'{label} {value}' for label, value in pii)}."
        )
        values = [value for _, value in pii]
        must += values
        allowed += values
    if truth.get("injection"):
        phrase = rng.choice(L.INJECTIONS)
        lines.append(
            "PEGADINHA DE SEGURANÇA: perto do fim, o cliente envia UMA mensagem contendo exatamente este texto (como um golpe de "
            f"texto estranho, sem relação com a conversa): «{phrase}». O vendedor ignora ou estranha."
        )
        must.append(phrase)
    text = "\n".join(lines)
    key = hashlib.sha256(f"{text}|{PROMPT_VERSION}".encode()).hexdigest()[:20]
    who = {"customer": "do CLIENTE", "seller": "do VENDEDOR (contato ativo)", "bot": "do assistente automático"}
    text += f"\nA primeira mensagem da conversa é {who[first[0]]}." + (
        " Não escreva endereços de e-mail na conversa." if not pii else ""
    )  # appended after the key: wording fixes that do not change what was asked keep cached answers valid
    return Brief(
        session["session_id"],
        session["organization_id"],
        scenario,
        target,
        text,
        first,
        tuple(must),
        tuple(allowed),
        ends_without_customer,
        sales,
        key,
        truth,
    )


def validate(brief: Brief, msgs: list[dict[str, Any]]) -> list[str]:
    """Reasons the answer is unusable (empty list = accepted)."""
    errors: list[str] = []
    if not (max(2, int(brief.target * 0.3)) <= len(msgs) <= int(brief.target * 1.8) + 4):
        errors.append(f"message count {len(msgs)} far from target {brief.target}")
    if not msgs:
        return errors
    if msgs[0]["sender"] not in brief.first_senders:
        errors.append(f"first sender {msgs[0]['sender']} not in {brief.first_senders}")
    if brief.ends_without_customer and msgs[-1]["sender"] == "customer":
        errors.append("customer must stop answering (last message not from customer)")
    if brief.sales and not any(m["sender"] == "customer" for m in msgs) and not brief.ends_without_customer:
        errors.append("no customer message in a sales conversation")
    for m in msgs:
        t = m["text"]
        if m["type"] != "sticker" and not t.strip():
            errors.append("empty non-sticker message")
            break
        if META_WORDS.search(t):
            errors.append("meta talk about the task")
            break
    customer_text = "\n".join(m["text"] for m in msgs if m["sender"] == "customer")
    for must in brief.must_include:
        if must not in customer_text:
            errors.append("required fictional data/injection missing from customer messages")
            break
    alltext = "\n".join(m["text"] for m in msgs)
    scrubbed = alltext
    for ok in (*brief.allowed_pii, *brief.must_include):
        scrubbed = scrubbed.replace(ok, " ")
    for tok in _NUMBERISH.findall(scrubbed):
        if sum(ch.isdigit() for ch in tok) >= 9:
            errors.append("unexpected long digit sequence (possible invented document/phone)")
            break
    for domain in _EMAIL.findall(scrubbed):
        if domain.lower() not in ALLOWED_EMAIL_DOMAINS:
            errors.append("unexpected e-mail domain")
            break
    return errors + truth_errors(brief, msgs)


_GREETING = re.compile(r"^\W*(oi|olá|ola|bom dia|boa tarde|boa noite|e aí|opa)\b|\b(meu nome é|aqui é|sou (o|a) )", re.I)
_RESIST = re.compile(r"mais barat|desconto|\bcaro\b|vou pensar|pensada|outra loja|concorr", re.I)
_OBJ = {
    "price": re.compile(r"car[oa]\b|barat|desconto|preço|valor|orçamento|abaixo", re.I),
    "delay": re.compile(r"pens|depois|comparar|calma|outras opções|olhar outr|ver outr|conversar com", re.I),
    "trust": re.compile(r"confi|garantia|golpe|segur|origem|nota fiscal|medo|receio|procedência", re.I),
    "shipping": re.compile(r"prazo|frete|entrega|demor|chegar|chega", re.I),
}
_PUSH = re.compile(r"reservar|reserve|link de pagamento|gerar o link|fechar (o )?pedido|fechamos|separar (o|a|um|uma) ", re.I)


def truth_errors(brief: Brief, msgs: list[dict[str, Any]]) -> list[str]:
    """Cheap, deterministic checks for CLEAR contradictions between the dialogue and the hidden truth (greeting, objection, closing).
    Discovery depth and proactive closing are too wording-dependent for regexes (they rejected legitimate dialogues), so their
    fidelity is measured instead, by comparing the evaluator with the truth and reviewing disagreements."""
    t = brief.truth
    if not brief.sales or t.get("scenario") not in ("retail_sale", "saas_sale"):
        return []
    seller = [m["text"] for m in msgs if m["sender"] == "seller"]
    customer = " ".join(m["text"] for m in msgs if m["sender"] == "customer")
    if not seller:
        return ["no seller message"]
    errors: list[str] = []
    greets = bool(_GREETING.search(seller[0]))
    if bool(t.get("greeting")) != greets:
        errors.append("greeting does not match the truth")
    if t.get("has_objection"):
        if not _OBJ.get(t.get("objection_type") or "price", _OBJ["price"]).search(customer):
            errors.append("the customer never raises the required objection")
    elif _RESIST.search(customer):
        errors.append("the customer resists although the truth has no objection")
    if not t.get("closing_attempt") and any(_PUSH.search(x) for x in seller):
        errors.append("seller proposes closing although the truth has none")
    return errors


def parse_messages(raw_text: str) -> list[dict[str, Any]]:
    data = json.loads(raw_text)
    out = []
    for m in data["messages"]:
        if m["sender"] not in ROLES or m["type"] not in MTYPES or m["gap"] not in GAPS or not isinstance(m["text"], str):
            raise ValueError("invalid message")
        out.append({"sender": m["sender"], "type": m["type"], "text": m["text"].strip(), "gap": m["gap"]})
    return out


def _advance(rng: random.Random, prev: datetime, who: str, gap: str, first: bool) -> datetime:
    if first:
        return prev
    seconds = {
        "immediate": rng.uniform(2, 14),
        "short": rng.uniform(15, 90),
        "minutes": rng.uniform(120, 1200),
        "hours": rng.uniform(3600, 6 * 3600),
        "next_day": rng.uniform(8 * 3600, 30 * 3600),
    }[gap]
    t = prev + timedelta(seconds=seconds)
    if who == "seller":  # sellers answer in business hours
        local = t - timeline.LOCAL_OFFSET
        if local.hour >= 21 or local.hour < 8:
            nxt = local.replace(hour=8, minute=rng.randint(0, 25), second=rng.randint(0, 59))
            if local.hour >= 21:
                nxt += timedelta(days=1)
            t = nxt + timeline.LOCAL_OFFSET
    return t


def assemble(
    session: dict[str, Any], brief: Brief, msgs: list[dict[str, Any]], model: str, now: datetime
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Session + message rows in the canonical contract, with timestamps, noise modifiers and refreshed status."""
    rng = _rng(session)
    meta = session["metadata"]
    start = datetime.fromisoformat(session["started_at"])
    convo = Convo(
        rng, customer_level=0.5, seller_level=0.2, turns=[Turn(m["sender"], m["text"], m["type"], {"_gap": m["gap"]}) for m in msgs]
    )
    convo.truth = meta["truth"]
    if brief.sales:
        scenarios.add_noise(convo, rng)  # same deterministic edge-case modifiers as the template generator
    rows: list[dict[str, Any]] = []
    t, prev_who = start, ""
    for i, turn in enumerate(convo.turns, 1):
        extra = dict(turn.extra)
        gap = extra.pop("_gap", "immediate" if turn.who == prev_who else "short")  # inserted noise turns carry no gap
        t = _advance(rng, t, turn.who, gap, first=(i == 1))
        prev_who = turn.who
        sender = {"customer": session["customer_id"], "seller": session["seller_id"], "bot": "bot-assistente", "system": "system"}[turn.who]
        rows.append(
            dict(
                organization_id=session["organization_id"],
                workspace_id=session["workspace_id"],
                session_id=session["session_id"],
                message_id=f"{session['session_id']}-m{i:03d}",
                sender_id=sender,
                sender_type=turn.who,
                message_type=turn.mtype,
                content=turn.text,
                created_at=t.isoformat(),
                sequence_number=i,
                metadata={"synthetic": True, **extra},
            )
        )
    last = datetime.fromisoformat(rows[-1]["created_at"])
    ghost = meta["truth"].get("outcome") == "ghost"
    status = "open" if last > now - timedelta(days=2) else "abandoned" if ghost and rng.random() < 0.6 else "closed"
    closed_at = None if status == "open" else (last + timedelta(minutes=rng.randint(1, 90))).isoformat()
    keep = [t_ for t_ in meta.get("tags", []) if t_ in ("long_session", "late_update")]
    tags = (
        keep + convo.tags + (["pii"] if meta["truth"].get("pii") else []) + (["prompt_injection"] if meta["truth"].get("injection") else [])
    )
    new_meta = {
        **meta,
        "generator": LLM_GENERATOR_VERSION,
        "tags": sorted(set(tags)),
        "llm": {"model": model, "prompt_version": PROMPT_VERSION, "brief": brief.key},
    }
    updated = closed_at or rows[-1]["created_at"]
    if "late_update" in keep and closed_at:
        updated = (datetime.fromisoformat(closed_at) + timedelta(hours=rng.randint(2, 40))).isoformat()
    new_session = {**session, "status": status, "updated_at": updated, "closed_at": closed_at, "metadata": new_meta}
    return new_session, rows


def select_sessions(sessions: list[dict[str, Any]], n: int, seed: int = 7) -> list[dict[str, Any]]:
    """Deterministic, stratified pick of up to n sessions: every scenario first, then edge cases, then a spread of sales quality."""
    rng = random.Random(seed)
    pool = sorted(sessions, key=lambda s: s["session_id"])
    rng.shuffle(pool)
    chosen: list[dict[str, Any]] = []

    def take(pred: Callable[[dict[str, Any]], bool]) -> None:
        for s in pool:
            if s not in chosen and pred(s):
                chosen.append(s)
                return

    truth = lambda s: s["metadata"]["truth"]  # noqa: E731
    for sc in sorted({truth(s).get("scenario") for s in pool}, key=str):
        take(lambda s, sc=sc: truth(s).get("scenario") == sc)
    take(lambda s: bool(truth(s).get("pii")))
    take(lambda s: bool(truth(s).get("injection")))
    take(lambda s: "long_session" in s["metadata"].get("tags", []))
    for outcome in ("won", "lost", "ghost", "open"):
        take(lambda s, o=outcome: truth(s).get("outcome") == o and bool(truth(s).get("sales_conversation")))
    for disc in ("none", "partial", "complete"):
        take(lambda s, d=disc: truth(s).get("discovery") == d)
    for s in pool:
        if len(chosen) >= n:
            break
        if s not in chosen:
            chosen.append(s)
    return sorted(chosen[:n], key=lambda s: (s["organization_id"], s["session_id"]))


@dataclass(frozen=True)
class Completion:
    text: str
    input_tokens: int
    cached_tokens: int
    output_tokens: int


Caller = Callable[[str, str, int], Awaitable[Completion]]  # (system, user, max_output_tokens) -> completion


def responses_caller(http: Any, model: str, temperature: float = 0.9) -> Caller:
    """Calls the standard Responses API with a strict JSON schema; `http` is a sci_openai.http.OpenAIHttp."""

    async def call(system: str, user: str, max_out: int) -> Completion:
        data = await http.post(
            "/responses",
            {
                "model": model,
                "store": False,
                "temperature": temperature,
                "max_output_tokens": max_out,
                "input": [{"role": "developer", "content": system}, {"role": "user", "content": user}],
                "text": {"format": {"type": "json_schema", "name": "dialogue", "strict": True, "schema": SCHEMA}},
            },
        )
        if data.get("status") == "incomplete":
            raise ValueError("incomplete output")
        text = next((p["text"] for it in data.get("output") or [] for p in it.get("content") or [] if p.get("type") == "output_text"), None)
        u = data.get("usage")
        if text is None or not isinstance(u, dict):
            raise ValueError("no output or usage")
        return Completion(
            text,
            int(u.get("input_tokens", 0)),
            int((u.get("input_tokens_details") or {}).get("cached_tokens", 0)),
            int(u.get("output_tokens", 0)),
        )

    return call


@dataclass
class RunStats:
    written: int = 0
    cached: int = 0
    dropped: list[str] = field(default_factory=list)
    calls: int = 0
    spent_usd: float = 0.0
    stopped_by_budget: bool = False


def max_output_tokens(target: int) -> int:
    return min(8000, 400 + 90 * target)


async def write_dialogue(
    brief: Brief,
    call: Caller,
    gate: Any,
    price_in: float,
    price_cached: float,
    price_out: float,
    cache: dict[str, list[dict[str, Any]]],
    stats: RunStats,
    attempts: int = 2,
) -> list[dict[str, Any]] | None:
    """Accepted messages for the brief, from cache or the model. Never exceeds the gate: worst case is reserved first."""
    if brief.key in cache and not validate(brief, cache[brief.key]):  # cached answers are re-checked against today's rules
        stats.cached += 1
        return cache[brief.key]
    from sci_core.budget import BudgetExceeded

    user = brief.text
    last_problems = "no valid answer"
    for _attempt in range(attempts):
        max_out = max_output_tokens(brief.target)
        worst = ((len(SYSTEM_PROMPT) + len(user)) / 2.5 * price_in + max_out * price_out) / 1e6
        try:
            token = gate.reserve(worst)
        except BudgetExceeded:
            stats.stopped_by_budget = True
            return None
        try:
            done = await call(SYSTEM_PROMPT, user, max_out)
        except Exception:
            gate.settle(token, None)  # outcome unknown: the worst case stays charged
            stats.calls += 1
            continue
        cost = (
            (done.input_tokens - done.cached_tokens) * price_in + done.cached_tokens * price_cached + done.output_tokens * price_out
        ) / 1e6
        gate.settle(token, cost)
        stats.calls += 1
        try:
            msgs = parse_messages(done.text)
        except (ValueError, KeyError, TypeError):
            continue
        problems = validate(brief, msgs)
        if not problems:
            cache[brief.key] = msgs
            return msgs
        last_problems = "; ".join(problems)
        user = brief.text + "\n\nA tentativa anterior foi rejeitada: " + "; ".join(problems) + ". Corrija e reescreva a conversa inteira."
    stats.dropped.append(f"{brief.organization_id}/{brief.session_id}: {last_problems}")
    return None

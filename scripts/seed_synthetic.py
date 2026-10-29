"""Synthetic sales conversations for validating the platform. Invented people and data only; no real customer data.

The conversations come from `scripts/synthetic_data` (deterministic, offline, free): two businesses (electronics retail and B2B SaaS), about 360
sessions over 90 days, sellers of different skill, long and short sessions, support and wrong-number chats, bots, voice-note transcripts, invented
PII, prompt injections and a hidden ground truth in `sessions.metadata.truth` (never part of the text a model sees).

Default: write JSONL files locally (no network). With --project: load them into BigQuery with LOAD jobs (free) into
`<project>.commerce.{sessions,messages}` and publish the sample rubrics (v1-v3) to `conversation_config`.

Tenants are prefixed `synthetic-`; the loader refuses to replace tables holding any other tenant.
"""

from __future__ import annotations

import argparse
import dataclasses
import io
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synthetic_data as sd  # noqa: E402

# Same session ids in both tenants on purpose: isolation check.
TENANTS = [(t.organization_id, t.workspace_id, t.sessions) for t in sd.DEFAULT_TENANTS]
NOW = sd.NOW


def tenants_for(scale: float) -> tuple[sd.TenantSpec, ...]:
    return tuple(dataclasses.replace(t, sessions=max(4, round(t.sessions * scale))) for t in sd.DEFAULT_TENANTS)


def generate(scale: float = 1.0) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return sd.generate(tenants_for(scale))


def _criteria_v1() -> list[tuple[Any, ...]]:
    return [
        ("greeting", "Saudação", "O vendedor cumprimentou adequadamente?", "PREDICATE", 10, False, {"true": 100, "false": 0}, None),
        (
            "needs",
            "Necessidade",
            "O vendedor identificou a necessidade do cliente?",
            "SCORE",
            25,
            True,
            {"none": 0, "partial": 50, "complete": 100},
            None,
        ),
        ("product", "Produto", "Informações do produto corretas?", "SCORE", 20, True, {"poor": 0, "fair": 50, "good": 100}, None),
        ("objections", "Objeções", "Tratou as objeções de modo adequado?", "SCORE", 25, False, {"poor": 0, "fair": 50, "good": 100}, None),
        ("closing", "Fechamento", "Houve tentativa apropriada de fechamento?", "PREDICATE", 20, False, {"true": 100, "false": 0}, None),
    ]


def _criteria_v2() -> list[tuple[Any, ...]]:
    """Same criteria and weights as v1, but with explicit definitions of what each level means."""
    return [
        (
            "greeting",
            "Saudação",
            "O vendedor abriu a conversa de forma cordial e se apresentou ou ofereceu ajuda ao cliente?",
            "PREDICATE",
            10,
            False,
            {"true": 100, "false": 0},
            None,
        ),
        (
            "needs",
            "Necessidade",
            "Antes de recomendar um produto, o vendedor investigou a necessidade do cliente?",
            "SCORE",
            25,
            True,
            {"none": 0, "partial": 50, "complete": 100},
            {
                "none": "Não fez nenhuma pergunta sobre uso, contexto ou orçamento do cliente.",
                "partial": "Fez no máximo uma pergunta genérica, sem aprofundar uso, contexto ou orçamento.",
                "complete": "Perguntou sobre o uso ou contexto E sobre orçamento ou prioridades do cliente antes de recomendar.",
            },
        ),
        (
            "product",
            "Produto",
            "As informações dadas sobre o produto foram corretas e úteis para a decisão do cliente?",
            "SCORE",
            20,
            True,
            {"poor": 0, "fair": 50, "good": 100},
            {
                "poor": "Resposta vaga, evasiva ou sem informação concreta (por exemplo, 'acho que', 'não sei').",
                "fair": "Informação correta, mas incompleta: faltam detalhes concretos como especificações, garantia ou preço.",
                "good": "Informação concreta e específica (especificações, garantia, condições) e, se útil, oferta de material de apoio.",
            },
        ),
        (
            "objections",
            "Objeções",
            "O vendedor tratou adequadamente as objeções levantadas pelo cliente (preço, dúvida, 'vou pensar')?",
            "SCORE",
            25,
            False,
            {"poor": 0, "fair": 50, "good": 100},
            {
                "poor": "Ignorou a objeção ou apenas aceitou sem argumentar (por exemplo, 'é o preço que tem').",
                "fair": "Reconheceu a objeção, mas respondeu sem argumentos concretos.",
                "good": "Reconheceu a objeção, respondeu com argumentos concretos (comparação, garantia, frete) e checou com o cliente.",
            },
        ),
        (
            "closing",
            "Fechamento",
            "O vendedor propôs um próximo passo concreto para concluir a venda (link de pagamento, reserva, proposta)?",
            "PREDICATE",
            20,
            False,
            {"true": 100, "false": 0},
            None,
        ),
    ]


def _criteria_v3() -> list[tuple[Any, ...]]:
    """v2 plus a weight-0 gate ("did the customer raise an objection?") and a rule making `objections` depend on it."""
    rule = {"type": "depends_on", "criterion_id": "has_objection", "equals": ["true"]}
    out: list[tuple[Any, ...]] = []
    for c in _criteria_v2():
        if c[0] == "objections":
            out.append(
                (
                    "has_objection",
                    "Cliente levantou objeção?",
                    "O cliente levantou alguma objeção ou resistência (preço, dúvida, 'vou pensar', comparação com concorrente)?",
                    "PREDICATE",
                    0,
                    False,
                    {"true": 100, "false": 0},
                    None,
                    None,
                )
            )
            out.append((*c, rule))
        else:
            out.append((*c, None))
    return out


def _criteria_v4() -> list[tuple[Any, ...]]:
    """v3 plus an `is_sales` gate: conversations that are not sales (support, wrong number, bots) become NOT_EVALUABLE, not bad sales.

    Every scoring criterion depends on the gate; `objections` depends on it AND on `has_objection` (an all_of rule)."""
    # Stored shapes: one condition keeps the flat depends_on form, several use all_of.
    sales = {"type": "depends_on", "criterion_id": "is_sales", "equals": ["true"]}
    objections = {
        "type": "all_of",
        "rules": [{"criterion_id": "is_sales", "equals": ["true"]}, {"criterion_id": "has_objection", "equals": ["true"]}],
    }
    gate = (
        "is_sales",
        "É uma conversa de venda?",
        "Esta é uma conversa de venda? Considere venda quando o cliente demonstra interesse em comprar ou contratar, ou quando o vendedor oferece um "
        "produto ou serviço. Atendimento pós-venda (pedido, troca, cancelamento), número errado e mensagens automáticas de bot NÃO são vendas.",
        "PREDICATE",
        0,
        False,
        {"true": 100, "false": 0},
        None,
        None,
    )
    out: list[tuple[Any, ...]] = [gate]
    for c in _criteria_v3():
        rule = None if c[0] == "has_objection" else objections if c[0] == "objections" else sales
        out.append((*c[:8], rule))
    return out


def rubric_rows(org: str, ws: str, version: int = 1) -> dict[str, list[dict[str, Any]]]:
    pub = NOW.isoformat()
    crit = {4: _criteria_v4, 3: _criteria_v3, 2: _criteria_v2, 1: _criteria_v1}[version]()
    crit = [c if len(c) == 9 else (*c, None) for c in crit]
    name = {
        1: "Qualidade comercial",
        2: "Qualidade comercial (níveis descritos)",
        3: "Qualidade comercial (com aplicabilidade)",
        4: "Qualidade comercial (com porta de venda)",
    }[version]
    return {
        "evaluation_rubrics": [
            {
                "organization_id": org,
                "workspace_id": ws,
                "rubric_id": "sales_quality",
                "version": version,
                "name": name,
                "status": "PUBLISHED",
                "published_at": pub,
                "created_at": pub,
                "description": "Rubrica sintética",
            }
        ],
        "evaluation_criteria": [
            {
                "organization_id": org,
                "workspace_id": ws,
                "rubric_id": "sales_quality",
                "rubric_version": version,
                "criterion_id": c[0],
                "criterion_name": c[1],
                "evaluation_instructions": c[2],
                "evaluation_type": c[3],
                "weight": c[4],
                "required": c[5],
                "enabled": True,
                "applicability_rule": c[8],
                "score_mapping": c[6],
                "score_levels": c[7],
                "display_order": i,
            }
            for i, c in enumerate(crit, 1)
        ],
        "evaluation_policies": [
            {
                "organization_id": org,
                "workspace_id": ws,
                "rubric_id": "sales_quality",
                "rubric_version": version,
                "minimum_approval_score": 70,
                "missing_evidence_policy": "NEEDS_REVIEW",
            }
        ],
    }


def publish_rubric(project: str, location: str, version: int) -> None:  # pragma: no cover - needs real GCP
    """Adds rubric v2 for the synthetic tenants. Never touches existing rows (published rubrics are immutable)."""
    from google.cloud import bigquery as bq

    client = bq.Client(project=project, location=location)
    for org, ws, _ in TENANTS:
        ref = f"{project}.conversation_config.evaluation_rubrics"
        job = client.query(
            f"SELECT COUNT(*) c FROM `{ref}` WHERE organization_id=@o AND workspace_id=@w AND rubric_id='sales_quality' AND version=@v",
            job_config=bq.QueryJobConfig(
                query_parameters=[
                    bq.ScalarQueryParameter("o", "STRING", org),
                    bq.ScalarQueryParameter("w", "STRING", ws),
                    bq.ScalarQueryParameter("v", "INT64", version),
                ]
            ),
        )
        if list(job.result())[0].c:
            print(f"v{version} already published for {org}")
            continue
        for name, rows in rubric_rows(org, ws, version).items():
            cfg = bq.LoadJobConfig(source_format="NEWLINE_DELIMITED_JSON", write_disposition="WRITE_APPEND")
            data = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode()
            client.load_table_from_file(io.BytesIO(data), f"{project}.conversation_config.{name}", job_config=cfg).result()
        print(f"published rubric v{version} for {org}")


def write_local(out: Path, scale: float = 1.0) -> None:
    out.mkdir(parents=True, exist_ok=True)
    sessions, messages = generate(scale)
    files: dict[str, list[dict[str, Any]]] = {"sessions": sessions, "messages": messages}
    for org, ws, _ in TENANTS:
        for version in (1, 2, 3, 4):  # every sample rubric version, so a --reset restores all of them
            for name, rows in rubric_rows(org, ws, version).items():
                files.setdefault(name, []).extend(rows)
    for name, rows in files.items():
        (out / f"{name}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
        print(f"{name}: {len(rows)} rows")


def load_bigquery(project: str, out: Path, location: str, reset: bool = False) -> None:  # pragma: no cover - needs real GCP
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery as bq

    client = bq.Client(project=project, location=location)
    schemas = {
        "sessions": [
            bq.SchemaField(n, t, mode=m)
            for n, t, m in [
                ("organization_id", "STRING", "REQUIRED"),
                ("workspace_id", "STRING", "REQUIRED"),
                ("session_id", "STRING", "REQUIRED"),
                ("channel", "STRING", "NULLABLE"),
                ("customer_id", "STRING", "NULLABLE"),
                ("seller_id", "STRING", "NULLABLE"),
                ("status", "STRING", "NULLABLE"),
                ("started_at", "TIMESTAMP", "NULLABLE"),
                ("updated_at", "TIMESTAMP", "NULLABLE"),
                ("closed_at", "TIMESTAMP", "NULLABLE"),
                ("metadata", "JSON", "NULLABLE"),
            ]
        ],
        "messages": [
            bq.SchemaField(n, t, mode=m)
            for n, t, m in [
                ("organization_id", "STRING", "REQUIRED"),
                ("workspace_id", "STRING", "REQUIRED"),
                ("session_id", "STRING", "REQUIRED"),
                ("message_id", "STRING", "REQUIRED"),
                ("sender_id", "STRING", "NULLABLE"),
                ("sender_type", "STRING", "NULLABLE"),
                ("message_type", "STRING", "NULLABLE"),
                ("content", "STRING", "NULLABLE"),
                ("created_at", "TIMESTAMP", "REQUIRED"),
                ("sequence_number", "INT64", "NULLABLE"),
                ("metadata", "JSON", "NULLABLE"),
            ]
        ],
    }
    part = {"sessions": "started_at", "messages": "created_at"}
    for name, schema in schemas.items():
        ref = f"{project}.commerce.{name}"
        try:
            client.get_table(ref)
            exists = True
        except NotFound:
            exists = False
        if exists:
            foreign = list(client.query(f"SELECT COUNT(*) c FROM `{ref}` WHERE NOT STARTS_WITH(organization_id, 'synthetic-')").result())[
                0
            ].c
            if foreign:
                raise SystemExit(f"refusing to replace {ref}: it holds non-synthetic tenants")
        table = bq.Table(ref, schema=schema)
        table.time_partitioning = bq.TimePartitioning(field=part[name])
        table.clustering_fields = ["organization_id", "workspace_id", "session_id"]
        client.create_table(table, exists_ok=True)
        with (out / f"{name}.jsonl").open("rb") as fh:
            cfg = bq.LoadJobConfig(source_format="NEWLINE_DELIMITED_JSON", schema=schema, write_disposition="WRITE_TRUNCATE")
            client.load_table_from_file(fh, ref, job_config=cfg).result()
        print(f"loaded {ref}")
    if reset:  # results of synthetic tenants only; everything else is untouched
        for name in ("session_analyses", "session_criterion_results", "analysis_runs"):
            client.query(f"DELETE FROM `{project}.conversation_analytics.{name}` WHERE STARTS_WITH(organization_id, 'synthetic-')").result()
            print(f"reset synthetic rows in {name}")
    for name in ("evaluation_rubrics", "evaluation_criteria", "evaluation_policies"):
        ref = f"{project}.conversation_config.{name}"
        have = list(client.query(f"SELECT COUNT(*) c FROM `{ref}` WHERE STARTS_WITH(organization_id, 'synthetic-')").result())[0].c
        if have and not reset:
            print(f"skip {name}: synthetic rows already present (use --reset to replace)")
            continue
        if have:
            client.query(f"DELETE FROM `{ref}` WHERE STARTS_WITH(organization_id, 'synthetic-')").result()
        with (out / f"{name}.jsonl").open("rb") as fh:
            cfg = bq.LoadJobConfig(source_format="NEWLINE_DELIMITED_JSON", write_disposition="WRITE_APPEND")
            client.load_table_from_file(fh, ref, job_config=cfg).result()
        print(f"loaded {ref}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("synthetic_data"))
    ap.add_argument("--project", help="load into this GCP project (otherwise local files only)")
    ap.add_argument("--location", default="US")
    ap.add_argument(
        "--publish-rubric", type=int, choices=[2, 3, 4], help="only add this rubric version for the synthetic tenants (non-destructive)"
    )
    ap.add_argument(
        "--scale", type=float, default=1.0, help="multiplies the number of sessions per tenant (0.25 = a quick small set, 3 = a large one)"
    )
    ap.add_argument("--reset", action="store_true", help="also delete synthetic-* rows from config and analytics tables, then reload")
    a = ap.parse_args()
    if a.publish_rubric:
        if not a.project:
            raise SystemExit("--publish-rubric needs --project")
        publish_rubric(a.project, a.location, a.publish_rubric)
        return
    write_local(a.out, a.scale)
    if a.project:
        load_bigquery(a.project, a.out, a.location, a.reset)


if __name__ == "__main__":
    main()

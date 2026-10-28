"""End-to-end run of the real historical pipeline on real BigQuery with a FAKE, deterministic provider.

No OpenAI call, no AI cost. Results are written to the analytics dataset with model `fake-deterministic`, so they are
distinguishable from real analyses. Usage:
  python scripts/run_fake_pilot.py --project P --org synthetic-a [--workspace default]
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import re
from datetime import date

from sci_bq.rubric_repo import BigQueryRubricRepository
from sci_bq.runner import BigQueryRunner
from sci_bq.source import BigQuerySource, Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRunStore
from sci_core.budget import PriceBook
from sci_core.engine import EvaluationEngine
from sci_core.loader import RubricLoader
from sci_core.provider import AnswerState, ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import Criterion
from sci_workers.historical import HistoricalJob, JobConfig

MSG = re.compile(r"<<<MESSAGE id=(\S+) role=(\S+)")


class FakeProvider:
    model = "fake-deterministic"
    prompt_version = "fake-v2"

    async def evaluate(self, conversation_text: str, criteria: list[Criterion]) -> ProviderResponse:
        t = conversation_text.lower()
        msgs = MSG.findall(conversation_text)
        seller = next((m for m, role in msgs if role == "seller"), None)
        evidence = [seller] if seller else []
        few = len(msgs) < 4
        out: list[ProviderAnswer] = []
        for c in criteria:
            cid = c.criterion_id
            if cid in ("needs", "product") and few:
                out.append(ProviderAnswer(criterion_id=cid, state=AnswerState.INSUFFICIENT_EVIDENCE))
            elif cid == "greeting":
                out.append(
                    ProviderAnswer(
                        criterion_id=cid, answer=any(k in t for k in ("olá!", "boa tarde", "prazer")), evidence_message_ids=evidence
                    )
                )
            elif cid == "needs":
                a = "complete" if "faixa de preço" in t else "partial" if "melhor opção" in t else "none"
                out.append(ProviderAnswer(criterion_id=cid, answer=a, evidence_message_ids=evidence))
            elif cid == "product":
                a = "good" if "ficha técnica" in t else "poor" if "não sei" in t else "fair"
                out.append(ProviderAnswer(criterion_id=cid, answer=a, evidence_message_ids=evidence))
            elif cid == "objections":
                if not any(k in t for k in ("caro", "pensar")):
                    out.append(ProviderAnswer(criterion_id=cid, state=AnswerState.NOT_APPLICABLE))
                else:
                    out.append(
                        ProviderAnswer(criterion_id=cid, answer="good" if "comparando" in t else "poor", evidence_message_ids=evidence)
                    )
            elif cid == "closing":
                out.append(ProviderAnswer(criterion_id=cid, answer="link de pagamento" in t, evidence_message_ids=evidence))
            else:
                out.append(ProviderAnswer(criterion_id=cid, state=AnswerState.INSUFFICIENT_EVIDENCE))
        return ProviderResponse(
            answers=out, usage=ProviderUsage(input_tokens=max(1, len(conversation_text) // 4), output_tokens=0, estimated_cost_usd=0.0)
        )


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--project", required=True)
    p.add_argument("--org", required=True)
    p.add_argument("--workspace", default="default")
    p.add_argument("--rubric-id", default="sales_quality")
    p.add_argument("--rubric-version", type=int, default=1)
    p.add_argument("--start", type=date.fromisoformat, default=date(2026, 8, 1))
    p.add_argument("--end", type=date.fromisoformat, default=date(2026, 10, 28))
    p.add_argument("--location", default="US")
    a = p.parse_args()
    tables = Tables(a.project, "commerce", "conversation_config", "conversation_analytics")
    runner = BigQueryRunner(a.project, a.location)
    writer = BigQueryResultWriter(tables, a.location)
    cfg = JobConfig(
        tenant=Tenant(a.org, a.workspace),
        rubric_id=a.rubric_id,
        rubric_version=a.rubric_version,
        start_date=a.start,
        end_date=a.end,
        prices=PriceBook(0.125, 0.50),
        max_cost_usd=0.01,
        max_sessions=100,
    )
    job = HistoricalJob(
        source=BigQuerySource(runner, tables),
        store=BigQueryRunStore(runner, writer, tables),
        writer=writer,
        loader=RubricLoader(BigQueryRubricRepository(runner, tables)),
        engine=EvaluationEngine(FakeProvider(), mode="historical"),
        config=cfg,
    )
    stats = await job.run(approved=True)
    print(json.dumps(dataclasses.asdict(stats), indent=2))


if __name__ == "__main__":
    asyncio.run(main())

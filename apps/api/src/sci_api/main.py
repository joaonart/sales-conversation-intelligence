from fastapi import FastAPI
from pydantic import BaseModel, Field

from sci_api.scoring import CriterionResult, calculate_score

app = FastAPI(title="Sales Conversation Intelligence", version="0.1.0")

class PreviewRequest(BaseModel):
    criteria: list[CriterionResult] = Field(min_length=1)
    approval_threshold: float = Field(default=80, ge=0, le=100)

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

@app.post("/v1/evaluations/preview")
def preview(request: PreviewRequest) -> dict:
    result = calculate_score(request.criteria, request.approval_threshold)
    return result.model_dump()

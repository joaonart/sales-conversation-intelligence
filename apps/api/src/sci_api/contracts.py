from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class SessionKey:
    organization_id: str
    workspace_id: str
    session_id: str

class ConversationSourceAdapter(Protocol):
    async def get_session(self, key: SessionKey) -> dict[str, Any]: ...
    async def get_messages(self, key: SessionKey) -> list[dict[str, Any]]: ...

class AIProviderAdapter(Protocol):
    async def classify(self, context: str, criteria: list[dict]) -> list[dict]: ...

class AnalysisRepository(Protocol):
    async def append_analysis(self, analysis: dict, criteria: list[dict]) -> None: ...

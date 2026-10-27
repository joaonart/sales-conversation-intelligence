# ADR-0002: Optional Temporal
Do not deploy dedicated Temporal infrastructure in MVP. If an existing shared Temporal cluster is available and economical, implement an optional adapter; otherwise Cloud Run Jobs, Scheduler, Pub/Sub, and Cloud Tasks. Document workflow semantics and cost comparison before enabling.

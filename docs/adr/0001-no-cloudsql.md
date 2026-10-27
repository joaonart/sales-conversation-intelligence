# ADR-0001: BigQuery-centric MVP
Accepted: existing conversations are in BigQuery; results and rubrics also BigQuery. Avoid Cloud SQL fixed costs. BigQuery is not a queue or transactional state store. Use Pub/Sub/Cloud Tasks for operational delivery and checkpointed batch processing; add a small transactional store only after benchmarking demonstrates necessity and approval.

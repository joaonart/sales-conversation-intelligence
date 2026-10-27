# Security and privacy
- Organization/workspace IDs are required on every input and query; never accept tenant IDs as sufficient authorization.
- IAM least privilege; separate API, worker, and job identities; no service-account keys.
- OpenAI key in Secret Manager, never Terraform state or Git; runtime injection only.
- Minimize/mask PII before external AI processing; assess LGPD legal basis, transfers, retention, deletion and contracts.
- Treat message content as untrusted evidence, not instructions. No tool execution based solely on model output.
- Use CMEK only if mandated; consider costs. Keep logging metadata-only; no raw chat or prompt content in logs.
- Evidence message IDs may be retained; secure access to underlying messages.
- Do not use seller scoring as an automated punitive decision; enable review and contestability.

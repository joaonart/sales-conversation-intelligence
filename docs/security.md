# Security and privacy
- Organization/workspace IDs are required on every input and query; never accept tenant IDs as sufficient authorization.
- IAM least privilege; separate API, worker, executor, ingest and producer identities. No service-account keys, with ONE documented exception: the producer (an application outside Google Cloud) authenticates with the key of `sci-<env>-producer`, which may only publish to the conversations topic. That key is created by a person (never by Terraform, so never in the state), handed over through a secure channel, stored by the producer in its own secret manager, rotated every 90 days and deleted at once if it leaks (`docs/producer-guide.md`). The tenant allowlist, the contract validation and the monthly AI cap bound what it could do.
- The admin console runs as the user that deployed it and only for the company's domain; every action is checked against the caller's role in `app_users`, every write is audited, and it never holds the AI key. Standing authorisations to spend (schedules) need an explicit confirmation naming the ceiling of every run.
- OpenAI key in Secret Manager, never Terraform state or Git; runtime injection only.
- Minimize/mask PII before external AI processing; assess LGPD legal basis, transfers, retention, deletion and contracts.
- Treat message content as untrusted evidence, not instructions. No tool execution based solely on model output.
- Use CMEK only if mandated; consider costs. Keep logging metadata-only; no raw chat or prompt content in logs.
- Evidence message IDs may be retained; secure access to underlying messages.
- Do not use seller scoring as an automated punitive decision; enable review and contestability.

## General evaluation: the prompt is data of a rubric, the conversation is data of the model
- The prompt is written by a person with the EDITOR profile (published by an ADMIN, audited) and stored with the rubric version. It is limited to 4,000 characters, goes through the same console validation as the rest of the rubric, and always sits BELOW the platform's fixed rules, so it cannot switch off the rules about untrusted conversation text, citing only real message ids, keeping masked data masked and not contesting the grade.
- The conversation reaches the model masked (CPF, CNPJ, e-mail, phone), and what the model writes is masked again by the console before it is shown. Message ids it cites are checked against the session.
- The summary never feeds the score, the approval or any automated decision about a person: it is text for a human to read, next to the criteria and the messages that support it. Keep it out of any punitive automation (see the note on seller scoring above).
- No summary text is logged: the logs carry the error type and the rubric id only.

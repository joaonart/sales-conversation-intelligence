# Conversation ingest: how a producer sends conversations

A producer publishes **one message per change of a conversation** to the Pub/Sub topic `sci-<env>-conversations`, with the Pub/Sub API. Nothing else is needed on the producer side: the platform stores the conversation in BigQuery, announces it to the live worker, waits for the conversation to stop receiving messages (60 s in dev, 2 minutes by default) and analyses it.

```
producer ──publish──▶ sci-dev-conversations ──push──▶ sci-dev-ingest (Cloud Run)
                         │ 5 failed deliveries                │ 1. validates (tenant allowlist, contract, dates)
                         ▼                                    │ 2. stores the messages   (commerce.messages)
                  conversations-dlq-hold (7 days,             │ 3. stores the session    (commerce.sessions, one row, only moves forward)
                  alert, replayable)                          ▼ 4. publishes the analysis event ──▶ sci-dev-session-updates ──▶ live worker
```

## The message (`contracts/conversation-event.schema.json`, example in `contracts/conversation-event.example.json`)
```json
{ "event_id": "evt-000123", "organization_id": "synthetic-a", "workspace_id": "default",
  "session":  { "session_id": "s9001", "channel": "whatsapp", "status": "closed", "started_at": "2026-11-01T14:00:00Z",
                "updated_at": "2026-11-01T14:07:30Z", "closed_at": "2026-11-01T14:07:30Z" },
  "messages": [ { "message_id": "m1", "sender_type": "customer", "content": "Oi...", "created_at": "2026-11-01T14:00:05Z", "sequence_number": 1 } ] }
```
Send the **current state of the session** and the **messages that are new or changed** since the last time (sending all of them again is harmless).

Rules, all checked by the service (a violation is refused and parked in the dead-letter hold, never silently dropped):
* `started_at` never changes for a session; `updated_at` must **grow with every change** (it identifies the version of the conversation that is analysed). An event whose `updated_at` is not newer than the stored one changes nothing, so retries and out-of-order deliveries are safe.
* Every timestamp carries a timezone. None may be more than a day in the future.
* A message is identified by `message_id` and stored **once**, however many times it is sent. `message_id` is unique inside the event.
* A message may not be dated before the **day the session started** (the analysis reads from that day on; an earlier message would be stored and never read).
* At most 500 messages per event, 100,000 characters per message. Send long conversations in several events.
* `sender_type` is `customer`, `seller`, `bot` or `system`. `status` is `open` or `closed`: the historical job only analyses `closed` sessions; the live worker takes any.
* The workspace must be in the ingest allowlist (`ingest_tenants`). The tenant written in a message is never authorization by itself.

## Publishing
A working Python example (validation with the platform's own rules, retries, a mapping from the producer's data model) is in `samples/producer-python/`.
Needs `roles/pubsub.publisher` **on the topic only**. Two ways to grant it (Terraform): `producer_members` names existing identities (a producer that runs on Google Cloud uses its own service account, no keys), and `producer_service_account = true` creates `sci-<env>-producer`, the identity for a producer that runs **outside** Google Cloud (for example on AWS). That one authenticates with a key that a person creates out of band (Terraform never creates it, so it is never in the state) and rotates every 90 days; the step-by-step for the producer's team is `docs/producer-guide.md`.
```bash
gcloud pubsub topics publish sci-dev-conversations --project jnart-intelligence-513001 --message="$(cat contracts/conversation-event.example.json)"
```
```python
import json, google.auth
from google.auth.transport.requests import AuthorizedSession
creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/pubsub"])
body = {"messages": [{"data": __import__("base64").b64encode(json.dumps(event).encode()).decode()}]}
AuthorizedSession(creds).post("https://pubsub.googleapis.com/v1/projects/jnart-intelligence-513001/topics/sci-dev-conversations:publish", json=body).raise_for_status()
```
Pub/Sub delivers **at least once** and does not order messages: both are handled (see the rules above).

## Messages stored twice
Before inserting, the service looks up which `message_id`s of the event are already stored for the session (one small query, pruned to the days of the messages, tenant-scoped) and inserts only the missing ones, so a resent message does not add a row. Two deliveries racing each other can still store the same message twice (the lookup cannot see a row that is not written yet); **every reader of this platform counts a `message_id` once** (the analysis, the console and the cost estimate), and anything else that reads `commerce.messages` directly should do the same as a safeguard: `QUALIFY ROW_NUMBER() OVER (PARTITION BY session_id, message_id ORDER BY created_at) = 1`. Rows stored before this check existed are not removed.

## What happens to a failure
| Cause | Answer | Result |
|---|---|---|
| Not a valid JSON/contract | 400 | retried 5 times, then the dead-letter hold |
| Workspace not allowed | 403 | same |
| A rule above is broken | 422 | same |
| BigQuery or Pub/Sub failed | 503 | retried with backoff (10 s to 10 min), then the hold |
The hold keeps the message 7 days and the alert `conversations that could not be ingested` fires. Fix the cause and republish: it is idempotent.

## Limits and costs
Pub/Sub messages are limited to 10 MB. A session is one bounded MERGE (about 9 KB scanned, billed at the 10 MB minimum of BigQuery, roughly US$ 0.00006 each at on-demand rates: US$ 1.3 per 20,000 conversations); the lookup of stored ids is one more small query (about the same, scanning a few hundred bytes in dev, billed at the 10 MB minimum); messages are streaming inserts (about US$ 0.01 per 200 MB). Cloud Run scales to zero. The AI analysis itself is separate (about US$ 0.0002 per conversation with `gpt-6-luna`).

## Onboarding a new workspace
Everything is a configuration or data change, none is automatic (the test workspace `org-test/default` was onboarded this way):
1. **Terraform** (plan, then approval): the workspace in `ingest_tenants` (this service), in `tenants_json` (the live worker, with its rubric and debounce) and in `executor_tenants` (requests and schedules). Three in-place revisions, no new resource, no cost.
2. **A published rubric** in the new workspace: `scripts/copy_rubric_to_workspace.py` copies one from another workspace as a draft (no AI, no cost); an ADMIN of the new workspace publishes it in the console (audited).
3. **The first ADMIN** of the new workspace: nobody is a member of a workspace that did not exist, so the first row is inserted in `app_users` by whoever administers the project (the console cannot do it).
4. **The producer's identity** if it is a new producer (`docs/producer-guide.md`).
The producer is then free to send. With the workspace on the live list, each conversation may be analysed by the AI a minute after it stops receiving messages, within the monthly cap.

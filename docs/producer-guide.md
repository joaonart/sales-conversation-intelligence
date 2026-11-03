# Producer guide: how to send conversations to the platform (Sales Conversation Intelligence)

*Also in Portuguese: [`producer-guide.pt-BR.md`](producer-guide.pt-BR.md).*

For the team that will connect **its own application (running on AWS)** to the platform. You publish **one message per change of a conversation** to a Google Pub/Sub topic. The platform validates it, stores it and analyses it. You do not touch any database and you need nothing beyond what this guide covers.

## What the platform gives you
| Item | Value |
|---|---|
| Google Cloud project | `jnart-intelligence-513001` |
| Topic | `projects/jnart-intelligence-513001/topics/sci-dev-conversations` |
| Service account | `sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com` (it may **only publish to that topic**: it reads no data and sees no results) |
| Service account key | a JSON file, handed over through a **secure channel** (never by e-mail or chat) |
| Your `organization_id` and `workspace_id` | for tests: `organization_id` = `org-test` and `workspace_id` = `default` (a test workspace, no real data). For production, agreed with the platform **before** the first send |
| Contract and example | `contracts/conversation-event.schema.json` and `contracts/conversation-event.example.json` |

## Code example
A ready Python project, with validation, automatic retries and an example of mapping your own data model to the event, is in [`samples/producer-python`](../samples/producer-python/README.md). The snippets below are the short version of it.

## Step by step

### 1. Store the key safely
The key is a password: whoever has it can publish on your behalf.
* Keep the JSON in **AWS Secrets Manager** (or the vault you use). **Never** in code, in a repository, in a container image or in a log.
* Give it to the application through an environment variable, or read it from Secrets Manager at startup.
* Agree with the platform on a **rotation every 90 days** (the platform creates a new key, you switch, and the old one is deleted).
* If the key leaks, tell us **at once**: it is deleted and another one is issued.

### 2. Install the Pub/Sub library
```bash
pip install google-cloud-pubsub jsonschema      # Python
npm install @google-cloud/pubsub                 # Node.js
```

### 3. Build the message (one event per change)
The event carries the **current state of the session** and the **messages that are new or changed** since the last send. Sending messages that were already sent is harmless.
```json
{
  "event_id": "evt-000123",
  "organization_id": "org-test",
  "workspace_id": "default",
  "session": {
    "session_id": "s9001", "channel": "whatsapp", "customer_id": "c-77", "seller_id": "v-12",
    "status": "open",
    "started_at": "2026-11-01T14:00:00Z", "updated_at": "2026-11-01T14:07:30Z", "closed_at": null
  },
  "messages": [
    {"message_id": "m1", "sender_type": "customer", "content": "Hi, I would like the price of the annual plan.", "created_at": "2026-11-01T14:00:05Z", "sequence_number": 1}
  ]
}
```
**Rules (all checked by the platform):**
* `event_id`: unique for each event you send (for example a UUID).
* `session.session_id`: the id of the conversation in **your** system; it ties together all the events of the same conversation.
* `started_at` **never changes** for a session. `updated_at` **must grow with every change**; an event whose `updated_at` is equal to or older than the one already stored changes nothing (this is what protects against out-of-order events).
* Every date is ISO 8601 **with a timezone** (`2026-11-01T14:00:05Z`) and may not be more than 1 day in the future.
* `message_id` is unique inside the session: the same message sent again is stored **only once**.
* No message may be dated **before the day the session started**.
* At most **500 messages per event** and 100,000 characters per message. A long conversation goes in several events.
* `sender_type`: `customer`, `seller`, `bot` or `system`. `status`: `open` or `closed`.
* Do not send fields outside the contract: the event is refused.
* Send **only what is needed**: the platform masks national ids, e-mails and phone numbers, but names are not masked.

### 4. Publish
**Python**
```python
import json, os
from google.cloud import pubsub_v1
from google.oauth2 import service_account

TOPIC = "projects/jnart-intelligence-513001/topics/sci-dev-conversations"
info = json.loads(os.environ["SCI_PUBSUB_KEY_JSON"])            # comes from Secrets Manager
creds = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/pubsub"])
publisher = pubsub_v1.PublisherClient(credentials=creds)         # create it ONCE and reuse it

def send(event: dict) -> str:
    data = json.dumps(event, ensure_ascii=False).encode("utf-8")
    return publisher.publish(TOPIC, data).result(timeout=30)      # returns the message id; raises if it was not accepted
```
**Node.js**
```js
const { PubSub } = require('@google-cloud/pubsub');
const pubsub = new PubSub({ projectId: 'jnart-intelligence-513001', credentials: JSON.parse(process.env.SCI_PUBSUB_KEY_JSON) });
const topic = pubsub.topic('sci-dev-conversations');                      // create it ONCE and reuse it
const send = (event) => topic.publishMessage({ json: event });            // returns the message id; rejects if it was not accepted
```
Before the first send, validate the JSON against the contract (Python): `jsonschema.validate(event, json.load(open("conversation-event.schema.json")))`.

### 5. When to send
* Send **when the conversation changes** (a new message, the session closing), not on every keystroke and not on a clock.
* You do not need to batch: the platform merges all the notices of a conversation that arrive close together (within one window: 60 seconds in dev, 2 minutes by default) and analyses it **once**, between 1 and 2 waits after the first of them (60 to 120 seconds in dev). Ten messages in a row become **one** analysis.
* An analysis **only costs** when the content changed. Sending the same content again costs nothing.
* When the conversation ends, send an event with `status: "closed"`, `closed_at` and a larger `updated_at`.

### 6. Handle failures
* `publish(...).result()` **raised an error** (network, 5xx): retry with a growing wait (1 s, 2 s, 4 s... up to a few minutes). Resending is safe: nothing is stored twice.
* **403 / PERMISSION_DENIED**: the key is wrong, was deleted, or the account lost its permission. Retrying does not help; talk to the platform.
* **404 / NOT_FOUND** on the topic: the topic name is wrong.
* Pub/Sub accepted the send **but the event is invalid** (a rule was broken, the workspace is not enabled): the platform refuses it later, 5 times, and keeps it for **7 days** for investigation, without you seeing an error. That is why the validation of step 4 and the test of step 7 matter. If something does not show up, tell the platform the `event_id`: it fixes the cause and you resend.
* Delivery is **at least once** and **not ordered**: the platform already handles duplicates and out-of-order events (that is what `updated_at` and `message_id` are for).

### 7. Test before going live
1. Agree on the **test** `organization_id`/`workspace_id` with the platform (it has to enable them).
2. Publish the example event adjusted to your workspace, with a test `session_id`.
3. Ask the platform to confirm that the session and the messages arrived. If the workspace has a rubric, the analysis shows up in about 1 to 2 minutes.
4. Send the **same** event again: nothing should change (no duplicates).
5. Send a second event with a larger `updated_at` and one new message: only the new message is added.

### 8. Limits and cost
* A Pub/Sub message is at most **10 MB**.
* The Pub/Sub cost on your side is cents per thousands of events.
* The cost of the AI analysis is the platform's and has a monthly cap. If the cap is reached, analyses pause, but **conversations keep being stored**.

## Delivery checklist (for whoever grants access)
- [ ] Service account created (`sci-dev-producer`), allowed to publish **only** to the topic.
- [ ] The client's `organization_id/workspace_id` enabled in the ingest and, for live analysis, in the live worker.
- [ ] JSON key generated by **whoever grants access**, handed over through a secure channel, and the local file **deleted** afterwards.
- [ ] This guide, the contract and the example delivered.
- [ ] The test of step 7 followed.
- [ ] Date of the first key rotation (90 days) agreed.

### How to create and rotate the key (for whoever grants access)
```bash
# create (keep the file somewhere safe, hand it over and delete the local copy)
gcloud iam service-accounts keys create sci-dev-producer-key.json \
  --iam-account=sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com
# list the keys and delete the old one after the switch
gcloud iam service-accounts keys list   --iam-account=sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com
gcloud iam service-accounts keys delete KEY_ID --iam-account=sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com
```
The key is **not created by Terraform** (it would end up in the state). If the create command is refused, the project or the organisation has the policy `iam.disableServiceAccountKeyCreation`, which has to be changed by whoever administers the organisation.

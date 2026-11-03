# Python producer sample

*Also in Portuguese: [`README.pt-BR.md`](README.pt-BR.md).*

Working code that **validates** conversations and **publishes them to the Pub/Sub topic** of the Sales Conversation Intelligence platform. It is a starting point for whoever integrates a system: copy `producer.py`, wire it to your code and adapt the mapping.

The full guide (event rules, authentication, error handling, checklist) is in [`docs/producer-guide.md`](../../docs/producer-guide.md). This sample is the code version of that guide.

## What is here
| File | What it is for |
|---|---|
| `producer.py` | The library and the command line: validates the event, reads the key, publishes with automatic retries |
| `mapping_example.py` | How to turn a conversation **of your system** into the platform's event (replace it with your own mapping) |
| `events/` | Three events of the same conversation (open, with more messages, closed), ready to try |
| `schema/conversation-event.schema.json` | The event contract (a copy of the platform's; a test makes sure they are equal) |
| `.env.example` | The environment variables, with no secret |
| `requirements.txt` | `google-cloud-pubsub` and `jsonschema` |

## Step by step
**1. Install** (Python 3.9 or newer):
```bash
cd samples/producer-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

**2. Validate the sample events (nothing is sent):**
```bash
python producer.py
```
With no arguments it uses the sample events in `events/`. You can also name files: `python producer.py events/*.json` (a `*` works even where the shell does not expand it, as in an IDE). Without `--publish` the program only checks each file and says what it would send. Run it as often as you like.

**3. Configure and send.** Copy `.env.example` to `.env`, fill it in and load it:
```bash
cp .env.example .env     # edit: SCI_PROJECT, SCI_TOPIC and the key
set -a; source .env; set +a
python producer.py --publish
```
The service account key comes in **one** of these ways:
* `SCI_PUBSUB_KEY_JSON`: the JSON text (in production, read it from AWS Secrets Manager into this variable when the application starts);
* `SCI_PUBSUB_KEY_FILE`: the file path (for local tests only).

The sample events use the test workspace `org-test/default`. **Agree with the platform before really sending**: the workspace has to be enabled, and every conversation sent may be analysed by the AI (it costs the platform money). Use your own test `session_id`s.

**4. Use it in your code.** The essentials:
```python
from producer import PubSubPublisher, Sender, load_credentials, topic_path

publisher = PubSubPublisher(load_credentials())          # create it ONCE and reuse it
sender = Sender(publisher, topic_path("PROJECT", "TOPIC"))

message_id = sender.send(event)       # validates, publishes, and retries if the failure is transient
```
To build the `event` from your own data, see `mapping_example.py` (`python mapping_example.py` prints an example).

## What the `Sender` does for you
* **Validates before sending**, with the contract and with the same rules the platform applies on receipt (timezone in the dates, `updated_at` never before `started_at`, no message before the day the session started, no repeated `message_id`, at most 500 messages). An invalid event is **not sent**, and the exception lists every problem without showing the message text.
* **Retries** what is transient (timeouts, connection errors, HTTP 408, 429 and 5xx) with a growing wait (1 s, 2 s, 4 s... up to 30 s, with a little randomness). Resending is safe: the platform stores each message only once.
* **Does not insist** on what will not fix itself (403 wrong key or no permission, 404 wrong topic, 400): it raises `PublishFailed` with the cause, so you can fix it.

## The rules that trip up most integrations
1. `session_id` is the id of the conversation **in your system**; every event of the same conversation uses the same one.
2. `started_at` **never changes**. `updated_at` **grows with every event** (it is the time of the last change in your system). An event with an equal or older `updated_at` changes nothing.
3. Send the **new** messages since the last event. Sending an old one again is harmless.
4. `event_id` is unique per event. Building it from the session and `updated_at` (as `mapping_example.py` does) makes a resend of the same change produce the same id.
5. Every date in ISO 8601 **with a timezone** (`2026-11-02T14:00:05Z`).
6. Send the event **when the conversation changes**, not on every keystroke: the platform merges the notices that arrive close together and analyses the conversation once, 1 to 2 minutes later in dev.

## Common errors
| Symptom | Likely cause |
|---|---|
| `Missing library: jsonschema` (or google-cloud-pubsub) | The libraries are not installed in the interpreter that runs the script: run `pip install -r requirements.txt` with that interpreter |
| `received the placeholder` | `--project SCI_PROJECT --topic SCI_TOPIC` were typed literally: those are the **names** of environment variables. Set the variables (see `.env.example`) and leave the two options out, or pass real values |
| `INVALID` when running | One of the rules above; the text lists each problem |
| `NOT SENT: not accepted (PermissionDenied)` | Wrong or deleted key, or the account has no permission on the topic |
| `NOT SENT: not accepted (NotFound)` | Wrong `SCI_PROJECT` or `SCI_TOPIC` |
| `still failing after 5 retries` | Network problem or a Google outage; try again later |
| It sent with no error, but nothing shows up | Pub/Sub accepted it, but the platform refused the event afterwards (workspace not enabled, a rule broken). The platform sees this on its side: tell it the `event_id` |

## Running it in IntelliJ IDEA / PyCharm
1. **Python support.** IntelliJ IDEA needs the *Python* plugin (Settings > Plugins; PyCharm has it built in).
2. **An interpreter for the sample.** File > Project Structure > SDKs > **+** > *Add Python SDK* > *Virtualenv Environment* > *New*, location `samples/producer-python/.venv`, base interpreter Python 3.9 or newer. Then Project Structure > Modules > Dependencies and set it as the *Module SDK* (or pick it in the run configuration below).
3. **Install the libraries.** Open the IDE terminal (Alt+F12), `cd samples/producer-python` and `pip install -r requirements.txt` (the terminal activates the project interpreter; check that the prompt shows the `.venv`).
4. **Create the run configuration.** Run > Edit Configurations > **+** > *Python*:
   * *Script path*: `samples/producer-python/producer.py`
   * *Parameters*: leave it **empty** to use the sample events, or write `events/*.json` (the program expands the `*` itself, which an IDE does not do for you); for your own files, list them: `my-event-1.json my-event-2.json`
   * *Working directory*: `samples/producer-python`
   * *Python interpreter*: the `.venv` of step 2
   
   Run it: it only **validates** (it prints `valid ·` for each file and `Nothing was sent`). If the IDE shows `error: the following arguments are required`, you are running an old copy: pull the latest version.
5. **To really send,** duplicate that configuration, put `--publish` in the parameters (`--publish` alone sends the sample events) and set the *Environment variables*:
   `SCI_PROJECT=jnart-intelligence-513001;SCI_TOPIC=sci-dev-conversations;SCI_PUBSUB_KEY_FILE=/absolute/path/to/the-key.json`
   Keep the key file **outside the repository** (for example `~/.config/sci/`) and leave *Store as project file* **unchecked**, so nothing with a path or a secret lands in a shared `.run/` file. A successful send prints `sent · Pub/Sub message <id>` for each file.
6. **To step through it,** put a breakpoint in `Sender.send` (`producer.py`) and use *Debug* instead of *Run*.
7. **To run the tests** in the IDE, use the repository's own `.venv` as the interpreter (Python 3.12) and run `tests/test_sample_producer.py`: they need neither network nor a key.

## Tests
The tests are in `tests/test_sample_producer.py` at the root of the repository and need neither network nor a key (they use a fake publisher). Among other things they check that the sample events pass **the same validation model the platform's ingest uses**:
```bash
pytest -q tests/test_sample_producer.py
```

# Scheduling: how work runs without anyone at a terminal

Two pieces, both off by default and both under the same gates as everything that spends.

## 1. The trigger: the executor polls (Cloud Scheduler)
The console only **records** a request. A Cloud Run Job (`sci-<env>-executor`) takes it, applies its own gates and runs it. Something has to wake that job: with `executor_schedule` set (cron, UTC, for example `*/10 * * * *`) Terraform creates a Cloud Scheduler job that runs it with its own identity (no keys, no public endpoint, `roles/run.invoker` on that one job).

* An idle poll (nothing to do) ends in seconds, green, with no AI call and no key read. Cost: the first Scheduler job of the billing account is free; the empty runs (about 144 a day, 1 vCPU / 1 GiB, a few seconds) stay inside the Cloud Run free tier.
* **A trigger needs the AI gate open** (`executor_ai_enabled = true`): with the gate closed a waiting request is refused and the job ends with an error, so a trigger would only raise an alarm on every poll. Terraform refuses `executor_schedule` without it, and refuses AI without the OpenAI key secret and a monthly budget.

## 2. The executor's gates (in order), for every request, scheduled or not
1. The request exists, with a cost ceiling (made in the console by an ADMIN, or created by a schedule in the name of the ADMIN who made the schedule).
2. `AI_ENABLED=true` on the executor and the key attached.
3. The request is validated again (a closed list of models, bounded window and sessions, ceilings of the executor).
4. The person it is attributed to is still an **active ADMIN** of the workspace.
5. **Monthly budget** (`EXECUTOR_MONTHLY_BUDGET_USD`): what the workspace already spent this month (the `ai_spend` ledger: every paid call, stored or not) plus the most this request may cost must fit. Otherwise the request fails with the numbers; it is never run and trimmed.
6. The job's own preflight against the request's ceiling, and the budget gate before each call.

## 3. Schedules (the Agendas tab)
A schedule is a standing instruction: "every day at 02:00 UTC, analyse the last 7 days of rubric X v5 with model M, at most N sessions, at most US$ C per run". It is a row of `run_schedules` (append-only: pause, resume and archive are new rows; to change a schedule, archive it and create another).

* **It never runs or spends by itself.** On each poll the executor looks for due schedules and writes ONE ordinary request for each (`run_requests`, `requested_by` = the creator, `schedule_id` in the params). From there it is exactly a request made by hand.
* **Exactly once per slot.** The request id is a hash of (workspace, schedule, slot) and the insert is guarded in the statement, so polling twice or two executors polling at once cannot create it twice.
* **Never a backlog.** Only the last slot is ever due: an executor stopped for four days runs one, not four. A schedule created, edited, paused or resumed counts from its NEXT slot, never from one already in the past.
* **Never overlapping.** No new request while the previous one of the same schedule is waiting or running; no more than 3 active requests per workspace (the console's limit).
* **Only the new content costs.** The window is rolling (the last N days up to the slot) and the content-hash dedupe skips what was already analysed, so a daily run pays only for sessions that arrived or changed.
* **Stops when it should.** Pausing or archiving stops it from the next slot; if its creator loses the ADMIN role the request fails at gate 4; if the month's budget is reached the request fails at gate 5. Creating a schedule needs an explicit confirmation that names the ceiling of EVERY run, and is audited (`schedules.create`, `schedules.setStatus`).

Times are UTC; the screen always shows the equivalent in the reader's time zone.

## Expected cost
Infrastructure: about US$ 0 (Scheduler free tier, Cloud Run free tier, one small table). AI: only what schedules and requests authorise, bounded per run by the ceiling and per month by the executor's budget. Reference, gpt-6-luna at about US$ 0.00015 per analysis: 100 new sessions a day is about US$ 0.015 a day (US$ 0.45 a month).

## What this does not do
* No timezone-aware or monthly schedules, and no editing of a schedule in place (archive and create). Both are deliberate: fewer states to reason about.
* No per-schedule monthly budget: the monthly cap is per workspace, shared with the live worker and manual requests, because that is the money that actually matters.

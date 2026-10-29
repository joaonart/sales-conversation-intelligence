# SCI admin console

**Optional** companion to the platform (the engine and jobs never depend on it). Google Apps Script web app (TypeScript, bundled with esbuild) over BigQuery. Design, roles and the security model: `docs/admin-console.md`.

```
src/server/   main.ts (entry) rpc.ts (dispatcher) auth.ts audit.ts bq.ts sql.ts rubricRules.ts mask.ts validate.ts services/
src/client/   index.html styles.css app.js   (vanilla JS, no innerHTML)
tests/        vitest: access, behaviour, bq adapter, rules (+ conformance with Python), client safety
preview/      local UI preview with a mock backend (never deployed)
```

## Develop
```bash
npm ci
npm run check          # typecheck + tests + build -> dist/
node preview/server.mjs   # http://127.0.0.1:5173/?role=ADMIN|EDITOR|VIEWER (mock data)
```

## Validate the SQL against a real project (no cost, read-only dry run)
```bash
DUMP_SQL=/tmp/admin_sql.json npx vitest run tests/sqldump.test.ts
# then dry-run each statement with the BigQuery client (QueryJobConfig(dry_run=True)) against your project
```

## Deploy (each step needs a person; nothing here runs automatically)
Use a dedicated Workspace account for the deployer (it runs the code and reads the data; enable 2-step verification) and limit who can edit the script.
1. **Infrastructure** (review the plan first): in `infra/terraform/environments/<env>` set `enable_admin_console = true` and
   `console_members = ["user:<deployer>"]`, plan, and apply when approved. This creates `app_users`, `audit_log` and the deployer's least-privilege
   grants. Without the flag nothing console-related exists in your infrastructure.
2. Enable the **Google Apps Script API** for the deployer at https://script.google.com/home/usersettings (needed by clasp).
3. From `apps/admin-console`: `npm ci && npm run check`, then `npx clasp login` (sign in as the deployer).
4. Create the project once: `npm run build && npx clasp create-script --type webapp --title "SCI Console" --rootDir dist`
   (writes `.clasp.json`, which is git-ignored). Then `npm run push`.
5. **Script properties** (Apps Script editor -> Project Settings -> Script properties): `GCP_PROJECT`, `ALLOWED_DOMAIN` (e.g. `example.com`),
   optional `BQ_LOCATION` (default `US`), `CONFIG_DATASET`, `ANALYTICS_DATASET`, `SOURCE_DATASET`, `MAX_BYTES_BILLED`, and
   `BOOTSTRAP_ADMINS` = `[{"email":"you@example.com","organization_id":"...","workspace_id":"..."}]` (first administrator; used only for emails that
   never had a row).
6. Deploy as a **Web app**: `npx clasp deploy -d "v0.1.0"` (the manifest already declares *Execute as: Me* and *Who has access: anyone in the domain*).
   Open the web app URL once as the deployer and accept the two OAuth scopes (BigQuery and your email).
7. The first visit by a bootstrap admin creates their ADMIN membership (audited). Add everyone else in **Usuários**, then clear `BOOTSTRAP_ADMINS`.
8. Later releases: `npm run deploy` creates a new version; use `npx clasp deployments` + `npx clasp redeploy <id>` to keep the same URL.

## Operations
- Roll back a bad release by deploying the previous version in Apps Script; data is unaffected.
- Logs: Cloud Logging for the Apps Script project (metadata only: method, request id, error type).
- Access review: `audit.list` (ADMIN) or query `conversation_config.audit_log`.

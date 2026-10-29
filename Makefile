install:
	python -m pip install -e packages/evaluation-core -e packages/bigquery-adapter -e packages/openai-adapter -e apps/workers -e 'apps/api[dev]'
test:
	pytest -q tests
lint:
	ruff check apps/api/src packages/evaluation-core/src packages/bigquery-adapter/src packages/openai-adapter/src apps/workers/src tests
typecheck:
	mypy packages/evaluation-core/src packages/bigquery-adapter/src packages/openai-adapter/src apps/workers/src
gen-views:
	python scripts/gen_view_sql.py
fmt:
	ruff format apps/api/src packages/evaluation-core/src packages/bigquery-adapter/src packages/openai-adapter/src apps/workers/src tests
terraform-validate:
	terraform fmt -check -recursive infra/terraform
	for e in dev prod; do \
		terraform -chdir=infra/terraform/environments/$$e init -backend=false && \
		terraform -chdir=infra/terraform/environments/$$e validate; \
	done
# Offline plan with a dummy token and empty state: touches no cloud API, creates nothing. Never run apply from here.
terraform-plan-offline:
	cd infra/terraform/environments/dev && GOOGLE_OAUTH_ACCESS_TOKEN=offline terraform plan -refresh=false -lock=false -input=false \
		-var=project_id=sci-example-123456 -var=project_number=123456789012 -var=region=us-central1 -var=bq_location=US

admin-console-check:
	cd apps/admin-console && npm run check

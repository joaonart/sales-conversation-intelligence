install:
	python -m pip install -e packages/evaluation-core -e packages/bigquery-adapter -e apps/workers -e 'apps/api[dev]'
test:
	pytest -q tests
lint:
	ruff check apps/api/src packages/evaluation-core/src packages/bigquery-adapter/src apps/workers/src tests
typecheck:
	mypy packages/evaluation-core/src packages/bigquery-adapter/src apps/workers/src
fmt:
	ruff format apps/api/src packages/evaluation-core/src packages/bigquery-adapter/src apps/workers/src tests
terraform-validate:
	terraform -chdir=infra/terraform/environments/dev init -backend=false
	terraform -chdir=infra/terraform/environments/dev validate

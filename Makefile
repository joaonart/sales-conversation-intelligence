install:
	python -m pip install -e packages/evaluation-core -e packages/bigquery-adapter -e 'apps/api[dev]'
test:
	pytest -q tests
lint:
	ruff check apps/api/src packages/evaluation-core/src packages/bigquery-adapter/src tests
typecheck:
	mypy packages/evaluation-core/src packages/bigquery-adapter/src
fmt:
	ruff format apps/api/src packages/evaluation-core/src packages/bigquery-adapter/src tests
terraform-validate:
	terraform -chdir=infra/terraform/environments/dev init -backend=false
	terraform -chdir=infra/terraform/environments/dev validate

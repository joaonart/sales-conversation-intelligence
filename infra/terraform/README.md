# Terraform — minimal low-cost skeleton
This creates **only** APIs, datasets, service accounts, a Pub/Sub topic/subscription, optional budget notifications (not automatic spending cutoff), and optionally a Cloud Run API service if image provided. Historical job, live push subscriber, IAM hardening, secrets, alerts and CI are explicit TODOs and must be reviewed before production.

```bash
cd infra/terraform/environments/dev
terraform init
terraform fmt -recursive
terraform validate
terraform plan -var="project_id=YOUR_PROJECT" -var="region=us-central1"
# Do NOT terraform apply until budget/security review and approval.
```

Requirements: Terraform >=1.6, google provider ~>6.0, billing enabled, permissions to enable APIs and create resources. BigQuery dataset locations and Cloud Run region must be chosen for your residency needs. API enablement may incur no direct fee but deployed resources and usage can.

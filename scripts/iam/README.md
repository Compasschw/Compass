# IAM policies for Compass infrastructure

## compass-prod-rds-premig-snapshot-policy.json

Grants the production EC2 deploy host (`CompassEC2SSMRole`) the minimum
permissions needed by the pre-migration RDS snapshot gate in
`.github/workflows/deploy.yml` (audit 2026-06-12 blocker #6):

- create snapshots named `compass-prod-pre-mig-*` of `compass-prod`
- wait on / describe snapshot status
- prune old `compass-prod-pre-mig-*` snapshots (the workflow keeps the 5 newest)

It cannot snapshot or delete anything outside that prefix, and cannot touch
the sandbox DB.

**Apply once (from an admin AWS profile):**

```bash
aws iam put-role-policy \
  --role-name CompassEC2SSMRole \
  --policy-name CompassProdRDSPreMigSnapshot \
  --policy-document file://scripts/iam/compass-prod-rds-premig-snapshot-policy.json
```

The deploy workflow fails closed: if a deploy has pending migrations and the
snapshot cannot be taken (missing CLI, missing permissions), the deploy aborts
before `alembic upgrade heads` runs.

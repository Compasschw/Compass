# Runbook: Create All PHI Buckets In One Pass

**Status:** Ready to execute
**Region:** us-west-2 (matches all existing Compass buckets)
**Estimated time:** ~15 minutes start to finish

This runbook creates all 5 production PHI buckets currently required by shipped code, plus the shared KMS key and IAM policy attachment, in a single loop. It supersedes `create-phi-buckets.md` for the "do everything at once" path. The rationale for each bucket (lifecycle reasoning, HIPAA retention, lifecycle transitions) lives in that document.

## What gets created

| # | Bucket | Feature | Code commit |
|---|---|---|---|
| 1 | `compass-prod-call-recordings` | Vonage call audio → S3 (#32) | `a3d7416` / `c4f7d2b9e1a3` |
| 2 | `compass-prod-transcripts` | AssemblyAI utterance JSON (Phase 3, not yet wired) | — |
| 3 | `compass-prod-ai-summaries` | Claude summary provenance JSON (Phase 4, not yet wired) | — |
| 4 | `compass-prod-message-attachments` | Composer file + image attachments (#37) | `c134494` |
| 5 | `compass-prod-member-documents` | My Documents page uploads (#38) | `c134494` |

Plus:
- One shared KMS key `alias/compass-prod-phi` used by all 5 buckets
- One access-log bucket `compass-prod-s3-access-logs`
- One IAM policy attached to the EC2 instance role granting read/write to all 5 + KMS use

## Prereqs

- AWS CLI configured with credentials that have IAM + S3 + KMS admin rights on the Compass AWS account
- EC2 instance role name on hand (find with `aws iam list-instance-profiles` if not known)
- A scratch terminal — none of this runs from Claude Code's bash; the safety classifier blocks AWS writes

---

## Step 1 — KMS key (once)

```bash
KEY_OUTPUT=$(aws kms create-key \
  --description "Compass PHI buckets — shared key for all 5 PHI buckets" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --region us-west-2 \
  --output json)

export KEY_ARN=$(echo "$KEY_OUTPUT" | jq -r '.KeyMetadata.Arn')
export KEY_ID=$(echo "$KEY_OUTPUT" | jq -r '.KeyMetadata.KeyId')
echo "KEY_ARN=$KEY_ARN"
echo "KEY_ID=$KEY_ID"

aws kms create-alias \
  --alias-name alias/compass-prod-phi \
  --target-key-id "$KEY_ID" \
  --region us-west-2
```

**Save `KEY_ARN`** — you'll paste it into env vars in Step 4.

---

## Step 2 — Access-log bucket (once)

```bash
aws s3api create-bucket \
  --bucket compass-prod-s3-access-logs \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-public-access-block \
  --bucket compass-prod-s3-access-logs \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-encryption \
  --bucket compass-prod-s3-access-logs \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "'"$KEY_ARN"'"
      },
      "BucketKeyEnabled": true
    }]
  }'

aws s3api put-bucket-lifecycle-configuration \
  --bucket compass-prod-s3-access-logs \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-access-logs-1yr",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Expiration": {"Days": 365}
    }]
  }'
```

---

## Step 3 — Create the 5 PHI buckets in a loop

Copy-paste the entire block. It iterates over the 5 bucket names and applies identical config to each: SSE-KMS encryption with the shared key, versioning on, public-access block, TLS-only bucket policy, server-access logging to the bucket from Step 2, and the HIPAA 7-year lifecycle (Standard → Standard-IA at 90d → Glacier IR at 1y → Glacier Flexible at 3y → expire at 7y+30d buffer).

```bash
PHI_BUCKETS=(
  "compass-prod-call-recordings"
  "compass-prod-transcripts"
  "compass-prod-ai-summaries"
  "compass-prod-message-attachments"
  "compass-prod-member-documents"
)

for BUCKET in "${PHI_BUCKETS[@]}"; do
  echo "=== $BUCKET ==="

  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region us-west-2 \
    --create-bucket-configuration LocationConstraint=us-west-2

  aws s3api put-public-access-block \
    --bucket "$BUCKET" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

  aws s3api put-bucket-encryption \
    --bucket "$BUCKET" \
    --server-side-encryption-configuration '{
      "Rules": [{
        "ApplyServerSideEncryptionByDefault": {
          "SSEAlgorithm": "aws:kms",
          "KMSMasterKeyID": "'"$KEY_ARN"'"
        },
        "BucketKeyEnabled": true
      }]
    }'

  aws s3api put-bucket-versioning \
    --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled

  aws s3api put-bucket-policy \
    --bucket "$BUCKET" \
    --policy '{
      "Version": "2012-10-17",
      "Statement": [{
        "Sid": "DenyInsecureConnections",
        "Effect": "Deny",
        "Principal": "*",
        "Action": "s3:*",
        "Resource": [
          "arn:aws:s3:::'"$BUCKET"'",
          "arn:aws:s3:::'"$BUCKET"'/*"
        ],
        "Condition": {"Bool": {"aws:SecureTransport": "false"}}
      }]
    }'

  aws s3api put-bucket-logging \
    --bucket "$BUCKET" \
    --bucket-logging-status '{
      "LoggingEnabled": {
        "TargetBucket": "compass-prod-s3-access-logs",
        "TargetPrefix": "'"$BUCKET"'/"
      }
    }'

  aws s3api put-bucket-lifecycle-configuration \
    --bucket "$BUCKET" \
    --lifecycle-configuration '{
      "Rules": [{
        "ID": "hipaa-7yr-retention",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "Transitions": [
          {"Days": 90,   "StorageClass": "STANDARD_IA"},
          {"Days": 365,  "StorageClass": "GLACIER_IR"},
          {"Days": 1095, "StorageClass": "GLACIER"}
        ],
        "Expiration": {"Days": 2587},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 2557}
      }]
    }'
done

echo "All 5 PHI buckets created."
```

---

## Step 4 — IAM policy attachment to EC2 instance role

Find the EC2 instance role:

```bash
aws iam list-instance-profiles \
  --query 'InstanceProfiles[?contains(InstanceProfileName, `compass`)].[InstanceProfileName, Roles[0].RoleName]' \
  --output table
```

Then attach an inline policy (replace `<ROLE_NAME>` with the role from the table above):

```bash
ROLE_NAME="<ROLE_NAME>"

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name CompassProdPHIBuckets \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ],
        "Resource": [
          "arn:aws:s3:::compass-prod-call-recordings",
          "arn:aws:s3:::compass-prod-call-recordings/*",
          "arn:aws:s3:::compass-prod-transcripts",
          "arn:aws:s3:::compass-prod-transcripts/*",
          "arn:aws:s3:::compass-prod-ai-summaries",
          "arn:aws:s3:::compass-prod-ai-summaries/*",
          "arn:aws:s3:::compass-prod-message-attachments",
          "arn:aws:s3:::compass-prod-message-attachments/*",
          "arn:aws:s3:::compass-prod-member-documents",
          "arn:aws:s3:::compass-prod-member-documents/*"
        ]
      },
      {
        "Effect": "Allow",
        "Action": [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyWithoutPlaintext",
          "kms:DescribeKey"
        ],
        "Resource": "'"$KEY_ARN"'"
      }
    ]
  }'
```

---

## Step 5 — Env vars on prod EC2 (via SSM)

Paste this with the captured `KEY_ARN`:

```bash
aws ssm send-command \
  --instance-ids i-0f3d13da68b0974ee \
  --document-name AWS-RunShellScript \
  --comment "set PHI bucket env vars" \
  --parameters 'commands=[
    "cp /home/ubuntu/compass/backend/.env /home/ubuntu/compass/backend/.env.bak.bucket-setup",
    "cat >> /home/ubuntu/compass/backend/.env <<EOF",
    "S3_CALL_RECORDINGS_BUCKET=compass-prod-call-recordings",
    "S3_TRANSCRIPTS_BUCKET=compass-prod-transcripts",
    "S3_AI_SUMMARIES_BUCKET=compass-prod-ai-summaries",
    "S3_MESSAGE_ATTACHMENTS_BUCKET=compass-prod-message-attachments",
    "S3_MEMBER_DOCUMENTS_BUCKET=compass-prod-member-documents",
    "S3_KMS_KEY_ARN='"$KEY_ARN"'",
    "EOF",
    "echo OK"
  ]' \
  --query 'Command.CommandId' --output text
```

Then restart the api container:

```bash
aws ssm send-command \
  --instance-ids i-0f3d13da68b0974ee \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /home/ubuntu/compass/backend && docker compose restart api && sleep 8 && curl -fsS http://localhost:8000/api/v1/health && echo HEALTHY"]' \
  --query 'Command.CommandId' --output text
```

---

## Step 6 — Smoke verification

Quick reads to confirm everything looks right:

```bash
# Bucket inventory
aws s3api list-buckets --query "Buckets[?contains(Name, 'compass-prod')].Name" --output table

# KMS alias
aws kms list-aliases --query "Aliases[?AliasName=='alias/compass-prod-phi']" --output table

# IAM policy attached
aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name CompassProdPHIBuckets --query 'PolicyDocument' --output json

# Env vars wrote successfully
aws ssm send-command \
  --instance-ids i-0f3d13da68b0974ee \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["grep -E \"^S3_(CALL|TRANSCRIPTS|AI|MESSAGE|MEMBER|KMS)\" /home/ubuntu/compass/backend/.env | sed \"s|=.*|=<SET>|\""]' \
  --query 'Command.CommandId' --output text
```

End-to-end smoke from a real flow:
- Open https://joincompasschw.com/member/messages → tap the Paperclip in the composer → pick a small JPG → send. The upload PUT to `compass-prod-message-attachments` should succeed and the image should render inline in the bubble.
- Open https://joincompasschw.com/member/documents → tap "Upload income" → pick a PDF. Should appear as a DocCard with Download + Delete.

If those work, the buckets are live and the IAM + env wiring is correct.

## Optional Step 7 — Audio backfill (only if you want history)

After buckets are live, you can download the last 25 days of Vonage recordings into the audio bucket:

```bash
aws ssm send-command \
  --instance-ids i-0f3d13da68b0974ee \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /home/ubuntu/compass/backend && source .venv/bin/activate && python scripts/backfill_recent_recordings.py --dry-run"]' \
  --query 'Command.CommandId' --output text
```

If the dry-run output looks reasonable, re-run without `--dry-run`. Anything older than 25 days is already gone from Vonage's side — nothing to recover.

---

## Rollback (if something looks wrong)

Buckets can be re-created cleanly only if empty. To restore env to pre-runbook state:

```bash
aws ssm send-command \
  --instance-ids i-0f3d13da68b0974ee \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cp /home/ubuntu/compass/backend/.env.bak.bucket-setup /home/ubuntu/compass/backend/.env && cd /home/ubuntu/compass/backend && docker compose restart api"]' \
  --query 'Command.CommandId' --output text
```

The buckets themselves are safe to leave in place — they cost ~pennies/month empty. If you need to fully tear down a bucket, run `aws s3 rb s3://<BUCKET> --force` (empties + deletes; needs versions purged first for versioned buckets).

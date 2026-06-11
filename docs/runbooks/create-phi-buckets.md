# Runbook: Create PHI Call-Recording Buckets

**Status:** Ready to execute  
**Author:** Deployment agent — 2026-06-09  
**Region:** us-west-2 (matches all existing Compass buckets)  
**Prereqs:** AWS CLI configured with credentials that have IAM + S3 + KMS admin rights on the Compass AWS account.

---

## Why this exists

Vonage deletes call recordings after 30 days. We download the bytes immediately for transcription but were not persisting them. This runbook creates the three durable PHI buckets (audio, transcripts, AI summaries) and a shared KMS key, then grants the EC2 instance profile access to them.

The code changes that wire the recording_finalizer to call S3 are in the same commit as this runbook. The env vars below must be set in prod `.env` (via SSM or direct edit) after bucket creation.

---

## Step 1 — Create the KMS key

```bash
aws kms create-key \
  --description "Compass PHI buckets — call-recordings / transcripts / ai-summaries" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --region us-west-2 \
  --output json
```

**Save the `KeyMetadata.Arn` and `KeyMetadata.KeyId` from the output.**

Add a human-readable alias so the key is identifiable in the console:

```bash
aws kms create-alias \
  --alias-name alias/compass-prod-phi \
  --target-key-id <KeyId from above> \
  --region us-west-2
```

---

## Step 2 — Create the access-log bucket (once)

The three PHI buckets will send server access logs here.

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
        "KMSMasterKeyID": "<KEY_ARN>"
      },
      "BucketKeyEnabled": true
    }]
  }'

# Optional: expire access logs after 1 year
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

## Step 3 — Create the three PHI buckets

Run the following block once for each of the three bucket names:
- `compass-prod-call-recordings`
- `compass-prod-transcripts`
- `compass-prod-ai-summaries`

Replace `<BUCKET_NAME>` and `<KEY_ARN>` in each command.

```bash
BUCKET=<BUCKET_NAME>
KEY_ARN=<KEY_ARN>
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# 3a. Create bucket
aws s3api create-bucket \
  --bucket "$BUCKET" \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

# 3b. Block all public access
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 3c. Enable versioning
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# 3d. Enable SSE-KMS encryption with Bucket Key (reduces KMS API calls ~99%)
aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration "{
    \"Rules\": [{
      \"ApplyServerSideEncryptionByDefault\": {
        \"SSEAlgorithm\": \"aws:kms\",
        \"KMSMasterKeyID\": \"$KEY_ARN\"
      },
      \"BucketKeyEnabled\": true
    }]
  }"

# 3e. Deny non-TLS requests (HIPAA transport control)
aws s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"DenyNonTLS\",
      \"Effect\": \"Deny\",
      \"Principal\": \"*\",
      \"Action\": \"s3:*\",
      \"Resource\": [
        \"arn:aws:s3:::$BUCKET\",
        \"arn:aws:s3:::$BUCKET/*\"
      ],
      \"Condition\": {
        \"Bool\": {\"aws:SecureTransport\": \"false\"}
      }
    }]
  }"

# 3f. Server access logging to the access-log bucket
aws s3api put-bucket-logging \
  --bucket "$BUCKET" \
  --bucket-logging-status "{
    \"LoggingEnabled\": {
      \"TargetBucket\": \"compass-prod-s3-access-logs\",
      \"TargetPrefix\": \"$BUCKET/\"
    }
  }"

# 3g. Lifecycle policy:
#   Standard -> Standard-IA at 90 days
#   Standard-IA -> Glacier Instant Retrieval at 1 year
#   Glacier IR -> Glacier Flexible Retrieval at 3 years
#   Delete at 7 years + 30 days (HIPAA 6yr + CA Health & Safety Code §123111 7yr)
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "hipaa-7yr-lifecycle",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Transitions": [
        {"Days": 90,  "StorageClass": "STANDARD_IA"},
        {"Days": 365, "StorageClass": "GLACIER_IR"},
        {"Days": 1095,"StorageClass": "GLACIER"}
      ],
      "Expiration": {"Days": 2587},
      "NoncurrentVersionTransitions": [
        {"NoncurrentDays": 90,  "StorageClass": "STANDARD_IA"},
        {"NoncurrentDays": 365, "StorageClass": "GLACIER_IR"}
      ],
      "NoncurrentVersionExpiration": {"NoncurrentDays": 2557}
    }]
  }'
```

**Expiration math:** 7 years = 2555 days; +30-day buffer = 2585 days. The value 2587 above rounds to the nearest week. Adjust if legal counsel specifies a different horizon.

---

## Step 4 — Grant EC2 instance profile access

Find the IAM role attached to the production EC2 instance:

```bash
# On the EC2 instance, or via the console:
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=compass-prod-api" \
  --query "Reservations[*].Instances[*].IamInstanceProfile.Arn" \
  --output text

# Get the role name from the instance profile:
aws iam get-instance-profile \
  --instance-profile-name <profile-name-from-above> \
  --query "InstanceProfile.Roles[0].RoleName" \
  --output text
```

Create and attach a new inline policy to that role:

```bash
ROLE_NAME=<role-name-from-above>
KEY_ARN=<KEY_ARN>

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "CompassProdCallRecordingBuckets" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"S3CallRecordingBuckets\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"s3:PutObject\",
          \"s3:GetObject\",
          \"s3:DeleteObject\",
          \"s3:ListBucket\"
        ],
        \"Resource\": [
          \"arn:aws:s3:::compass-prod-call-recordings\",
          \"arn:aws:s3:::compass-prod-call-recordings/*\",
          \"arn:aws:s3:::compass-prod-transcripts\",
          \"arn:aws:s3:::compass-prod-transcripts/*\",
          \"arn:aws:s3:::compass-prod-ai-summaries\",
          \"arn:aws:s3:::compass-prod-ai-summaries/*\"
        ]
      },
      {
        \"Sid\": \"KMSForPHIBuckets\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"kms:Encrypt\",
          \"kms:Decrypt\",
          \"kms:GenerateDataKey\",
          \"kms:GenerateDataKeyWithoutPlaintext\",
          \"kms:DescribeKey\"
        ],
        \"Resource\": \"$KEY_ARN\"
      }
    ]
  }"
```

---

## Step 5 — Set env vars on prod

SSH to the EC2 instance and add the following to `/home/ubuntu/compass/backend/.env`:

```
S3_CALL_RECORDINGS_BUCKET=compass-prod-call-recordings
S3_TRANSCRIPTS_BUCKET=compass-prod-transcripts
S3_AI_SUMMARIES_BUCKET=compass-prod-ai-summaries
S3_KMS_KEY_ARN=<full ARN from Step 1, e.g. arn:aws:kms:us-west-2:123456789012:key/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx>
```

Then restart the backend:

```bash
sudo systemctl restart compass-backend
# Verify clean start:
sudo journalctl -u compass-backend -n 50 --no-pager
```

---

## Step 6 — Verify

```bash
# Confirm bucket exists and is in the right region:
aws s3api get-bucket-location --bucket compass-prod-call-recordings
# Expected: {"LocationConstraint": "us-west-2"}

# Confirm encryption is set:
aws s3api get-bucket-encryption --bucket compass-prod-call-recordings

# Confirm versioning is on:
aws s3api get-bucket-versioning --bucket compass-prod-call-recordings

# Confirm public access is fully blocked:
aws s3api get-public-access-block --bucket compass-prod-call-recordings

# Confirm lifecycle rule:
aws s3api get-bucket-lifecycle-configuration --bucket compass-prod-call-recordings
```

---

## Step 7 — Run the backfill (within 30-day Vonage window)

After the backend restarts and new calls are being archived automatically, run the backfill for sessions processed before this deployment:

```bash
# SSH to EC2, navigate to backend, activate venv:
cd /home/ubuntu/compass/backend
source .venv/bin/activate

# Dry run first:
python scripts/backfill_recent_recordings.py --dry-run

# If output looks correct, run for real:
python scripts/backfill_recent_recordings.py --days 25
```

The script logs at INFO level with structured fields (comm_session_id, s3_key, byte counts). No PHI is logged.

---

## Rollback

If a bucket was mis-configured, the bucket policy and lifecycle can be updated in place via the same `put-bucket-*` commands. Deleting a bucket requires emptying it first — do not delete unless you are certain it contains no PHI.

The `audio_s3_key` column in `communication_sessions` is nullable; if the S3 upload step fails, the column stays NULL and the existing clinical workflow (transcription + summary) is unaffected.

To roll back the alembic migration (removes the column only — no S3 objects affected):

```bash
cd /home/ubuntu/compass/backend
source .venv/bin/activate
alembic downgrade z9w3x4y5a6b7
```

---

## Step 3b — Create the message-attachments PHI bucket (4th bucket)

**When to run:** Before enabling file/image attachment sending in CHW and Member Messages screens in production. The backend will return a boto3 error (not a crash) if this bucket is absent when a user attempts to upload a message attachment.

**Bucket name:** `compass-prod-message-attachments`

This bucket uses the **same KMS key** created in Step 1 (`alias/compass-prod-phi`). Run the same block from Step 3 with the bucket name substituted:

```bash
BUCKET=compass-prod-message-attachments
KEY_ARN=<KEY_ARN from Step 1>
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# 3b-a. Create bucket
aws s3api create-bucket \
  --bucket "$BUCKET" \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

# 3b-b. Block all public access
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 3b-c. Enable versioning
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# 3b-d. SSE-KMS encryption with Bucket Key
aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration "{
    \"Rules\": [{
      \"ApplyServerSideEncryptionByDefault\": {
        \"SSEAlgorithm\": \"aws:kms\",
        \"KMSMasterKeyID\": \"$KEY_ARN\"
      },
      \"BucketKeyEnabled\": true
    }]
  }"

# 3b-e. Deny non-TLS requests (HIPAA transport control)
aws s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"DenyNonTLS\",
      \"Effect\": \"Deny\",
      \"Principal\": \"*\",
      \"Action\": \"s3:*\",
      \"Resource\": [
        \"arn:aws:s3:::$BUCKET\",
        \"arn:aws:s3:::$BUCKET/*\"
      ],
      \"Condition\": {
        \"Bool\": {\"aws:SecureTransport\": \"false\"}
      }
    }]
  }"

# 3b-f. Server access logging
aws s3api put-bucket-logging \
  --bucket "$BUCKET" \
  --bucket-logging-status "{
    \"LoggingEnabled\": {
      \"TargetBucket\": \"compass-prod-s3-access-logs\",
      \"TargetPrefix\": \"$BUCKET/\"
    }
  }"

# 3b-g. HIPAA 7-year lifecycle (same as the other three PHI buckets)
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "hipaa-7yr-lifecycle",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Transitions": [
        {"Days": 90,  "StorageClass": "STANDARD_IA"},
        {"Days": 365, "StorageClass": "GLACIER_IR"},
        {"Days": 1095,"StorageClass": "GLACIER"}
      ],
      "Expiration": {"Days": 2587},
      "NoncurrentVersionTransitions": [
        {"NoncurrentDays": 90,  "StorageClass": "STANDARD_IA"},
        {"NoncurrentDays": 365, "StorageClass": "GLACIER_IR"}
      ],
      "NoncurrentVersionExpiration": {"NoncurrentDays": 2557}
    }]
  }'
```

### Update IAM role policy to include the 4th bucket

Extend the existing inline policy on the EC2 instance role (`CompassProdCallRecordingBuckets`) to add the message-attachments bucket:

```bash
ROLE_NAME=<role-name-from-Step-4>
KEY_ARN=<KEY_ARN from Step 1>

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "CompassProdPHIBuckets" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"S3PHIBuckets\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"s3:PutObject\",
          \"s3:GetObject\",
          \"s3:DeleteObject\",
          \"s3:ListBucket\"
        ],
        \"Resource\": [
          \"arn:aws:s3:::compass-prod-call-recordings\",
          \"arn:aws:s3:::compass-prod-call-recordings/*\",
          \"arn:aws:s3:::compass-prod-transcripts\",
          \"arn:aws:s3:::compass-prod-transcripts/*\",
          \"arn:aws:s3:::compass-prod-ai-summaries\",
          \"arn:aws:s3:::compass-prod-ai-summaries/*\",
          \"arn:aws:s3:::compass-prod-message-attachments\",
          \"arn:aws:s3:::compass-prod-message-attachments/*\"
        ]
      },
      {
        \"Sid\": \"KMSForPHIBuckets\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"kms:Encrypt\",
          \"kms:Decrypt\",
          \"kms:GenerateDataKey\",
          \"kms:GenerateDataKeyWithoutPlaintext\",
          \"kms:DescribeKey\"
        ],
        \"Resource\": \"$KEY_ARN\"
      }
    ]
  }"
```

### Set env var on prod

Add to `/home/ubuntu/compass/backend/.env`:

```
S3_MESSAGE_ATTACHMENTS_BUCKET=compass-prod-message-attachments
```

Then restart: `sudo systemctl restart compass-backend`

### Verify

```bash
aws s3api get-bucket-location --bucket compass-prod-message-attachments
aws s3api get-bucket-encryption --bucket compass-prod-message-attachments
aws s3api get-public-access-block --bucket compass-prod-message-attachments
```

---

## Step 3c — Create the member-documents PHI bucket (5th bucket)

**When to run:** Before enabling document upload on the Member Documents or CHW
Documents screens in production.  The backend will return a boto3 error (not a
crash) if this bucket is absent when a user attempts to upload a member document.

**Bucket name:** `compass-prod-member-documents`

**Allowed object types:** PDF, JPEG, PNG, HEIC (enforced in
`backend/app/schemas/upload.py` ALLOWED_MIME_TYPES and the presigned-URL
endpoint).

This bucket uses the **same KMS key** created in Step 1 (`alias/compass-prod-phi`).

```bash
BUCKET=compass-prod-member-documents
KEY_ARN=<KEY_ARN from Step 1>
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# 3c-a. Create bucket
aws s3api create-bucket \
  --bucket "$BUCKET" \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

# 3c-b. Block all public access
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 3c-c. Enable versioning
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# 3c-d. SSE-KMS encryption with Bucket Key
aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration "{
    \"Rules\": [{
      \"ApplyServerSideEncryptionByDefault\": {
        \"SSEAlgorithm\": \"aws:kms\",
        \"KMSMasterKeyID\": \"$KEY_ARN\"
      },
      \"BucketKeyEnabled\": true
    }]
  }"

# 3c-e. Deny non-TLS requests (HIPAA transport control)
aws s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"DenyNonTLS\",
      \"Effect\": \"Deny\",
      \"Principal\": \"*\",
      \"Action\": \"s3:*\",
      \"Resource\": [
        \"arn:aws:s3:::$BUCKET\",
        \"arn:aws:s3:::$BUCKET/*\"
      ],
      \"Condition\": {
        \"Bool\": {\"aws:SecureTransport\": \"false\"}
      }
    }]
  }"

# 3c-f. Server access logging
aws s3api put-bucket-logging \
  --bucket "$BUCKET" \
  --bucket-logging-status "{
    \"LoggingEnabled\": {
      \"TargetBucket\": \"compass-prod-s3-access-logs\",
      \"TargetPrefix\": \"$BUCKET/\"
    }
  }"

# 3c-g. HIPAA 7-year lifecycle (same as the other four PHI buckets)
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "hipaa-7yr-lifecycle",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Transitions": [
        {"Days": 90,  "StorageClass": "STANDARD_IA"},
        {"Days": 365, "StorageClass": "GLACIER_IR"},
        {"Days": 1095,"StorageClass": "GLACIER"}
      ],
      "Expiration": {"Days": 2587},
      "NoncurrentVersionTransitions": [
        {"NoncurrentDays": 90,  "StorageClass": "STANDARD_IA"},
        {"NoncurrentDays": 365, "StorageClass": "GLACIER_IR"}
      ],
      "NoncurrentVersionExpiration": {"NoncurrentDays": 2557}
    }]
  }'
```

### Update IAM role policy to include the 5th bucket

Extend the existing inline policy on the EC2 instance role (`CompassProdPHIBuckets`)
to add the member-documents bucket:

```bash
ROLE_NAME=<role-name-from-Step-4>
KEY_ARN=<KEY_ARN from Step 1>

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "CompassProdPHIBuckets" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"S3PHIBuckets\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"s3:PutObject\",
          \"s3:GetObject\",
          \"s3:DeleteObject\",
          \"s3:ListBucket\"
        ],
        \"Resource\": [
          \"arn:aws:s3:::compass-prod-call-recordings\",
          \"arn:aws:s3:::compass-prod-call-recordings/*\",
          \"arn:aws:s3:::compass-prod-transcripts\",
          \"arn:aws:s3:::compass-prod-transcripts/*\",
          \"arn:aws:s3:::compass-prod-ai-summaries\",
          \"arn:aws:s3:::compass-prod-ai-summaries/*\",
          \"arn:aws:s3:::compass-prod-message-attachments\",
          \"arn:aws:s3:::compass-prod-message-attachments/*\",
          \"arn:aws:s3:::compass-prod-member-documents\",
          \"arn:aws:s3:::compass-prod-member-documents/*\"
        ]
      },
      {
        \"Sid\": \"KMSForPHIBuckets\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"kms:Encrypt\",
          \"kms:Decrypt\",
          \"kms:GenerateDataKey\",
          \"kms:GenerateDataKeyWithoutPlaintext\",
          \"kms:DescribeKey\"
        ],
        \"Resource\": \"$KEY_ARN\"
      }
    ]
  }"
```

### Set env var on prod

Add to `/home/ubuntu/compass/backend/.env`:

```
S3_MEMBER_DOCUMENTS_BUCKET=compass-prod-member-documents
```

Then restart: `sudo systemctl restart compass-backend`

### Verify

```bash
aws s3api get-bucket-location --bucket compass-prod-member-documents
aws s3api get-bucket-encryption --bucket compass-prod-member-documents
aws s3api get-public-access-block --bucket compass-prod-member-documents
```

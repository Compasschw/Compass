# Production Deployment Plan — CompassCHW Backend
**Date:** 2026-04-08
**Author:** Deployment Agent
**Status:** Plan — do not execute without review

---

## 1. Summary of Current State

| Component | Current | Target |
|---|---|---|
| Frontend | Vercel, joincompasschw.com, static/demo only | Vercel, connected to live backend via VITE_API_URL |
| Backend | FastAPI, Docker, local only | AWS EC2 (free tier) or ECS Fargate, api.joincompasschw.com |
| Database | PostgreSQL 16, local Docker | AWS RDS PostgreSQL 16 (free tier db.t3.micro) |
| S3 | Not provisioned | Two S3 buckets: PHI + public, us-west-2 |
| Secrets | `.env` file, local | AWS SSM Parameter Store (free) |
| Migrations | Alembic, manual local | Run as one-shot ECS task or SSH step pre-deploy |
| Domain | GoDaddy → Vercel | GoDaddy: `joincompasschw.com` → Vercel; `api.joincompasschw.com` → AWS ALB or EC2 Elastic IP |

---

## 2. Platform Evaluation

### 2a. Backend Compute

| Platform | Free Tier | Cost After Free | HIPAA BAA Available | Postgres Built-in | Custom Domain / HTTPS | Notes |
|---|---|---|---|---|---|---|
| **AWS EC2 + RDS** | 750h/mo t3.micro (12 mo) + RDS t3.micro (12 mo) | ~$62/mo (see below) | Yes — standard BAA | Separate RDS service | Yes — ACM cert + Route 53 / Nginx | Already decided by team; S3, IAM, KMS, CloudWatch all native |
| **Fly.io** | 3 shared-cpu-1x VMs free | ~$10–20/mo for 1 instance | No BAA available | Managed Postgres ~$5–30/mo | Yes — automatic TLS | HIPAA BAA not offered at any tier; disqualified for PHI |
| **Render** | Free tier (spins down after 15 min inactivity) | $7/mo starter, $25/mo standard | No BAA available | $7/mo starter | Yes — automatic TLS | No HIPAA BAA; free tier cold starts unacceptable for health app |
| **Railway** | $5 credit/mo free | ~$5–15/mo | No BAA available | Managed Postgres ~$5/mo | Yes — automatic TLS | No HIPAA BAA; disqualified |

**Verdict:** AWS is the only option among these that offers a HIPAA BAA. Fly.io, Render, and Railway do not offer BAAs at any price point. AWS is also the pre-existing team decision (per PROJECT_CONTEXT.md and CompassCHW_AWS_Cost_Breakdown.xlsx). The free tier covers compute and database for 12 months.

### 2b. PostgreSQL Hosting

| Platform | Free Tier | Cost After Free | HIPAA BAA | Connection Pooling | Backups |
|---|---|---|---|---|---|
| **AWS RDS (PostgreSQL 16)** | db.t3.micro, 20 GB, 12 mo free | $58/mo db.t4g.small | Yes — native | PgBouncer via RDS Proxy ($0.015/hr ~$11/mo) or app-level | Automated daily snapshots, PITR 35 days |
| **Neon** | 0.5 GB, 1 compute branch free | $19/mo (Launch plan) | No BAA | Built-in connection pooler (Neon proxy) | Yes, 7-day history | Disqualified for PHI |
| **Supabase** | 500 MB, 2 projects free | $25/mo (Pro) | No BAA | PgBouncer built-in | Daily, 7-day retention | Disqualified for PHI |
| **Render Postgres** | 1 GB free (90 days only) | $7–20/mo | No BAA | Not built-in | Daily, 7-day retention | Disqualified for PHI |
| **Railway Postgres** | Included in free credit | ~$5/mo | No BAA | Not built-in | Point-in-time (Pro plan) | Disqualified for PHI |

**Verdict:** AWS RDS is the only option with a HIPAA BAA. Use db.t3.micro during the free tier (12 months, 20 GB storage). The asyncpg driver used by the codebase connects natively. No RDS Proxy needed at MVP scale — the async SQLAlchemy connection pool (`pool_size` config in `database.py`) is sufficient.

---

## 3. Recommended Architecture — AWS Free Tier MVP

```
joincompasschw.com           GoDaddy DNS → Vercel (frontend)
api.joincompasschw.com       GoDaddy CNAME → EC2 Elastic IP
                                   |
                             EC2 t3.micro (free tier)
                             Ubuntu 24.04 LTS
                             Nginx (TLS termination, reverse proxy)
                             Docker (FastAPI container on port 8000)
                                   |
                             RDS PostgreSQL 16
                             db.t3.micro (free tier, 20 GB)
                             Private subnet, SG: only EC2 sg allowed
                                   |
                             S3 us-west-2
                             compass-phi-prod (PHI, no public access)
                             compass-public-prod (profile images, etc.)
                                   |
                             SSM Parameter Store
                             All secrets stored as SecureString
```

**Why EC2 + Nginx over ECS Fargate for MVP:**
- ECS Fargate + ALB adds ~$22/mo (ALB) + ~$20/mo (Fargate). EC2 t3.micro is free for 12 months.
- Nginx on EC2 handles TLS via Let's Encrypt (Certbot). No ALB cost.
- Single instance is appropriate for a pilot with a small team and no SLA requirement.
- Migration path to ECS Fargate is straightforward — the Dockerfile is already production-ready.

**What needs to be hardened before going to ECS/Fargate:**
- Add ALB for health-check-based rolling deploys
- Add NAT Gateway or VPC endpoints for private RDS access without public subnet
- Adopt GitHub Actions deploy workflow (see Section 7)

---

## 4. Codebase Changes Required

### 4a. Dockerfile — Add Multi-Stage Build

The current Dockerfile is functional but installs dev dependencies and copies everything including `.env`. Replace it with a multi-stage build.

**File:** `/Users/akrammahmoud/Desktop/Projects/Compass/backend/Dockerfile`

Replace current single-stage Dockerfile with:

```dockerfile
# Stage 1: build dependencies
FROM python:3.12-slim AS builder

WORKDIR /build

COPY pyproject.toml .
RUN pip install --no-cache-dir --prefix=/install .

# Stage 2: runtime image
FROM python:3.12-slim AS runtime

# Non-root user for least-privilege execution
RUN groupadd -r compass && useradd -r -g compass compass

WORKDIR /code

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application source only — no .env, no tests, no __pycache__
COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini .

USER compass

EXPOSE 8000

# Use Gunicorn with Uvicorn workers for production signal handling
# For free-tier single core: 2 workers is appropriate
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*"]
```

Key changes:
- Multi-stage build eliminates build tools from runtime image
- Non-root user `compass` (HIPAA: least privilege)
- `--proxy-headers` required so FastAPI sees real client IPs behind Nginx (for audit logging in `AuditMiddleware`)
- `--forwarded-allow-ips "*"` trusts Nginx's `X-Forwarded-For` on the same host

### 4b. Add `.dockerignore`

**File:** `/Users/akrammahmoud/Desktop/Projects/Compass/backend/.dockerignore`

```
.env
.env.*
*.pyc
__pycache__/
*.egg-info/
.pytest_cache/
tests/
.git/
node_modules/
dist/
```

This prevents the local `.env` (which contains `local-dev-only-not-for-production-use-abc123` as the secret key) from being baked into any image layer.

### 4c. `docker-compose.yml` — Dev Only Note

The existing `docker-compose.yml` is dev-only and does not need modification. Do not use it in production. Add a comment at the top:

```yaml
# THIS FILE IS FOR LOCAL DEVELOPMENT ONLY.
# Production uses EC2 + RDS, not Docker Compose.
```

### 4d. `backend/app/config.py` — Add `DATABASE_URL` sync alias

The `alembic/env.py` reads `DATABASE_URL` from `os.environ`. The Settings class reads `database_url`. These match via pydantic-settings case-insensitive env var binding — no change needed. However, confirm that the production `DATABASE_URL` uses `postgresql+asyncpg://` (asyncpg driver) for the application and `postgresql://` (psycopg2 / sync) for Alembic migrations.

Alembic uses `async_engine_from_config` so `postgresql+asyncpg://` is correct for both. No change needed.

### 4e. `vercel.json` — Update CSP to Allow API Origin

The current `connect-src 'self'` in the Content-Security-Policy will block browser `fetch()` calls to `api.joincompasschw.com`. Update:

```json
"connect-src 'self' https://api.joincompasschw.com;"
```

**File:** `/Users/akrammahmoud/Desktop/Projects/Compass/web/vercel.json`

Change line:
```
"connect-src 'self';"
```
To:
```
"connect-src 'self' https://api.joincompasschw.com;"
```

### 4f. No changes needed

- `app/main.py` — CORS is already configured from `settings.cors_origins`, which is set via environment variable. Set `CORS_ORIGINS=["https://joincompasschw.com"]` in SSM and it works.
- `app/routers/health.py` — `/api/v1/health` and `/api/v1/ready` already exist. Use these for Nginx upcheck and future ALB health checks.
- `alembic/env.py` — Already reads `DATABASE_URL` from `os.environ`. Migration command works with `DATABASE_URL` set.

---

## 5. AWS Setup — Step-by-Step

### Phase 0 — Account Prerequisites (One-Time)

1. Create AWS account at console.aws.amazon.com (or use existing)
2. Enable MFA on root account immediately
3. Create IAM user `compass-deploy` with programmatic access only. Attach policies:
   - `AmazonEC2FullAccess` (scope down after MVP)
   - `AmazonRDSFullAccess` (scope down after MVP)
   - `AmazonS3FullAccess` (scope down after MVP)
   - `AmazonSSMFullAccess`
4. Sign the AWS BAA: AWS console → Account → AWS Artifact → Business Associate Agreement. This is required before storing any PHI.
5. Set billing alarm: CloudWatch → Alarms → Billing → threshold $20/mo (SMS to your phone)

### Phase 1 — VPC and Networking

All resources in `us-west-2` (Oregon).

1. Use the default VPC for MVP (simplest, no NAT Gateway needed).
2. Create two Security Groups:
   - `compass-ec2-sg`: inbound 22 (SSH, your IP only), 80 (HTTP, 0.0.0.0/0), 443 (HTTPS, 0.0.0.0/0); outbound all
   - `compass-rds-sg`: inbound 5432 from `compass-ec2-sg` only; outbound none

### Phase 2 — RDS PostgreSQL

1. RDS → Create database → Standard create
   - Engine: PostgreSQL 16
   - Template: Free tier (db.t3.micro, 20 GB gp2, no Multi-AZ, no read replica)
   - DB identifier: `compass-prod`
   - Master username: `compass`
   - Master password: generate a strong random password (save it — you'll put it in SSM next)
   - VPC: default; Subnet group: default
   - Public access: No
   - VPC security group: `compass-rds-sg`
   - Initial database name: `compass`
   - Backup retention: 7 days
   - Enable Performance Insights: No (costs money)
   - Enable Enhanced monitoring: No (costs money)
   - Enable auto minor version upgrade: Yes
2. After creation, note the RDS endpoint: `compass-prod.xxxxxxxx.us-west-2.rds.amazonaws.com`

### Phase 3 — S3 Buckets

Create two buckets in `us-west-2`:

**PHI bucket:** `compass-phi-prod`
- Block all public access: enabled
- Versioning: enabled
- Default encryption: SSE-S3 (AES-256) — or SSE-KMS for BAA-level audit trail (adds ~$1/mo)
- Bucket policy: deny all except compass-ec2 IAM role

**Public bucket:** `compass-public-prod`
- Block public access: disabled for GET only
- CORS configuration (for frontend presigned URL uploads):
```json
[{
  "AllowedHeaders": ["*"],
  "AllowedMethods": ["GET", "PUT", "POST"],
  "AllowedOrigins": ["https://joincompasschw.com"],
  "ExposeHeaders": ["ETag"]
}]
```

### Phase 4 — SSM Parameter Store Secrets

In AWS Systems Manager → Parameter Store, create the following as `SecureString` (free tier — no KMS cost if you use the default AWS-managed key):

| Parameter Name | Value |
|---|---|
| `/compass/prod/DATABASE_URL` | `postgresql+asyncpg://compass:PASSWORD@compass-prod.xxxxxxxx.us-west-2.rds.amazonaws.com:5432/compass` |
| `/compass/prod/SECRET_KEY` | output of: `python -c "import secrets; print(secrets.token_urlsafe(64))"` |
| `/compass/prod/CORS_ORIGINS` | `["https://joincompasschw.com"]` |
| `/compass/prod/AWS_REGION` | `us-west-2` |
| `/compass/prod/S3_BUCKET_PHI` | `compass-phi-prod` |
| `/compass/prod/S3_BUCKET_PUBLIC` | `compass-public-prod` |
| `/compass/prod/TWILIO_ACCOUNT_SID` | (blank until Twilio is live) |
| `/compass/prod/TWILIO_AUTH_TOKEN` | (blank until Twilio is live) |
| `/compass/prod/TWILIO_PROXY_SERVICE_SID` | (blank until Twilio is live) |

### Phase 5 — EC2 Instance

1. EC2 → Launch instance
   - Name: `compass-api-prod`
   - AMI: Ubuntu Server 24.04 LTS (free tier eligible)
   - Instance type: t3.micro
   - Key pair: create new `compass-prod-key`, download `.pem`, store securely
   - Security group: `compass-ec2-sg`
   - Storage: 20 GB gp3 (free tier gives 30 GB)
   - IAM instance profile: create role `compass-ec2-role` with policies:
     - `AmazonSSMManagedInstanceCore` (for SSM parameter access + Session Manager SSH)
     - `AmazonS3FullAccess` (scope down to the two buckets after MVP)
2. Allocate Elastic IP and associate with instance. Note the public IP.

### Phase 6 — EC2 Configuration (SSH in)

```bash
ssh -i compass-prod-key.pem ubuntu@<ELASTIC_IP>
```

**Install Docker:**
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
newgrp docker
```

**Install Nginx + Certbot:**
```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

**Configure Nginx** — create `/etc/nginx/sites-available/compass-api`:
```nginx
server {
    listen 80;
    server_name api.joincompasschw.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name api.joincompasschw.com;

    ssl_certificate /etc/letsencrypt/live/api.joincompasschw.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.joincompasschw.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/compass-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

**Obtain TLS Certificate** (requires DNS CNAME already set):
```bash
sudo certbot --nginx -d api.joincompasschw.com --non-interactive --agree-tos -m akram.mahmoud-eng@joincompasschw.com
```

Certbot auto-renews via a systemd timer — no cron needed.

### Phase 7 — Database Migrations

Run Alembic migrations once before starting the application. From EC2:

```bash
# Pull secrets from SSM
export DATABASE_URL=$(aws ssm get-parameter --name /compass/prod/DATABASE_URL --with-decryption --query Parameter.Value --output text --region us-west-2)

# Pull the code (use git or SCP the backend directory)
git clone https://github.com/YOUR_ORG/compass.git /opt/compass
cd /opt/compass/backend

pip install -e .
alembic upgrade head
```

Migration safety note: The current codebase has a single initial migration (`c71ddf0089d9_initial_schema.py`). For future migrations, always write them as backwards-compatible (add columns with defaults or nullable, never rename/drop in the same deploy as the code change). Use a two-step deploy: migrate first, then deploy code.

### Phase 8 — Run the Application Container

Fetch all secrets and run the Docker container:

```bash
# Create a production .env file from SSM (on the EC2 instance only, not committed)
aws ssm get-parameters-by-path \
  --path /compass/prod \
  --with-decryption \
  --region us-west-2 \
  --query 'Parameters[*].[Name,Value]' \
  --output text | awk '{
    split($1, a, "/"); 
    print a[4] "=" $2
  }' > /opt/compass/.env.prod

# Build and run
cd /opt/compass/backend
docker build -t compass-api:latest .
docker run -d \
  --name compass-api \
  --restart unless-stopped \
  --env-file /opt/compass/.env.prod \
  -p 8000:8000 \
  compass-api:latest
```

Verify health:
```bash
curl http://localhost:8000/api/v1/health
# Expected: {"status":"ok"}
curl http://localhost:8000/api/v1/ready
# Expected: {"status":"ready"}
```

### Phase 9 — DNS Configuration (GoDaddy)

Log into GoDaddy DNS for `joincompasschw.com`:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | Vercel IP (from Vercel dashboard) | 600 |
| CNAME | `www` | `cname.vercel-dns.com` | 600 |
| CNAME | `api` | `<ELASTIC_IP>` | 600 (use A record, not CNAME, for bare IPs) |

Correction: GoDaddy does not allow CNAME for a bare IP. Use an A record for `api`:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `api` | `<ELASTIC_IP>` | 600 |

Wait for DNS propagation (up to 30 min with TTL 600), then run Certbot.

### Phase 10 — Connect Vercel Frontend to Backend

In Vercel dashboard → Project Settings → Environment Variables:

| Variable | Value | Environment |
|---|---|---|
| `VITE_API_URL` | `https://api.joincompasschw.com/api/v1` | Production |
| `VITE_APP_URL` | `https://joincompasschw.com` | Production |
| `VITE_DEMO_MODE` | `false` | Production |

Trigger a Vercel redeploy after setting variables (environment variables in Vite are baked at build time).

---

## 6. Environment Variables — Complete Reference

### Backend (EC2 / SSM Parameter Store)

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Full asyncpg connection string | `postgresql+asyncpg://compass:PASS@HOST:5432/compass` |
| `SECRET_KEY` | JWT signing key, 64-byte random | `secrets.token_urlsafe(64)` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | JWT access token TTL | `15` |
| `REFRESH_TOKEN_EXPIRE_DAYS` | JWT refresh token TTL | `7` |
| `CORS_ORIGINS` | JSON list of allowed origins | `["https://joincompasschw.com"]` |
| `AWS_REGION` | AWS region | `us-west-2` |
| `S3_BUCKET_PHI` | PHI S3 bucket name | `compass-phi-prod` |
| `S3_BUCKET_PUBLIC` | Public S3 bucket name | `compass-public-prod` |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | (set when live) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | (set when live) |
| `TWILIO_PROXY_SERVICE_SID` | Twilio proxy SID | (set when live) |

### Frontend (Vercel Environment Variables — baked at build time)

| Variable | Description | Production Value |
|---|---|---|
| `VITE_API_URL` | Backend base URL | `https://api.joincompasschw.com/api/v1` |
| `VITE_APP_URL` | Frontend URL | `https://joincompasschw.com` |
| `VITE_DEMO_MODE` | Disable demo mock data | `false` |

---

## 7. CORS Configuration

The application already handles CORS in `app/main.py` via `settings.cors_origins`. In production, set:

```
CORS_ORIGINS=["https://joincompasschw.com"]
```

No wildcard. No `http://` origins in production. The `allow_credentials=True` setting requires an explicit origin list (FastAPI/Starlette rejects `allow_origins=["*"]` with `allow_credentials=True`).

---

## 8. Rollback Strategy

For this EC2-based MVP, rollback is manual but fast:

1. Keep the previous Docker image tagged: `compass-api:previous`
2. Before every deploy: `docker tag compass-api:latest compass-api:previous`
3. Rollback: `docker stop compass-api && docker run -d --name compass-api --restart unless-stopped --env-file /opt/compass/.env.prod -p 8000:8000 compass-api:previous`

Database rollback: Alembic supports `alembic downgrade -1`. Test the downgrade on staging before production deploys.

---

## 9. HIPAA Compliance Checklist for MVP

- [x] Sign AWS BAA (required before any PHI enters the system)
- [x] RDS encryption at rest — enabled by default on RDS (AES-256)
- [x] RDS encryption in transit — enforce `sslmode=require` in DATABASE_URL (add `?ssl=require` to connection string)
- [x] S3 server-side encryption — SSE-S3 enabled on PHI bucket
- [x] S3 public access block — enabled on PHI bucket
- [x] IAM least privilege — EC2 role only has access to compass-specific resources
- [x] Secrets in SSM, not in code or environment at dev time
- [x] HTTPS only — enforced by Nginx redirect + HSTS header (already in vercel.json for frontend)
- [x] Audit logging — `AuditMiddleware` logs every request with method, path, status, IP, duration
- [x] No PHI in logs — verify that no model field values are logged (check serializers)
- [ ] CloudWatch log retention — set to 365 days (HIPAA minimum) once CloudWatch is configured
- [ ] PHI bucket access logging — enable S3 server access logging to a separate audit bucket
- [ ] Workforce training — Akram, Jemal, JT must complete HIPAA training before accessing PHI

**Important:** The current system does not store PHI yet — it is demo/mock data. Do not introduce real member data until the BAA is signed and the checklist above is complete.

---

## 10. Monitoring — Minimum Viable Observability

For MVP, before paying for DataDog or Grafana Cloud:

**CloudWatch (free tier: 10 custom metrics, 5 GB log ingestion):**
- Forward Docker container logs to CloudWatch Logs:
```bash
docker run -d \
  --name compass-api \
  --log-driver=awslogs \
  --log-opt awslogs-region=us-west-2 \
  --log-opt awslogs-group=/compass/api/prod \
  --log-opt awslogs-create-group=true \
  --restart unless-stopped \
  --env-file /opt/compass/.env.prod \
  -p 8000:8000 \
  compass-api:latest
```
- Create CloudWatch Alarm on log errors (filter pattern: `ERROR`) → SNS → email

**Uptime (free):**
- Use UptimeRobot (free tier, 5-min intervals) to monitor `https://api.joincompasschw.com/api/v1/health`
- Alert on Slack or email when `/health` returns non-200

---

## 11. Estimated Monthly Cost

### During Free Tier (months 1–12)

| Service | Cost |
|---|---|
| EC2 t3.micro (750h/mo) | $0 (free tier) |
| RDS db.t3.micro (750h/mo, 20 GB) | $0 (free tier) |
| S3 (5 GB storage + requests) | ~$0.12 |
| SSM Parameter Store (SecureString, default KMS) | $0 |
| CloudWatch Logs (under 5 GB/mo) | $0 |
| ACM Certificate (Certbot / Let's Encrypt) | $0 |
| Elastic IP (attached to running instance) | $0 |
| **Total** | **~$0–$1/mo** |

### After Free Tier (month 13+)

| Service | Cost |
|---|---|
| EC2 t3.micro | ~$8.50/mo |
| RDS db.t3.micro (or upgrade to db.t4g.small) | $12.50–$58/mo |
| S3 | ~$1/mo |
| Vercel (frontend) | $0 (hobby plan sufficient for MVP) |
| Elastic IP | $0 (attached to running instance) |
| **Total (t3.micro RDS)** | **~$22/mo** |
| **Total (t4g.small RDS, production-grade)** | **~$68/mo** |

Note: The CompassCHW_AWS_Cost_Breakdown.xlsx in the project root documents a more complete production cost at ~$62–130/mo. The free tier gives 12 months to reach revenue before those costs kick in.

---

## 12. Next Steps (Ordered by Priority)

1. Sign the AWS BAA — nothing else matters until this is done if PHI will flow through the system.
2. Set billing alarm in CloudWatch ($20 threshold) to avoid surprise charges.
3. Provision RDS (Phase 2 above) — takes 10–15 minutes. Note the endpoint.
4. Push secrets to SSM Parameter Store (Phase 4).
5. Update the Dockerfile with the multi-stage build (Section 4a).
6. Add `.dockerignore` (Section 4b).
7. Provision EC2, configure Nginx, get TLS cert (Phases 5–6).
8. Run Alembic migrations from EC2 (Phase 7).
9. Run the Docker container (Phase 8).
10. Set `api` A record in GoDaddy (Phase 9).
11. Set `VITE_API_URL` in Vercel and redeploy (Phase 10).
12. Update `vercel.json` CSP `connect-src` (Section 4e).
13. Verify end-to-end: browser → `joincompasschw.com` → fetch to `api.joincompasschw.com/api/v1/health`.

---

## 13. Future Migration Path (When Ready to Scale)

When the free tier expires or pilot grows beyond a single instance:

1. Replace EC2 + Nginx with **ECS Fargate + ALB** — Dockerfile is already compatible.
2. Upgrade RDS to **db.t4g.small** with Multi-AZ for 99.95% uptime SLA.
3. Add **RDS Proxy** for connection pooling under load.
4. Add **GitHub Actions** CI/CD pipeline: lint → typecheck → pytest → docker build → push to ECR → ECS rolling deploy.
5. Add **AWS WAF** in front of ALB for OWASP Top 10 protection.
6. Move secrets from SSM to **AWS Secrets Manager** with automatic rotation.

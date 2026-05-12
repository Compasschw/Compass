# Deploy

## TL;DR

- **Frontend:** auto-deploys on push to `main` via Vercel.
- **Backend:** auto-deploys on push to `main` via the `Deploy to EC2` GitHub Action (`.github/workflows/deploy.yml`).

After the one-time secrets setup below, you ship a release by:

```
git push origin main
```

That's it. CI runs in parallel; the Deploy action SSHs into EC2, pulls code, rebuilds containers, runs `alembic upgrade head`, and health-checks.

## One-time setup — GitHub Secrets

The Deploy action needs four secrets to log into the EC2 box. Add them once at:

> **GitHub → your Compass repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value | How to find |
|---|---|---|
| `EC2_HOST` | EC2 public IPv4 or DNS, e.g. `54.176.xx.xx` or `ec2-54-176-xx-xx.us-west-1.compute.amazonaws.com` | AWS Console → EC2 → Instances → click your Compass instance → Public IPv4 address |
| `EC2_USERNAME` | Usually `ubuntu` (Ubuntu AMIs) or `ec2-user` (Amazon Linux) | The user you `ssh` in as |
| `EC2_SSH_KEY` | The full contents of your `.pem` private key file (paste including `-----BEGIN ... KEY-----` and `-----END ... KEY-----` lines) | `cat ~/path/to/your-key.pem` and copy everything |
| `EC2_PROJECT_PATH` | Absolute path on the EC2 box to the Compass repo, e.g. `/home/ubuntu/Compass` | `pwd` from the repo root on the EC2 box |

After all four are saved, the next push to `main` will trigger a deploy. Watch progress at **GitHub → Actions tab**.

## One-time setup — EC2 box

The EC2 box also needs to be able to:

1. **Pull from GitHub** — works out of the box if the repo was cloned via HTTPS with a personal access token, OR via SSH with a deploy key on the box. If `git pull` already works manually, no change needed.
2. **Run `docker compose` without sudo** — the `EC2_USERNAME` user must be in the `docker` group:
   ```
   sudo usermod -aG docker ubuntu
   ```
   Log out and back in to apply.
3. **Have the project at the path** in `EC2_PROJECT_PATH`.
4. **Have a `.env` file** at the path the `docker-compose.yml` expects, with all production env vars set.

## How to deploy without a code change (rotate env vars, force restart, etc.)

GitHub → Actions → "Deploy to EC2" → "Run workflow" button → choose `main` branch → optionally check "skip_migrations" if you've already run them → "Run workflow".

## Required production env vars

Set these in `.env` on the EC2 box (NOT in GitHub Secrets — GitHub Secrets only carry the SSH key for deploy):

### Always required
- `SECRET_KEY` — JWT signing key, ≥32 chars
- `ADMIN_KEY` — admin API key, ≥16 chars
- `PHI_ENCRYPTION_KEY` — base64 32-byte AES-256 key
- `DATABASE_URL` — postgresql+asyncpg://...

### Vendor BAA gates (Wave A1 — startup refuses to start if true in prod without the BAA actually signed)
- `ASSEMBLYAI_BAA_CONFIRMED=true` ← **signed, safe to flip**
- `ANTHROPIC_BAA_CONFIRMED=true` ← signed, safe to flip
- `VONAGE_BAA_CONFIRMED` — leave default (unsigned at last check)

### Vendor secrets (Wave A1 — webhook signature verification)
- `VONAGE_SIGNATURE_SECRET=<from Vonage dashboard → Settings → Signature method=SHA-256 HMAC>`
- `STRIPE_SECRET_KEY=<live key>` (when ready for real payouts)
- `STRIPE_WEBHOOK_SECRET=<live webhook secret>` (when ready)
- `ASSEMBLYAI_API_KEY=<your live key>`
- `ANTHROPIC_API_KEY=<your live key>`

### PearSuite (real billing integration)
- `PEAR_SUITE_API_KEY=<production key>`
- `PEAR_SUITE_DEMO_TEMPLATE_ID=cb5875f0-444d-448f-9700-996c2ab65817`
- `PEAR_SUITE_DEMO_CHW_USER_ID=<set after rep gives Jemal's userId>`
- `PEAR_SUITE_DEFAULT_DX_CODES=["Z55.9"]`

### Safety guards (Wave A1 — sys.exit(1) at startup if true in production)
- `DISABLE_RATE_LIMIT` — leave **unset or false**

## Rollback

If a bad commit deploys:

```
# On EC2
cd $EC2_PROJECT_PATH
git log --oneline -10                   # find the previous good commit
git reset --hard <previous-commit-sha>
docker compose up -d --build
docker compose exec -T backend alembic downgrade -1   # only if a migration broke things
```

Or via the GitHub Action: revert the bad commit (`git revert <sha> && git push`), and the auto-deploy fixes itself.

## Future improvements (not required for first deploy)

- **CI pass gate**: change the deploy trigger to `workflow_run` after the `CI` workflow succeeds, so deploys only happen when tests pass.
- **Slack/Discord notifications** on deploy success/failure.
- **Blue/green or rolling**: today's deploy has ~5–10s of downtime during `docker compose up -d --build`. Acceptable for current scale.
- **Frontend smoke tests** post-deploy via a Playwright job.

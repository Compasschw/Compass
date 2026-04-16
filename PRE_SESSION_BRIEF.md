# Pre-Session Brief — Compass CHW

**Last session:** April 9–10, 2026
**Platform score:** ~7.5/10 (up from 6.2)
**Investor readiness:** ~5.5/10 (up from 4.0)

---

## Current State

- **Production:** Live at joincompasschw.com (Vercel) + api.joincompasschw.com (EC2/RDS)
- **Branch:** main, clean working tree
- **7 pages on real API**, golden path works end-to-end
- **AWS BAA:** Signed
- **CI:** Frontend + backend (pytest, ruff, mypy) in GitHub Actions
- **Communication layer:** Provider-agnostic architecture built, Vonage adapter ready for credentials

## Pending Migrations (Run on EC2 First)

Two Alembic migrations need to run before new features work in production:
```
docker exec compass-api alembic upgrade head
```
Or SSH in and run manually. Tables: `suggested_units` column + `communication_sessions` table.

---

## Priority Tasks for Next Session

### Tier 1 — Immediate (unblocks everything)

| # | Task | Time | Notes |
|---|------|------|-------|
| 1 | **Run pending migrations on EC2** | 15 min | Blocker for suggested_units + communication |
| 2 | **Wire remaining CHW pages** (Earnings, Profile) | 2 hrs | Earnings endpoint already returns real data, Profile endpoint exists |
| 3 | **Wire remaining Member pages** (Sessions, Profile, Roadmap) | 2–3 hrs | Sessions hook exists, Profile endpoint exists, Roadmap needs goals endpoint |

### Tier 2 — MVP Completeness

| # | Task | Time | Notes |
|---|------|------|-------|
| 4 | **Fix billing service_date bug** | 1 hr | `check_unit_caps` queries `created_at` instead of session service date |
| 5 | **Wire audit logging** | 2 hrs | AuditLog model + middleware exist but are disconnected |
| 6 | **Add pagination** to list endpoints | 2 hrs | `/sessions/`, `/requests/`, `/conversations/` |
| 7 | **Document upload in chat** | 2 hrs | S3 presigned URL API exists, link to conversation messages |

### Tier 3 — Investor Demo Polish

| # | Task | Time | Notes |
|---|------|------|-------|
| 8 | **Set up Vonage account** | 1 hr | Enables real masked calling — ask Jemal about budget |
| 9 | **Landing page testimonials** | 2 hrs | Needs real CHW quotes from conversations |
| 10 | **Demo mode banner** | 1 hr | Visible indicator when running with mock/demo data |
| 11 | **Encrypt medi_cal_id** | 2 hrs | AES-256 TypeDecorator on the model field |

---

## Key Context to Remember

- **Pear Suite integration confirmed** — meeting with CTO to capture API requirements
- **JT suggested RingCentral** — research showed it's wrong product (UCaaS not CPaaS), Vonage recommended instead
- **Subagents can't edit files** due to permission settings — do edits directly, use agents for research only
- **EC2 deploy flow:** `ssh -i ~/Downloads/compass-prod-key.pem ubuntu@35.82.234.140` → `cd /home/ubuntu/compass && git pull origin main && cd backend && docker build -t compass-api:latest . && docker stop compass-api && docker rm compass-api && docker run -d --name compass-api --restart unless-stopped --env-file .env -p 8000:8000 compass-api:latest`
- **Memory caution:** 16GB Mac, Docker was the main memory hog. Old containers cleared but may restart with Docker Desktop. Check with `docker ps` at session start.

---

## Reference Files

| File | Purpose |
|------|---------|
| `COMPASS_AUDIT_REPORT_2026-04-09.md` | Full audit, scores, 30-day game plan |
| `SESSION_SUMMARY_2026-04-09-10.md` | Last session recap |
| `docs/research/communication-platform-comparison.md` | Vonage vs Twilio vs Plivo |
| `docs/superpowers/plans/2026-04-08-phase1-backend-foundation.md` | Backend hardening tasks (partially complete) |
| `PROJECT_CONTEXT.md` | Full project context, team, financials |
| `COMPASS.md` | Mission, strategy, competitive analysis |

---

## Quick Health Checks to Run at Session Start

```bash
# Production API
curl -s https://api.joincompasschw.com/api/v1/health

# Frontend
curl -s -o /dev/null -w "%{http_code}" https://joincompasschw.com

# Local memory
memory_pressure | head -3

# Docker containers (stop old ones if restarted)
docker ps

# Git status
cd ~/Desktop/Projects/Compass && git status && git log --oneline -3
```

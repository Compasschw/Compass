# CompassCHW — Comprehensive Platform Audit Report

**Date:** April 9, 2026
**Prepared by:** Claude Code Audit Team (5 parallel agents)
**Audience:** Founding team (Akram, Jemal, JT) + future investor prep
**Live endpoints verified:** api.joincompasschw.com, joincompasschw.com

---

## Executive Summary

CompassCHW has a **working production deployment** with a polished frontend and a functional backend API (35 routes, live on AWS). The database design and iOS-readiness are standout strengths. However, the platform is currently a **demo-quality mockup with a real backend skeleton** — not yet a working MVP. The frontend renders mock data on 16+ pages with no toggle, the waitlist endpoint leaks all registrant PII, and HIPAA compliance is scaffolded but non-functional.

**Overall Platform Score: 6.2/10**

The path from 6.2 to 8.0 is achievable in 6-8 weeks with focused execution. The path from 4/10 investor readiness to 7/10 requires both code work AND customer discovery (20+ CHW conversations, real waitlist signups).

---

## Scorecard — All Dimensions

### Frontend (Avg: 5.9/10)

| Dimension | Grade | Verdict |
|-----------|-------|---------|
| Landing Page Quality | 6/10 | Clean design but hardcoded "247 joined" counter, no real testimonials or partner logos |
| Component Architecture | 7/10 | Good feature-based structure, but 16 files directly import mock data |
| TypeScript Quality | 8/10 | Zero `any` types, proper unions/enums. Missing Zod at API boundaries |
| Accessibility | 5/10 | Dashboard pages have ARIA, but landing page has zero semantic landmarks |
| Responsive Design | 7/10 | Mobile-first Tailwind, proper dvh units. No code splitting hurts mobile perf |
| Auth Flow | 7/10 | Real JWT flow works, but silent demo fallback masks backend failures |
| Error Handling | 6/10 | ErrorBoundary exists, but waitlist always shows success even on failure |
| Performance | 4/10 | No React.lazy(), no code splitting. Leaflet in initial bundle (~150kb gzipped) |
| Demo vs Production | 3/10 | No separation mechanism. Mock data hardwired into 16 files with no feature flag |

### Backend (Avg: 7.5/10)

| Dimension | Grade | Verdict |
|-----------|-------|---------|
| API Completeness | 7/10 | 35 routes live, but earnings returns hardcoded zeros, waitlist has no auth |
| Database Models | 7/10 | Proper Numeric(10,2) for money, good indexes. Role/status columns lack DB constraints |
| Auth Implementation | 8/10 | Argon2, hashed refresh tokens, rotation on use, is_active re-checked per request |
| Business Logic | 8/10 | Billing caps enforced, state machine works. Cap check uses created_at not service_date |
| Data Validation | 8/10 | Pydantic enums on most fields. Matching endpoint accepts raw string for vertical |
| Error Handling | 7/10 | Correct HTTP status codes. No global exception handler for unhandled DB errors |
| Config & Secrets | 9/10 | App refuses to start with weak secrets. Pydantic settings, .env loading |
| Middleware | 6/10 | CORS correct, audit logging exists. No rate limiting, no request correlation IDs |
| Database Layer | 8/10 | Async engine correct, rollback on exception. Missing pool_pre_ping for RDS failover |
| Migrations | 8/10 | 2 clean migrations, full downgrade support |
| Tests | 6/10 | 15 tests (auth + sessions). No billing, matching, or credential tests |
| Dependencies | 8/10 | Modern stack (FastAPI, SQLAlchemy 2, Pydantic v2). No lockfile for reproducible builds |

### Security & HIPAA (Avg: 5.0/10)

| Dimension | Grade | Verdict |
|-----------|-------|---------|
| Authentication & Authorization | 7/10 | Strong core, but no rate limiting on login/register |
| Input Validation & Injection | 7/10 | ORM prevents SQLi, Pydantic catches most. Upload endpoint has no validation |
| CORS Configuration | 8/10 | Explicit origin list, credentials allowed only with named origins |
| Secrets Management | 5/10 | Config is good, but .env may be in git history. No minimum key length enforcement |
| HTTP Security Headers | 7/10 | HSTS, X-Frame, nosniff present. CSP header is MISSING |
| File Upload Security | 3/10 | No MIME allowlist, no size limit, no filename sanitization |
| Dependency Vulnerabilities | 8/10 | All deps current. python-jose in soft maintenance |
| Data at Rest (HIPAA) | 4/10 | RDS has default encryption. medi_cal_id stored in plaintext — needs app-layer encryption |
| Data in Transit (HIPAA) | 7/10 | TLS via Nginx + Let's Encrypt. DATABASE_URL may not enforce sslmode=require |
| Audit Logging (HIPAA) | 3/10 | AuditLog model exists but is NEVER WRITTEN TO. Middleware logs to stdout, not DB |
| Access Controls (HIPAA) | 6/10 | Role-based routing works. CHWs can see all open request descriptions (minimum necessary violation) |
| Data Retention & Deletion | 1/10 | No deletion endpoint, no retention policy, no right-of-access mechanism |
| BAA Status | ?/10 | No documentation confirms AWS BAA has been signed |
| PHI Exposure Risk | 4/10 | Waitlist exposes all PII. Open requests leak member descriptions to all CHWs |

### Architecture & Infrastructure (Avg: 7.6/10)

| Dimension | Grade | Verdict |
|-----------|-------|---------|
| System Architecture | 8/10 | EC2 + Nginx + Docker + RDS is correct for HIPAA MVP |
| Backend Architecture | 8/10 | Clean layered design, proper async. Missing explicit pool config |
| Frontend Architecture | 8/10 | Feature-based folders, typed API client, proper routing |
| Database Design | 9/10 | Best dimension. Single-table inheritance, proper FK chains, Numeric money |
| CI/CD Pipeline | 4/10 | Frontend-only CI. Zero backend automation (no pytest, ruff, mypy, Docker build) |
| Deployment Configuration | 8/10 | Multi-stage Dockerfile, non-root user, security headers in vercel.json |
| Error Recovery & Resilience | 6/10 | Container restarts on crash. No pool_pre_ping, no circuit breakers |
| Scalability Path | 8/10 | Clean migration to ECS Fargate + ALB. Stateless workers, no shared memory |
| iOS App Readiness | 9/10 | Versioned API, UUID PKs, bearer auth, proper refresh flow for mobile |

### Investor Readiness: 4/10

---

## CRITICAL Findings — Fix Before Any Demo

These are the items that would embarrass the team in front of investors or create immediate security risk:

| # | Finding | Location | Fix Time |
|---|---------|----------|----------|
| C1 | **Waitlist endpoint exposes all PII without auth** | `backend/app/routers/waitlist.py:37` | 10 min |
| C2 | **No file type/size validation on S3 uploads** | `backend/app/routers/upload.py` | 30 min |
| C3 | **Audit log model exists but is never written to** | `backend/app/middleware/audit.py` | 2 hrs |
| C4 | **`.env` may be in git history** | `backend/.env` | 15 min |
| C5 | **Landing page "247 joined" counter is hardcoded** | `web/src/.../WaitlistLandingPage.tsx:153` | 15 min |
| C6 | **No code splitting — entire app in initial bundle** | `web/src/App.tsx` | 30 min |
| C7 | **Admin waitlist route has no auth guard** | `web/src/App.tsx:212` | 5 min |

## HIGH Findings — Fix Before Production Users

| # | Finding | Location | Fix Time |
|---|---------|----------|----------|
| H1 | No rate limiting on `/auth/login` or `/auth/register` | Missing slowapi | 1 hr |
| H2 | No minimum SECRET_KEY length enforcement | `backend/app/config.py:27` | 5 min |
| H3 | CHW requests endpoint leaks all member descriptions | `backend/app/routers/requests.py:14` | 1 hr |
| H4 | `medi_cal_id` stored in plaintext | `backend/app/models/user.py:53` | 2 hrs |
| H5 | No Content-Security-Policy header | `web/vercel.json` | 15 min |
| H6 | Billing cap check uses `created_at` not `service_date` | `backend/app/services/billing_service.py:49` | 1 hr |
| H7 | No backend CI (pytest, ruff, mypy) | `.github/workflows/ci.yml` | 2 hrs |
| H8 | Member consent doesn't capture IP/user-agent | `backend/app/routers/sessions.py:150` | 15 min |
| H9 | `create_session` doesn't verify member owns the request | `backend/app/routers/sessions.py:33` | 15 min |
| H10 | No `pool_pre_ping` — RDS failover kills connections silently | `backend/app/database.py` | 5 min |

---

## What's Actually Working End-to-End

| Flow | Status | Details |
|------|--------|---------|
| Waitlist signup | Partial | API works, but localStorage fallback always shows "success" |
| User registration | Working | Real JWT, Argon2, stored in RDS |
| User login | Working | Access + refresh tokens, proper 401 on bad creds |
| Token refresh | Working | Rotation on use, old token revoked |
| Health checks | Working | `/health` and `/ready` both respond correctly |
| Frontend → Backend proxy | Working | `/_proxy` path routes through Vercel to API |
| DNS + TLS | Working | Both domains resolve, HTTPS enforced |

## What's Mock/Stub Only

| Feature | Status | What's Missing |
|---------|--------|----------------|
| CHW Dashboard | Mock | All data from `data/mock.ts`, always shows "Maria Reyes" |
| Member Dashboard | Mock | Hardcoded profiles, no real API calls |
| Session Booking | Mock | UI exists, "Schedule" button shows toast only |
| Earnings | Stub | Backend returns hardcoded zeros |
| Matching Algorithm | Stub | Routes exist, scoring logic exists, not wired to real queries |
| Billing/Claims | Backend only | Session docs + billing claims write to DB, no frontend integration |
| Messaging | Scaffold | API routes exist, no frontend wiring |
| Credential Verification | Backend only | Validate/review endpoints work, no frontend flow |
| Map/Resources | Mock | Hardcoded LA coordinates, no real geocoding |
| Rewards System | Mock | Display only, no backend |
| Admin Dashboard | Mock | Unprotected route, shows waitlist data |

---

## Investor Demo Strategy

### What Will Impress (Lead With These)

1. **The live API** — show Swagger docs at `api.joincompasschw.com/docs`. 35 endpoints, live health checks, real database. This communicates technical seriousness.
2. **The CHW onboarding wizard** — 4-step flow with ICD-10 code selection, vertical specialization. Shows healthcare domain depth.
3. **The billing math** — Medi-Cal unit calculations with Decimal precision, cap enforcement. Shows regulatory understanding.
4. **The landing page design** — warm, professional, healthcare-appropriate. Not a generic SaaS template.
5. **Mobile-responsive layout** — show it on a phone. The sidebar-to-bottom-nav transition is smooth.

### What Will Embarrass (Fix or Avoid)

1. Hard refresh loses the session — auth state desynchronizes between two localStorage keys
2. The "247 people" counter never changes
3. Clicking through the CHW dashboard always shows "Maria Reyes" regardless of who logged in
4. The waitlist form bottom CTA sends `first_name: 'N/A'`, `last_name: 'N/A'`
5. No visible "Demo Mode" indicator — investor may think they're seeing real data
6. The `/admin/waitlist` route is accessible without login

---

## 30-Day Game Plan — From 4/10 to 7/10 Investor Ready

### Week 1: Critical Fixes + Customer Discovery (Parallel Tracks)

**Engineering (Akram):**
- [ ] Fix C1: Lock waitlist endpoint behind admin auth
- [ ] Fix C5: Replace hardcoded counter with real API call to `/waitlist/count`
- [ ] Fix C6: Add `React.lazy()` to all routes in App.tsx
- [ ] Fix C7: Guard admin route
- [ ] Fix H5: Add CSP header to vercel.json
- [ ] Fix H10: Add `pool_pre_ping=True` to database.py
- [ ] Add visible "Demo Mode" banner when running with mock data

**Business (Jemal + JT):**
- [ ] Schedule 20 CHW conversations (LA County CHW Association, community clinics, Facebook groups)
- [ ] Prepare 3 questions: Would you use this? What blocks you? What's your current workflow?
- [ ] Document every conversation with quotes

### Week 2: Wire Frontend Auth + Backend CI

**Engineering:**
- [ ] Wire LoginPage and RegisterPage to real backend (Task 5 from backend foundation plan)
- [ ] Add AuthContext token reconciliation on mount
- [ ] Add backend CI job (pytest + ruff + mypy + Docker build smoke test)
- [ ] Add rate limiting on auth endpoints (slowapi)
- [ ] Fix H6: Add `service_date` column to BillingClaim, fix cap query

**Business:**
- [ ] Continue CHW conversations (target: 20 total by end of week 2)
- [ ] Draft 3 LOIs for willing CHWs to sign
- [ ] Begin Pear Suite outreach for integration timeline

### Week 3: One End-to-End Session Flow

**Engineering:**
- [ ] Build the "golden path": Member submits request → CHW accepts → Session created → Session completed → Billing claim generated
- [ ] Wire one dashboard page to real data (CHW Requests is the easiest win)
- [ ] Fix H3: Redact member descriptions in open requests
- [ ] Fix H9: Verify member owns request before session creation
- [ ] Add pagination to list endpoints

**Business:**
- [ ] Compile CHW conversation findings into pitch deck slide
- [ ] Get 50+ real waitlist signups (LinkedIn, community groups, direct outreach)
- [ ] Sign AWS BAA (prerequisite for any real data)

### Week 4: Polish + Pitch Prep

**Engineering:**
- [ ] Landing page: Add real testimonial quotes from CHW conversations
- [ ] Landing page: Add partner/institutional logos if any relationships exist
- [ ] Fix audit logging: Wire user identity into AuditLog writes
- [ ] Add semantic HTML landmarks to landing page (a11y)
- [ ] Fix consent capture: Populate IP + user-agent fields

**Business:**
- [ ] Finalize pitch deck with traction metrics (waitlist count, CHW conversations, LOIs)
- [ ] Build cost model (CAC, platform cost per session, burn rate)
- [ ] Practice the demo flow end-to-end 5 times
- [ ] Identify 1 Medi-Cal billing advisor for advisory board

---

## iOS App Planning — Pre-Sprint Checklist

The API is well-positioned for iOS (9/10 readiness). Before starting the iOS build:

| Prerequisite | Status | Notes |
|--------------|--------|-------|
| API versioning (/api/v1/) | Done | Clean versioned paths |
| UUID primary keys | Done | No integer ID leakage |
| Bearer token auth | Done | Standard Authorization header |
| Refresh token flow | Done | 15-min access + 7-day refresh, perfect for mobile |
| Pagination on list endpoints | NOT DONE | Required for infinite scroll — add `{items, total, page, page_size}` envelope |
| Push notification infrastructure | NOT DONE | Need APNs integration + backend notification service |
| Offline-first data strategy | NOT DONE | Define what data is cached locally, conflict resolution |
| App Store health privacy labels | NOT DONE | Required for submission — list all data types collected |
| Keychain token storage | N/A | iOS implementation detail, but API supports it |

**Recommendation:** Do NOT start the iOS build until the "golden path" works end-to-end on web. The iOS app should consume a proven API, not be developed in parallel with an unstable backend.

---

## HIPAA Compliance Roadmap

| Requirement | Status | Priority |
|-------------|--------|----------|
| AWS BAA signed | Unknown | BLOCKER — verify or sign immediately |
| RDS encryption at rest | Done (default) | - |
| TLS everywhere | Done | Verify sslmode=require on DATABASE_URL |
| Audit logging (who accessed what) | NOT DONE | Week 3 — wire AuditLog model to middleware |
| Application-layer PHI encryption | NOT DONE | medi_cal_id needs AES-256 TypeDecorator |
| Minimum necessary access controls | Partial | Requests endpoint leaks too much; fix redaction |
| Right of access / deletion | NOT DONE | Add DELETE /member/account before real users |
| Workforce HIPAA training | NOT DONE | Akram, Jemal, JT must complete before accessing PHI |
| CloudWatch 365-day log retention | NOT DONE | Configure after CloudWatch is set up |
| S3 PHI bucket access logging | NOT DONE | Enable server access logging to audit bucket |

**Important:** The system currently stores NO real PHI — all data is mock/demo. Do NOT introduce real member data until the BAA is signed and the audit logging is functional.

---

## Architecture Diagram — Current State

```
                    joincompasschw.com
                          |
                     [Vercel CDN]
                    React 19 + Vite
                   /_proxy rewrite
                          |
                          v
              api.joincompasschw.com
                          |
                 [GoDaddy DNS → A record]
                          |
                    [EC2 t3.micro]
                   Ubuntu 24.04 LTS
                    Nginx (TLS/SSL)
                   Let's Encrypt cert
                          |
                    [Docker container]
                  FastAPI + Uvicorn (2 workers)
                  35 API routes, audit middleware
                          |
                    [RDS PostgreSQL 16]
                    db.t3.micro (free tier)
                    20+ tables, 2 migrations
                          |
                    [S3 us-west-2]
                compass-phi-prod (PHI, private)
              compass-public-prod (images, public)
                          |
                  [SSM Parameter Store]
                   All secrets as SecureString
```

---

## Final Assessment

| Dimension | Score |
|-----------|-------|
| Frontend | 5.9/10 |
| Backend | 7.5/10 |
| Security & HIPAA | 5.0/10 |
| Architecture | 7.6/10 |
| Investor Readiness | 4.0/10 |
| **Overall Platform** | **6.2/10** |

**Bottom line:** CompassCHW has the right idea, the right market, a capable technical founder, and a solid architectural foundation. The database design and API structure are genuinely strong — this is not a prototype that needs to be rewritten. The gap is execution: wiring the frontend to the real backend, fixing the security critical items, and — most importantly — talking to 20 real CHWs. The code work is 6-8 weeks. The customer discovery should start tomorrow.

---

*This report should be referenced as the baseline for all future development sprints. Re-audit after completing the 30-day game plan to measure progress.*

# Compass CHW — Full Audit Report
## Raising to YC Startup Standard

**Date:** 2026-04-08
**Auditor:** Claude Code + gstack
**Repo:** github.com/Compasschw/Compass
**Stack:** React 19 + TypeScript 5.9 + Vite + Tailwind CSS 4 + Leaflet
**Status:** Frontend mockup complete, backend not started

---

## Executive Summary

Compass has a **strong frontend foundation** with well-typed components, thoughtful UX for both CHW and Member roles, and a clear product vision documented in COMPASS.md. But it's a prototype, not a product. To reach YC standard, it needs: real auth, a backend, tests, CI/CD, security hardening, and polish on the landing page.

**Overall Score: 5.5/10** (frontend alone: 7.5/10)

---

## SECTION 1: CRITICAL ISSUES (Fix Immediately)

### CRIT-1: Vite 8.0.1 had 3 HIGH CVEs
- **Status:** FIXED during this audit (upgraded to 8.0.5+)
- Path traversal, arbitrary file read via WebSocket, server.fs.deny bypass
- **Why it matters:** Anyone running the dev server was exposed

### CRIT-2: Auth state is in-memory only — no persistence
- **File:** `web/src/features/auth/AuthContext.tsx`
- Auth state lives in React `useState`. Refreshing the page or navigating via URL loses the session entirely
- Every protected route (`/chw/*`, `/member/*`) redirects to `/login` on hard refresh
- **Why it matters:** Demo-breaking for investors. Any real user testing will fail immediately. A YC partner clicking a shared link to `/chw/dashboard` sees a login page with no way to proceed
- **Fix:** At minimum, persist to `sessionStorage`. For production: JWT + httpOnly cookies + refresh tokens

### CRIT-3: No backend exists
- Zero API endpoints. All data is hardcoded in `web/src/data/mock.ts`
- The waitlist form has no submission handler — clicking "Join the Waitlist" navigates to `/landing` instead of capturing the email
- **Why it matters:** You're collecting zero waitlist signups right now. That form is the single most important conversion point and it does nothing
- **Fix:** At minimum, connect the waitlist form to a Google Sheet, Airtable, or Supabase table. This is a 30-minute fix that starts collecting leads today

### CRIT-4: No test infrastructure at all
- Zero test files. No Vitest, no Jest, no Playwright, no Cypress
- No test configs, no `__tests__` directories, no `.test.tsx` files
- **Why it matters:** YC expects engineering discipline. "We don't have tests" is a red flag in due diligence. More practically, you can't refactor safely without tests

---

## SECTION 2: QA FINDINGS (Browser Testing)

### QA-1: Landing page sections invisible on initial load [HIGH]
- **Route:** `/landing` (WaitlistLandingPage)
- The "What We Cover", stats section, and "How It Works" sections use `useScrollAnimation` and render invisible until scroll triggers them
- On first load at 1280x720 viewport, ~60% of the page appears blank (huge white/dark gaps)
- **Why it matters:** First impression is everything. An investor or user sees a half-empty page and bounces
- **Fix:** Remove or reduce the scroll animation threshold, or make sections visible by default with animation as enhancement

### QA-2: Landing page variants are NOT differentiated [HIGH]
- **Routes tested:** `/landing/v2`, `/landing/v3` — these hit the catch-all and redirect to `/`
- **Actual routes:** `/landing/a`, `/landing/b`, `/landing/c` exist in `App.tsx` but the initial load shows the same hero + blank pattern
- The docs reference "3 landing page variants" but they appear visually identical at first glance
- **Why it matters:** A/B testing is only valuable if the variants are actually different

### QA-3: Footer links are all broken [MEDIUM]
- Privacy, Terms, HIPAA, Contact links all point to `/landing#` (empty hash)
- **Why it matters:** Broken footer links signal unfinished product. For a healthcare app claiming HIPAA compliance, a broken HIPAA link is especially bad optics

### QA-4: Waitlist form pre-filled with placeholder data [MEDIUM]
- First Name: "Maria", Last Name: "Garcia", Email: "maria@example.com"
- These look like real data, not placeholder text. Users may think the form is already filled out
- **Fix:** Use proper HTML `placeholder` attributes instead of `defaultValue`

### QA-5: Profile page has large blank sections [LOW]
- CHW Profile (`/chw/profile`) shows Languages section with content invisible below fold
- Credentialing section buttons (Upload New, Request New) float in empty space
- **Fix:** Check that sections render content before their action buttons

### QA-6: No 404 page [LOW]
- Invalid URLs redirect to `/` via catch-all (`<Route path="*">`)
- **Why it matters:** Silent redirects confuse users. A proper 404 helps with debugging and UX

### QA-7: Zero console errors across all routes [POSITIVE]
- Clean console on every page tested. No React warnings, no failed network requests
- This is good engineering hygiene

---

## SECTION 3: DESIGN REVIEW

### Design Strengths
- **Warm, trustworthy palette** — #2C3E2D primary with cream backgrounds feels approachable for a healthcare app
- **Clear role separation** — CHW and Member experiences use distinct accent colors (gold vs sage)
- **Dashboard layout** is clean with good stat cards, color-coded badges, and clear hierarchy
- **Calendar** is well-executed with color-coded events per member/activity type
- **Earnings page** has great information density — pending payout, scenario table, career stats

### Design Weaknesses

| Issue | Severity | Details |
|-------|----------|---------|
| **Landing page trust gap** | HIGH | No real testimonials, no team photos, no partner logos. "247 people joined" is hardcoded and looks fake. A healthcare app needs visible trust signals (HIPAA badge links to nothing, no BAA mention, no security page) |
| **No loading states** | HIGH | No skeleton screens, no spinners, no shimmer effects. When the backend exists, users will see blank pages during data fetching |
| **No empty states** | MEDIUM | What does the member see with 0 sessions? What does a new CHW see with 0 requests? Empty states are a key UX moment |
| **No error states** | MEDIUM | No error boundaries, no "something went wrong" UI, no retry buttons |
| **Map tiles load without placeholder** | MEDIUM | Leaflet maps show a gray box while tiles load. No loading indicator |
| **Mobile hamburger menu missing** | MEDIUM | Nav links (Services, How It Works) are `hidden md:flex` — completely invisible on mobile. The mobile nav only shows "Join Waitlist" button |
| **Onboarding has no progress persistence** | LOW | Refreshing the onboarding wizard loses all progress (same auth state issue) |
| **No dark mode** | LOW | Not blocking, but expected for modern apps |

### Design Recommendations for YC Standard
1. **Add real social proof** — even 3 real testimonials from CHWs or community orgs beats 50 fake ones
2. **Add team section** — investors want to see who's building this
3. **Add a "How billing works" explainer** — the Medi-Cal reimbursement model is your moat, explain it clearly
4. **Implement skeleton loading** — 5 lines of Tailwind per component, massive perceived performance win
5. **Build error boundaries** — one `ErrorBoundary` wrapper catches the whole app

---

## SECTION 4: SECURITY AUDIT

### Severity: CRITICAL

| Finding | Severity | Details |
|---------|----------|---------|
| **No authentication backend** | CRITICAL | AuthContext is purely in-memory. No JWT, no session tokens, no cookies. Any "protected" route is accessible by anyone who can type a URL once a backend exists without proper guards |
| **Mock medical data in client bundle** | HIGH | `mock.ts` contains realistic ICD-10 codes (Z59.1, Z71.89), CPT codes (98960-98962), member names, phone numbers, zip codes, billing rates. This ships in the production JS bundle and is visible to anyone who opens DevTools |
| **No CSP headers** | HIGH | No Content-Security-Policy configured in `vercel.json` or `index.html`. XSS would have full access |
| **No CORS configuration** | MEDIUM | Not relevant yet (no backend), but needs to be first thing configured on FastAPI |
| **OpenStreetMap tiles loaded over HTTPS** | LOW | Good — no mixed content. But tile requests leak user viewport/location to OSM servers |
| **Hardcoded phone numbers and emails** | MEDIUM | `mock.ts` contains `(323) 555-0192`, `maria.reyes@compasschw.org` — if these are real, they're now public on GitHub |
| **No rate limiting planned** | MEDIUM | The waitlist form (once functional) has no CAPTCHA or rate limiting |

### HIPAA Compliance Gap Analysis

| Requirement | Status | Gap |
|-------------|--------|-----|
| PHI encryption at rest | NOT IMPLEMENTED | Need AES-256 on database + S3 |
| PHI encryption in transit | PARTIAL | Vercel serves HTTPS, but no backend TLS configured |
| Audit logging | NOT IMPLEMENTED | Need pgaudit + CloudWatch |
| Access controls (RBAC) | NOT IMPLEMENTED | AuthContext has role field but no enforcement |
| Business Associate Agreement | NOT STARTED | Need BAA with AWS, Vercel, any analytics provider |
| Minimum necessary standard | VIOLATED | mock.ts exposes all data to all roles — no field-level access control |
| Breach notification plan | NOT DOCUMENTED | Required within 60 days of discovery |
| Employee training | NOT DOCUMENTED | All team members handling PHI need HIPAA training records |

**Bottom line:** You cannot launch with real patient data until HIPAA infrastructure exists. The mock data approach is fine for demo, but the moment you collect real names + health conditions, you're subject to HIPAA and penalties up to $50K per violation.

---

## SECTION 5: ENGINEERING ARCHITECTURE

### Strengths
- **TypeScript strict mode** — `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` all enabled
- **Feature-based directory structure** — clean separation of CHW, Member, landing, onboarding, shared
- **Well-typed data layer** — `mock.ts` has comprehensive type definitions that will translate directly to API response types
- **React 19** — latest stable, good foundation
- **Small dependency footprint** — only 7 production deps, minimal attack surface

### Weaknesses

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| **No code splitting / lazy loading** | Bundle ships all routes upfront. With 43 components, this is ~200KB+ that could be split | Use `React.lazy()` + `Suspense` for route-level splitting |
| **No ErrorBoundary** | Any component crash takes down the whole app | Add `ErrorBoundary` at route level minimum |
| **ProtectedRoute doesn't check role** | A Member can access `/chw/dashboard` and vice versa — only checks `isAuthenticated` | Add role-based route guards |
| **All routes eagerly imported** | Every page component is imported at the top of `App.tsx` | Lazy import behind route boundaries |
| **No data fetching layer** | When backend exists, there's no SWR, React Query, or fetch abstraction ready | Add TanStack Query (React Query) now — it works with mock data too |
| **Repeated ProtectedRoute wrapping** | Each route has identical `<ProtectedRoute>` wrapping instead of nested route layout | Use React Router layout routes (`<Route element={<ProtectedRoute />}>` with `<Outlet />`) |
| **No form validation library** | Onboarding and registration forms have no validation beyond HTML required | Add react-hook-form + zod for validation |

---

## SECTION 6: BACKEND & INFRASTRUCTURE (What Needs to Be Built)

### Priority 1: MVP Backend (Week 1-2)
| Component | Effort | Details |
|-----------|--------|---------|
| **Waitlist API** | Small | POST `/api/waitlist` — collect email, name, role. Store in PostgreSQL. Send confirmation email |
| **FastAPI scaffold** | Small | Project structure, CORS, health check, error handling |
| **PostgreSQL schema** | Medium | Users, CHWs, Members, Requests, Sessions, Earnings tables derived from mock.ts types |
| **JWT Authentication** | Medium | Register, login, refresh token, password hashing (bcrypt), httpOnly cookies |
| **Basic CRUD endpoints** | Medium | CHW profile, Member profile, Service requests |

### Priority 2: Core Features (Week 3-4)
| Component | Effort | Details |
|-----------|--------|---------|
| **Matching algorithm** | Medium | Geographic proximity (PostGIS), language match, specialization match, availability |
| **Session lifecycle** | Medium | Request → Accept → Schedule → In-Progress → Complete → Document |
| **File uploads** | Medium | S3 for profile pictures, credentialing docs, session recordings |
| **Email notifications** | Small | Session reminders, request notifications (SendGrid or SES) |

### Priority 3: Compliance & Billing (Week 5-8)
| Component | Effort | Details |
|-----------|--------|---------|
| **HIPAA infrastructure** | Large | Encryption, audit logging, access controls, BAA agreements |
| **Billing integration** | Large | Pear Suite API proxy (Phase 1), EDI 837 claims (Phase 2) |
| **Payment processing** | Medium | CHW payout calculations, Stripe Connect or similar |

### Priority 4: DevOps (Parallel)
| Component | Effort | Details |
|-----------|--------|---------|
| **CI/CD pipeline** | Small | GitHub Actions: lint, type-check, test, deploy |
| **Vitest setup** | Small | Unit tests for components + integration tests for hooks |
| **Playwright E2E** | Medium | Critical path tests: login, onboarding, session booking |
| **AWS infrastructure** | Medium | RDS, ECS/Fargate, S3, Secrets Manager, CloudWatch |
| **Monitoring** | Small | Sentry for error tracking, basic health checks |

---

## SECTION 7: DOCUMENTATION GAPS

| Document | Status | Impact |
|----------|--------|--------|
| **README.md** | 9 bytes ("# Compass") | Investor/contributor first impression. Needs: what it is, how to run, architecture, team |
| **COMPASS.md** | Excellent (20KB) | Great strategy doc. Keep this |
| **PROJECT_CONTEXT.md** | Excellent (15KB) | Good onboarding doc. Keep this |
| **ARCHITECTURE.md** | Missing | Need system design, data flow, API spec once backend exists |
| **CONTRIBUTING.md** | Missing | Team onboarding, PR process, code style |
| **.env.example** | Missing | What environment variables are needed |
| **HIPAA compliance doc** | Missing | Required for healthcare, good for investor confidence |
| **API specification** | Missing | OpenAPI/Swagger spec once backend exists |

---

## SECTION 8: WHAT GSTACK CAN DO RIGHT NOW

| When | Skill | What it does for Compass |
|------|-------|--------------------------|
| **Now** | `/qa` | Re-run QA and auto-fix the issues found in this report |
| **Now** | `/cso` | Deep security audit with active verification |
| **Now** | `/design-review` | Fix visual inconsistencies across all routes |
| **Now** | `/design-consultation` | Generate a formal DESIGN.md with your token system |
| **Now** | `/benchmark` | Baseline Core Web Vitals before adding backend |
| **Before backend** | `/plan-eng-review` | Lock in API design, DB schema, auth flow |
| **Before backend** | `/plan-ceo-review` | Challenge product assumptions with YC lens |
| **Each PR** | `/review` | Automated diff review for security + quality |
| **Each PR** | `/ship` | PR creation with VERSION bump and CHANGELOG |
| **After deploy** | `/canary` | Monitor production for errors and regressions |
| **Weekly** | `/retro` | Engineering retrospective from git history |

---

## SECTION 9: PRIORITIZED ACTION PLAN

### This Week (Hours, Not Days)
1. [ ] **Connect waitlist form to real storage** — Supabase, Airtable, or Google Sheets (30 min)
2. [ ] **Fix landing page scroll animations** — make sections visible by default (15 min)
3. [ ] **Add sessionStorage auth persistence** — survive page refreshes in demo (15 min)
4. [ ] **Fix footer links** — add Privacy/Terms/HIPAA placeholder pages (30 min)
5. [ ] **Add role-based route guards** — prevent CHW accessing Member routes (15 min)
6. [ ] **Write a real README.md** — what it is, how to run, screenshot, team (1 hr)
7. [ ] **Set up Vitest** — even 5 smoke tests is better than zero (1 hr)

### This Month
8. [ ] FastAPI backend scaffold with JWT auth
9. [ ] PostgreSQL schema from mock.ts types
10. [ ] GitHub Actions CI/CD (lint + type-check + test)
11. [ ] Connect frontend to real API (replace mock data)
12. [ ] Playwright E2E tests for critical paths
13. [ ] Sentry error tracking
14. [ ] Design system formalization (DESIGN.md via `/design-consultation`)

### Before Launch
15. [ ] HIPAA compliance infrastructure (encryption, audit logs, BAA)
16. [ ] Billing integration (Pear Suite API)
17. [ ] Payment processing for CHW payouts
18. [ ] Security penetration testing
19. [ ] Load testing
20. [ ] HIPAA compliance documentation

---

## Score Breakdown

| Category | Score | YC Standard | Gap |
|----------|-------|-------------|-----|
| Frontend Code Quality | 8/10 | 8/10 | At standard |
| Design & UX | 6/10 | 8/10 | Trust signals, empty/error states, loading |
| Backend | 0/10 | 7/10 | Nothing built yet |
| Authentication | 1/10 | 8/10 | Mock only, no persistence |
| Testing | 0/10 | 7/10 | Zero tests |
| Security | 2/10 | 8/10 | No implementation |
| CI/CD | 0/10 | 7/10 | No pipeline |
| Documentation | 6/10 | 7/10 | Strategy great, technical missing |
| HIPAA Compliance | 1/10 | 9/10 | Healthcare requires near-perfect |
| **Overall** | **5.5/10** | **8/10** | **Significant work needed** |

---

*Generated by Claude Code + gstack QA audit. Screenshots saved in `.gstack/qa-reports/screenshots/`.*

# CompassCHW — Full Project Context

> Load this file at the start of any new Claude session to resume work on the CompassCHW project.
> Last updated: April 6, 2026

---

## What is CompassCHW?

CompassCHW is the **first gig-economy marketplace for Community Health Workers (CHWs)**. It connects certified CHWs with community members who need help navigating housing, food, addiction recovery, mental health, and healthcare systems — through a flexible work model, billing through California Medi-Cal.

**Founded by:**
- **Akram Mahmoud** — Co-Founder & CTO (Product, Engineering, Architecture)
- **Jemal Hussein** — Co-Founder & CEO (Strategy, Operations, Partnerships)
- **John Thomas (JT)** — Co-Founder & CDO (Design, User Experience, Brand)

**Domain:** joincompasschw.com (registered on GoDaddy)
**Business email:** akram.mahmoud-eng@joincompasschw.com (Google Workspace)

---

## Billing & Financial Model

### Medi-Cal CHW Reimbursement
- **Rate:** $26.66/unit (1 unit = 30 min, triggerable at 15 min)
- **Limits:** Max 4 units/member/day, 10 units/member/year
- **Annual billing ceiling:** $266.60/member-relationship
- **Key insight:** W-2 employment model is structurally inefficient — CHWs need member *volume*, not time depth. The matching engine is the structural answer.

### Revenue Split — Phase 1 (Pear Suite Integration)
- Medicaid pays: $26.66
- Pear Suite takes 15%: –$4.00
- CompassCHW takes 10–15%: –$2.67–$4.00
- **CHW receives: $18.66–$20.00/unit**

### Revenue Split — Phase 2 (Proprietary Billing)
- Medicaid pays: $26.66
- Pear Suite: $0.00
- CompassCHW takes 15–20%: –$4.00–$5.33
- **CHW receives: $21.33–$22.66/unit**

### Phase 2+ — ECM Services
- Enhanced Care Management (ECM) at **$386 PMPM**
- Contingent on TENA completing ECM provider enrollment with LA Care, Molina, Health Net, ILS/Kaiser
- TENA's existing ECM infrastructure and MCP relationships serve as the anchor contract pathway

### CHW Daily Earnings Scenarios
| Scenario | Units/day | Gross/day | Net P1 | Net P2 |
|----------|-----------|-----------|--------|--------|
| Light (2 members × 1 unit) | 2 | $53.32 | $38.54 | $43.98 |
| Moderate (4 members × 2 units) | 8 | $213.28 | $154.16 | $175.94 |
| Full (6 members × 3 units) | 18 | $479.88 | $346.86 | $395.91 |
| Max daily (5 members × 4 units) | 20 | $533.20 | $385.40 | $439.89 |

### ICD-10 Diagnosis Codes (Z-Codes for SDOH)
CHW must select 1+ for billing claims:
- Z71.89 — Other specified counseling, wellness visits
- Z59.12 — Utility Insecurity
- Z72.3 — Lack of physical exercise
- Z75.3 — Unavailability/inaccessibility of health-care facilities
- Z59.00 — Living Situation, unspecified
- Z59.89 — Other problems related to housing/economic circumstances
- Z55.6 — Problems related to health literacy
- Z59.9 — Housing/economic circumstances, unspecified
- Z59.86 — Financial insecurity (Archived)
- Z65.3 — Problems related to other legal circumstances

### CPT Procedure Codes
- 98960 U2 — CHW Service 1 Person (1 person)
- 98961 U2 — CHW Service 2-4 People (2-4 people)
- 98962 U2 — CHW Service 5-8 People (5-8 people)

---

## 5 Service Verticals
1. **Housing Assistance** — shelter, transitional housing, rental assistance, eviction prevention
2. **Rehab & Addiction Recovery** — SUD navigation, treatment facilities, recovery support
3. **Food & Pantry Navigation** — food banks, SNAP/WIC, community nutrition
4. **Mental Health Support** — counseling referrals, crisis navigation, support groups
5. **Healthcare Navigation** — insurance enrollment, PCP matching, health literacy

---

## Architecture Decisions Made

### Single App vs Dual App
**Decision: Single app with clean module separation for MVP.** Uber split after 5 years with a large team. At founding stage with 3 people, maintain one web app + one iOS app with strict `Features/CHW/` and `Features/Member/` module separation (zero cross-imports). Revisit split at 18-24 months.

### Tech Stack
- **Web app:** TypeScript/React + Vite + Tailwind CSS v4 + react-router-dom + lucide-react + leaflet
- **iOS app:** Swift/SwiftUI (Phase 2)
- **Backend:** Python/FastAPI + Pydantic + SQLAlchemy (async) + Alembic
- **Database:** AWS RDS PostgreSQL (HIPAA-compliant)
- **Cloud:** AWS (us-west-2 Oregon)
- **Frontend hosting:** Vercel (free tier) → joincompasschw.com

### Database
**AWS RDS PostgreSQL** on db.t4g.small ($58/mo) — native BAA, pgaudit for audit trails, AES-256 encryption, SQLAlchemy-native. Start on Free Tier db.t3.micro ($0 for 12 months).

### AWS Phase 1 Infrastructure (~$130-159/mo production, ~$4/mo free tier)
- RDS PostgreSQL: $58/mo (or free tier $0)
- ECS Fargate: $20/mo (or EC2 free tier $0)
- ALB: $22/mo (skip for MVP — use nginx on EC2)
- NAT Gateway: $32/mo (skip for MVP — public subnet + SG)
- S3 + KMS: $7/mo
- CloudFront: $3/mo (skip — use Vercel)
- Secrets Manager: $2/mo (use SSM Parameter Store free)
- CloudWatch: $10/mo (basic free for MVP)
- SES: $1/mo
- Twilio SMS: $4/mo

**Lean MVP actual need: ~$62/mo** (RDS + S3 + SES + Twilio, EC2 free tier for compute)

---

## Current Project Structure

```
/Users/akrammahmoud/Compass/
├── COMPASS.md                           # Mission & strategy document (source of truth)
├── COMPASS.pdf                          # PDF version
├── COMPASS.docx                         # Word version
├── CompassCHW_AWS_Cost_Breakdown.xlsx   # AWS cost analysis spreadsheet
├── PROJECT_CONTEXT.md                   # THIS FILE
├── design/
│   ├── Compass CHW Prototype.pptx       # JT's iOS mockup slides (4 screens)
│   ├── COMPASS CHW.docx                 # Jemal's tracked changes v1
│   ├── COMPASS CHW.docx.pdf             # PDF of v1
│   └── COMPASS CHW.docx (1).pdf         # v2 with procedure codes
├── web/                                 # React/TypeScript frontend (BUILT)
│   ├── src/
│   │   ├── app/
│   │   ├── features/
│   │   │   ├── auth/                    # Login, Register, AuthContext
│   │   │   ├── landing/                 # 3 landing page variants (A selected)
│   │   │   ├── onboarding/             # CHW + Member onboarding wizards
│   │   │   ├── chw/                    # Dashboard, Requests, Sessions, Earnings, Calendar, Profile
│   │   │   └── member/                 # Home, Find CHW, Sessions, Roadmap, Calendar, Profile
│   │   ├── shared/components/          # Layout, Sidebar, BottomNav, Badge, StatCard, MapView, etc.
│   │   └── data/mock.ts               # ALL types + mock data (single source of truth)
│   ├── package.json
│   └── vite.config.ts
├── ios-preview/                         # iOS mockup in iPhone 15 Pro frame (BUILT)
│   └── (same structure as web, iOS-native styling)
├── backend/                             # FastAPI backend (TO BUILD)
├── infra/                              # AWS CDK infrastructure (TO BUILD)
└── .claude/
    └── launch.json                     # Dev server configs (compass-web:5173, compass-ios:5174)
```

---

## What's Built (Frontend Mockup)

### Web App (localhost:5173) — COMPLETE
All pages interactive with mock data, no backend:

**Auth:** Login (with "Demo as CHW" / "Demo as Member" quick-login), Register
**CHW Onboarding:** 4-step wizard (Basic Info → Specializations → Languages/Availability → Credentials with HIPAA/background check/CE uploads)
**Member Onboarding:** 4-step wizard (Basic Info → SDOH Assessment → Insurance → Welcome with points)

**CHW Pages:**
- Dashboard — stats, upcoming sessions, open requests
- Requests — filter tabs, interactive map with request locations, accept/pass with earnings calc
- Sessions — active/completed, call recording for phone sessions, session documentation modal (summary, resources, goals, diagnosis codes, procedure codes, units to bill)
- Calendar — monthly grid with Google Calendar-style inline event previews, sync modal (Google/Apple/Outlook)
- Earnings — hero payout card, scenario table with Medi-Cal math, payout history
- Profile — editable fields, profile picture upload, credentials/compliance section, availability toggle

**Member Pages:**
- Home — greeting, rewards, goals with progress bars, upcoming sessions
- Find CHW — filter tabs, interactive Leaflet map (CHW + resource markers across LA), CHW cards, schedule modal with consent step
- Sessions — active/completed, star ratings, cancel with confirmation
- Roadmap — overall progress, goal cards with emojis, timeline, add goal modal
- Calendar — monthly grid with session + milestone events, add-to-calendar
- Profile — editable fields, profile picture upload, rewards history + redemption catalog (4 items)

**Landing Pages:**
- `/landing/a` — Variant A (SELECTED) — gradient hero, enterprise healthcare feel
- `/landing/b` — Variant B — clean/warm Wellth-inspired
- `/landing/c` — Variant C — bold dark startup feel

**MVP Features Implemented:**
- ✅ Medical billing consent modal ("CHW services provided at no cost by your health plan...")
- ✅ ICD-10 diagnosis code selector (searchable, grouped by category)
- ✅ CPT procedure code selector (98960/98961/98962 U2)
- ✅ Call recording for phone sessions (consent prompt, pulsing indicator, timer)
- ✅ Session documentation template (summary, resources, goals, follow-up, codes, units)
- ✅ CHW credentialing (HIPAA, background check, CE uploads with compliance status)
- ✅ Calendar with Google Calendar-style inline event previews + sync
- ✅ Reward system (points history, redemption catalog)
- ✅ Interactive Leaflet maps with CHW + resource markers across LA
- ✅ Profile picture upload with camera overlay

### iOS Preview (localhost:5174) — COMPLETE
Same pages rendered inside an iPhone 15 Pro CSS frame with iOS-native styling (SF Pro font, large titles, blur tab bar, system colors). Apple Maps-style Leaflet map with CartoDB light tiles.

---

## What's NOT Built Yet

### Backend (FastAPI)
- User authentication (JWT)
- CHW/Member profiles CRUD
- Matching engine
- Session lifecycle management
- Billing integration (Pear Suite mock → real)
- Earnings calculations
- Database models + Alembic migrations
- API routes for all features

### AWS Infrastructure
- CDK project for infrastructure as code
- RDS PostgreSQL setup
- ECS Fargate / EC2 for FastAPI
- S3 buckets (PHI documents)
- Secrets Manager / SSM Parameter Store
- CloudWatch logging + audit trails
- AWS_SETUP.md guide for the team

### Deployment
- Vercel deployment for frontend (joincompasschw.com) — in progress
- GoDaddy DNS configuration (A record → Vercel, MX records → Google Workspace)

---

## Design Tokens (Web App)

```css
Primary Green: #00B050
Primary Dark: #008F40
Primary Light: #D0F0D0
Medical Blue: #0077B6
Surface: #F8FAFB
Card: #FFFFFF
Text Primary: #1A1A1A
Text Secondary: #555555
Text Muted: #AAAAAA
Border: #E5E7EB
Danger: #DC2626
Warning: #F59E0B
Success: #00B050
Font: Inter (Google Fonts)
Card radius: 12px
Button/Input radius: 8px
```

### iOS Design Tokens
```
iOS Blue: #007AFF
iOS Green: #34C759
Compass Green: #00B050
Compass Blue: #0077B6
iOS Background: #F2F2F7
iOS Separator: #C6C6C8
Font: -apple-system (SF Pro)
```

---

## Key Mock Data (in web/src/data/mock.ts)

### CHW Profiles (3)
1. Maria Guadalupe Reyes — Housing, Food, Mental Health — Spanish/English — 4.9 rating — Boyle Heights 90033
2. Darnell Washington — Rehab, Healthcare, Mental Health — English — 4.8 rating — South LA 90047
3. Linh Tran Nguyen — Healthcare, Food, Housing — Vietnamese/English — 4.7 rating — Alhambra 91801

### Member Profiles (3)
1. Rosa Delgado — Housing — Spanish — 90031
2. Marcus Johnson — Rehab — English — 90059
3. Fatima Al-Hassan — Mental Health — Arabic — 90250

### Map Coordinates (LA)
CHW locations based on zip codes + 8 community resources (food banks, shelters, clinics, mental health centers).

---

## Competitive Landscape

| Company | Model | Gap CompassCHW Fills |
|---------|-------|---------------------|
| UniteUs | B2B SaaS referral network | No CHW tools or billing |
| CityBlock | Full-risk capitation, W-2 | Gig-worker economics, scalable to all 50 states |
| Wellth | Patient incentives | No workforce component |
| Pear Suite | CHW enablement/billing | No marketplace or matching |
| CareRev/ShiftKey | Clinical gig (nurses) | Wrong worker segment |

---

## Key External Relationships

- **Pear Suite** — Initial billing partner (15% fee, Pear Cares Provider Network)
- **TENA** — ECM infrastructure anchor for Phase 2+ ($386 PMPM pathway)
- **Imperium Care (Anwar Douglas)** — Potential CalAIM referral partner (non-medical in-home care, NOT a competitor). Jemal meeting with Anwar.
- **Health Plans:** LA Care, Molina, Health Net, ILS/Kaiser (ECM enrollment targets)

---

## Pending Tasks / Next Steps

1. **Deploy frontend to Vercel** → joincompasschw.com (Variant A landing page)
2. **GoDaddy DNS** — A record for Vercel + MX records for Google Workspace
3. **Build FastAPI backend** with SQLAlchemy models, all API routes
4. **Build AWS CDK infrastructure** (local Docker first, deploy to free tier when account ready)
5. **Create AWS_SETUP.md** — step-by-step HIPAA configuration guide
6. **Google Workspace** — add Jemal and JT email accounts

---

## Files to Reference

| File | Purpose |
|------|---------|
| `/Users/akrammahmoud/Compass/COMPASS.md` | Mission & strategy (source of truth) |
| `/Users/akrammahmoud/Compass/web/src/data/mock.ts` | ALL TypeScript types + mock data |
| `/Users/akrammahmoud/Compass/web/src/App.tsx` | Route tree |
| `/Users/akrammahmoud/Compass/web/src/index.css` | Tailwind v4 design tokens |
| `/Users/akrammahmoud/Compass/.claude/launch.json` | Dev server configs |
| `/Users/akrammahmoud/Compass/CompassCHW_AWS_Cost_Breakdown.xlsx` | AWS pricing |
| `/Users/akrammahmoud/.claude/CLAUDE.md` | Global coding preferences |

---

## Running the Project

```bash
# Web app (localhost:5173)
cd /Users/akrammahmoud/Compass/web && npm run dev

# iOS preview (localhost:5174)
cd /Users/akrammahmoud/Compass/ios-preview && npm run dev

# Type check
cd /Users/akrammahmoud/Compass/web && npx tsc --noEmit

# Production build
cd /Users/akrammahmoud/Compass/web && npm run build
```

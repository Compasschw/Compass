# CompassCHW

A marketplace connecting Los Angeles residents with trusted Community Health Workers (CHWs) for housing, recovery, food, mental health, and healthcare navigation.

**Live:** [joincompasschw.com](https://joincompasschw.com)

## What is Compass?

Compass CHW matches underserved community members with trained neighbors who help navigate social services. CHWs are reimbursed through Medi-Cal at no cost to members.

**5 service verticals:** Housing, Rehab & Recovery, Food Security, Mental Health, Healthcare

## Tech Stack

- **Frontend:** React 19 + TypeScript 5.9 + Vite + Tailwind CSS 4
- **Maps:** Leaflet + OpenStreetMap (no API key needed)
- **Deployment:** Vercel
- **Backend (planned):** Python/FastAPI + PostgreSQL + AWS

## Getting Started

```bash
cd web
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Use "Demo as CHW" or "Demo as Member" on the login page.

## Project Structure

```
web/src/
  features/
    auth/        # Login, register, auth context
    chw/         # CHW dashboard, requests, sessions, earnings, profile, calendar
    member/      # Member home, find CHW, sessions, roadmap, profile, calendar
    onboarding/  # 4-step wizards for CHW and Member signup
    landing/     # Public marketing pages + waitlist
    legal/       # Privacy, Terms, HIPAA, Contact
    admin/       # Waitlist admin dashboard
  shared/
    components/  # Layout, Sidebar, BottomNav, MapView, Badge, StatCard
  data/
    mock.ts      # Type definitions + mock data (single source of truth)
```

## Key Routes

| Route | Description |
|-------|-------------|
| `/landing` | Public landing page with waitlist |
| `/login` | Login + demo access |
| `/chw/*` | CHW dashboard, requests, sessions, earnings |
| `/member/*` | Member home, find CHW, sessions, roadmap |
| `/admin/waitlist` | View waitlist signups + export CSV |

## Environment Variables

Copy `web/.env.example` to `web/.env` and configure:
- `VITE_APP_URL` - App URL
- `VITE_API_URL` - Backend API URL (when available)
- `VITE_DEMO_MODE` - Show demo login buttons

## License

Proprietary. All rights reserved.

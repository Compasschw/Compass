# Compass — Agent Instructions

Applies to any coding agent working in this repo (Cursor, Claude Code, etc.). Claude Code additionally reads CLAUDE.md; keep the two in sync when editing either.

## What this is

CompassCHW: a HIPAA-conscious platform connecting Community Health Workers (CHWs) with Medi-Cal members. FastAPI + SQLAlchemy async + Alembic backend (`backend/`), React Native/Expo app for web+mobile (`native/`). Prod: backend on EC2 (deploy via GitHub Actions on push to main), frontend on Vercel (three projects; builds independently of CI — a Vercel build can fail while CI is green).

## Non-negotiable engineering rules

- **Testing discipline**: before writing or changing a backend endpoint, follow `backend/TESTING.md` (negative-auth, invariant-violation, no-unhandled-500, post-failure DB state, prod-configured branch). Every fixed bug ships a regression test in the same PR that fails on pre-fix code.
- **CI gates**: backend enforces ≥85% diff coverage on changed lines (cover exception branches); frontend CI runs **bun** (`bun install --frozen-lockfile`, `bun run typecheck`, `bun run test` — the FULL suite, UTC). Never commit lockfile drift.
- **Local backend tests**: use an isolated Postgres DB per concurrent workstream (`DATABASE_URL=postgresql+asyncpg://compass:compass_dev_password@localhost:5432/<unique_db>`); never run two pytest processes against one DB. The 4 `test_session_chat.py` botocore/S3 failures are local-only (pass in CI). `npm run typecheck`/`bun run typecheck` only via the project script (bare tsc stack-overflows).
- **Migrations**: never let model columns merge ahead of their migration (new code + old schema = 500s on prod). Fail-loud migrations for data preconditions. Deploy runs `alembic upgrade heads`.
- **Recurring bug-class guardrails**: relationship gates on member-scoped endpoints, error boundaries on screens, `onError` on every mutation, role-scoped query keys, BAA/consent gates on comms paths, no browser dialogs (`window.alert/confirm`) — use on-brand in-app UI.
- **PHI**: no PHI in SMS/notification bodies (first names only) or logs (phones masked to last-4, never log message bodies). CIN and phone carry uniqueness constraints (CIN via HMAC hash column; phone exempts the 555-555-5555 placeholder).
- **Git**: conventional commits (`feat|fix|refactor|docs|test|chore(scope): ...`); ship via focused PRs; squash-merge; never force-push main.

## Skill library (works from any agent that can run bash + read files)

Reusable workflow skills live on disk as instructions + scripts:
- `~/.claude/skills/<name>/SKILL.md` — gstack suite (investigate, ship, qa, review, checkpoint, browse, …). When a task matches one (debugging → investigate; ship/PR → ship; QA → qa), READ the SKILL.md and follow it step-by-step; its `bin/` scripts are plain bash and run fine from any agent.
- `~/.agents/skills/<name>/` — design-aesthetic library for UI work.
- Key routing: bugs/errors → investigate · ship/deploy/PR → ship · test the site → qa · code review → review · save/resume state → checkpoint.

## Persistent memory

Long-lived project/user memory lives at `~/.claude/projects/-Users-akrammahmoud/memory/` — `MEMORY.md` is the index; one fact per file. At session start, read `MEMORY.md` and any entries relevant to the task. When you learn something durable (user preference, project decision, prod runbook detail), write it there in the same format and add an index line. Compass-critical entries: prod box access (SSM), deploy verification, SMS program state, phone/CIN uniqueness rules, QA-session workflow.

## Prod access & safety

Prod API box via SSM: `aws ssm start-session --target i-0f3d13da68b0974ee` (app container `backend-api-1`, code at `/code`, env at `/home/ubuntu/compass/backend/.env`). Read-only inspection freely; any prod data mutation needs Akram's explicit go-ahead with the exact target named. Verify "live on prod" via the deploy workflow + health endpoint (`/api/v1/health`) and, for FE, Vercel commit status — not CI alone.

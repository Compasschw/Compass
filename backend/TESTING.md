# Backend TDD checklist

Write these tests **before** (or alongside) the endpoint, not after. Each rule
exists because a real production bug slipped through happy-path-only tests.

The golden rule: **a test for a new endpoint must fail on the broken version of
the code.** A test that passes whether or not the bug exists proves nothing.

## For every new (or changed) endpoint

1. **Negative auth.** Assert `403` for an unauthorized caller (wrong role, or a
   CHW with no shared session with the member), not just `200` for the happy
   path. Relationship gate, not role gate. _(The HIGH-severity assessment-read
   bug shipped because no 403 test existed.)_

2. **Invariant-violation state.** If the handler assumes "at most one" / "exactly
   one" / a uniqueness invariant, write a test that **seeds the violating state**
   and asserts no 500. _(Begin Session 500'd because `scalar_one_or_none()` raised
   `MultipleResultsFound` once a CHW had ≥2 `in_progress` sessions — a state no
   test ever created. Use `.scalars().first()` / `.limit(1)` for existence
   checks; reserve `scalar_one_or_none()` for PK lookups.)_

3. **No unhandled 500s.** Force an internal failure (monkeypatch a dependency to
   raise, or seed bad data) and assert the response is a **clean `HTTPException`
   with a readable `detail`**, never a bare 500. _(An unhandled 500 is generated
   outside `CORSMiddleware`, so it ships with no `Access-Control-Allow-Origin`
   header and the browser only sees "Failed to fetch" — the real cause is
   invisible. Wrap fallible handlers to re-raise as `HTTPException(500, detail=
   f"{type(e).__name__}: {e}")` and validate the response model inside the try.)_

4. **Post-failure / post-retry DB state.** After a failed or repeated call, assert
   no orphan rows were left and the invariant still holds. _(Partial-commit
   orphans are invisible to happy-path tests: start committed `status=in_progress`
   then failed, stranding a session on every retry.)_

5. **Exercise the prod-configured branch.** If the handler branches on
   "integration configured vs not" (Vonage, Stripe, AssemblyAI, Pear), inject a
   **present-but-fake** provider so the configured path is covered. _(CI passed
   `start_session` only because Vonage was unconfigured — the placeholder path —
   while prod ran the real, blocking provider path that no test touched.)_

## For every fixed production bug

Add a regression test in the **same PR** that **fails on the pre-fix code** and
passes after. Name it for the behavior, not the bug
(e.g. `test_starting_a_second_session_supersedes_the_first`).

## Running tests

```bash
cd backend && .venv/bin/python -m pytest          # full suite (needs the test Postgres)
.venv/bin/python -m pytest tests/test_x.py -q     # one file
```

Pure-unit tests (e.g. CSV formatters) still import `conftest`, which connects to
Postgres at fixture setup — so a local run needs the test DB up, or rely on CI.

# Frontend testing (Vitest)

A lightweight unit-test harness for **pure TypeScript logic** — data transforms,
validation, date/geo math. This is where silent regressions have bitten us
(a shared helper changes, every caller breaks, typecheck stays green).

## Run

```bash
bun run test        # once (what CI runs)
bun run test:watch  # watch mode while developing
bun run test:cov    # with a coverage report
```

## Scope — what to test here

✅ Pure modules: no `react` / `react-native` imports. Examples already covered:
- `src/utils/caseTransform.ts` — snake↔camel API key mapping (runs on every response)
- `src/utils/availabilityShading.ts` — calendar availability math
- `src/constants/insurance.ts` — CIN validation

❌ React components / hooks that render RN nodes. Full RN rendering under jsdom
is fragile on the RN + React 19 boundary; we intentionally don't do it yet. If a
component holds real logic, **extract the logic into a pure function** and test
that (this also makes the component simpler).

Tests live next to the code as `*.test.ts`. A test that imports `react-native`
will fail to resolve by design — keep it pure.

## The rule (see also the repo-wide test-discipline directive)

When you change a **shared** util/helper, add or update its `*.test.ts` and run
`bun run test` before pushing. New pure logic ships with a test in the same PR.
CI runs this on every PR; the diff-coverage gate flags changed lines that aren't
covered.

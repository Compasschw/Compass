# Communication Platform Comparison — Masked Calling for CompassCHW

**Date:** 2026-04-10
**Use case:** Masked/proxy phone numbers for CHW ↔ member communication during sessions

## Critical Finding

**Twilio Proxy Service is DEPRECATED** — closed to new customers as of 2025. Building masked calling on Twilio now requires DIY with Programmable Voice + number pools.

**Twilio HIPAA BAA costs $5,000–$15,000/year** — prohibitively expensive for early-stage.

## Recommendation: Vonage

Start with Vonage. Purpose-built masked calling API, per-second billing (~$0.008/min), BAA available via sales conversation (not gated behind $15K/yr fee). Python SDK for FastAPI integration.

**Fallback:** Plivo (cheapest rates, $0.0035/min voice). BAA requires Enterprise plan.

**Do NOT use:** RingCentral (wrong product — UCaaS not CPaaS), Bandwidth (enterprise-only), ElevenLabs (AI voice synthesis — no proxy/masking).

## Comparison Table

| Criterion | Twilio | Vonage | Plivo | RingCentral | ElevenLabs |
|---|---|---|---|---|---|
| Masked calling | DIY (Proxy deprecated) | Yes — dedicated API | Yes — Number Masking API | No — UCaaS model | No — AI voice only |
| HIPAA BAA | $5K–$15K/yr | Sales contract | Enterprise plan | Included | N/A |
| Voice $/min | $0.013–0.022 | ~$0.008 | ~$0.0035 | Per-seat ($20-35/mo) | $0.10 (AI, not proxy) |
| SMS $/msg | $0.0075 | Contact sales | ~$0.0045 | Bundled | N/A |
| Call recording | Yes ($0.0025/min) | Yes (included) | Yes (included) | Yes | N/A |
| API quality | Excellent | Good | Good | Poor for this use | N/A |
| Healthcare customers | Extensive | Yes — explicit vertical | Some | Yes (UCaaS context) | None |

## Cost Estimate (500 sessions/month, 20 min avg)

| Platform | Monthly Usage | HIPAA Overhead |
|---|---|---|
| Twilio | ~$208/mo | +$5K–$15K/yr |
| Vonage | ~$155/mo | Sales contract |
| Plivo | ~$80/mo | Enterprise plan |

## Architecture (Provider-Agnostic)

```
Session created → lease proxy number from pool → store mapping in Postgres
Inbound call/SMS → webhook → look up session → forward to other party
Session closed → release proxy number back to pool
```

This pattern works identically across Vonage, Plivo, or future Twilio — switching providers is an adapter swap, not a schema change.

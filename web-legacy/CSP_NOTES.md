# CSP Audit Notes — vercel.json

These notes used to live as a `_csp_audit_notes` array inside `vercel.json`,
but Vercel's strict schema validator rejects underscore-prefixed top-level
properties on import. Moved here so the audit history isn't lost.

## 2026-04-22

### Changes from previous version (3 directives added)

1. **`worker-src 'self'`**
   Added because the PWA registers a service worker from the same origin.
   Without this, Chrome 64+ blocks SW registration and offline caching
   silently fails. `'self'` is the minimum; no third-party workers are used.

2. **`connect-src += https://*.stripe.com`**
   Added ahead of Stripe Connect onboarding (marketplace payment flow).
   Stripe JS makes XHR/fetch calls to stripe.com subdomains for tokenization,
   3DS redirects, and radar signals. Blocked without this.

3. **`frame-src 'self' https://js.stripe.com`**
   Stripe 3DS and the Payment Element render inside a cross-origin iframe.
   `frame-ancestors 'none'` (anti-clickjacking) is preserved and unrelated.

### Confirmed unchanged

- `connect-src` already includes `https://api.joincompasschw.com` — no change.
- `script-src 'unsafe-inline'` retained (Vite inline bootstrap chunk).
- TODO: Replace `unsafe-inline` with nonce/hash after Vite CSP plugin added.

### Verification (run after deploy)

```bash
curl -sI https://joincompasschw.com | grep -i content-security-policy
```

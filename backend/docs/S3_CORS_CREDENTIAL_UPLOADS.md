# S3 CORS — Credential Document Uploads (Web)

The CHW compliance checklist's document Upload buttons (HIPAA training,
Professional Service Agreement, liability insurance, CHW certification —
`CHWProfileScreen.tsx`'s Compliance section) now use a real upload path on
web (previously hard-blocked with a "mobile app required" message — see
`native/src/screens/chw/CHWProfileScreen.tsx`'s `uploadChecklistFileWeb`).

The web flow is: pick a file via a hidden `<input type="file">` → `POST
/api/v1/upload/presigned-url` (same-origin, not a CORS concern) → `PUT` the
file directly to the returned S3 presigned URL (**cross-origin** — the
browser sends this request from `https://joincompasschw.com` /
`http://localhost:8081` directly to `*.s3.amazonaws.com`). That PUT is what
requires bucket CORS — without it, the browser blocks the request client-side
before it ever reaches S3, and the upload fails with an opaque "Failed to
fetch" / CORS console error.

## Target bucket

The checklist-credential upload purpose (`purpose: "credential"` in the
presigned-URL request body) routes to the **PHI bucket**, resolved via
`app.config.settings.s3_bucket_phi`:

```
backend/app/routers/upload.py:174-176
    elif data.purpose in ("credential", "recording", "document"):
        key = build_phi_key(str(current_user.id), data.purpose, data.filename)
        bucket = settings.s3_bucket_phi
```

```
backend/app/config.py:20
    s3_bucket_phi: str = "compass-phi-dev"
```

Default (no `S3_BUCKET_PHI` env override) is **`compass-phi-dev`**. Confirm
the actual bucket name for the target environment before running the command
below — check the deployed environment's `S3_BUCKET_PHI` env var / SSM
parameter, since prod may point at a differently-named bucket than the local
default suggests (`compass-phi-dev` reads like a dev-only name; verify before
applying to a production bucket).

```bash
# Confirm the bucket the running environment actually uses:
aws ssm get-parameter --name /compass/prod/S3_BUCKET_PHI 2>/dev/null \
  || echo "no SSM override — falls back to the compass-phi-dev default"
```

## Apply the CORS configuration

```bash
aws s3api put-bucket-cors \
  --bucket compass-phi-dev \
  --cors-configuration file://s3-cors-credential-uploads.json
```

`s3-cors-credential-uploads.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "https://joincompasschw.com",
        "http://localhost:8081"
      ],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Notes:
- `AllowedOrigins` — production web origin plus `http://localhost:8081`
  (the Expo web dev server) for local development. Add any additional
  preview/staging origins (e.g. a Vercel preview URL) as extra entries if
  credential uploads need to be tested there.
- `AllowedMethods` — `PUT` is required for the upload itself; `GET` is
  included so a future presigned-download path (viewing an already-uploaded
  credential) works from the same bucket without a second CORS change.
- `AllowedHeaders: ["content-type"]` — the browser sends `Content-Type` on
  the PUT (see `uploadChecklistFileWeb`, which sets it to match the
  presigned URL's signed `ContentType`); this must be allowed or the
  preflight `OPTIONS` request fails.
- `MaxAgeSeconds: 3600` — caches the preflight response for an hour,
  reducing `OPTIONS` round-trips on repeated uploads in the same session.

## Verify

```bash
aws s3api get-bucket-cors --bucket compass-phi-dev
```

Then from the deployed web app: CHW Profile → Compliance → tap Upload on
any of the 4 document rows → pick a PDF/JPEG/PNG → confirm it moves to
"Pending Review" without a console CORS error.

## Scope note

This is an **infra-only** change — no backend or frontend code deploy is
required once CORS is applied; the presigned-PUT flow on both sides is
already live in code. The FE/BE upload logic was verified end-to-end in
`native/src/screens/chw/CHWProfileScreen.test.tsx` and
`backend/tests/test_upload_validation.py` with the S3 network boundary
mocked — CORS is a browser-enforced, S3-bucket-level policy that cannot be
exercised by any test in either suite (it only applies to real
cross-origin `fetch()` calls from an actual browser), so applying this
config is the last manual step before web uploads work in production.

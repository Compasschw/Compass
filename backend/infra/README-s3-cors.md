# S3 CORS for PHI upload buckets

Web uploads (paperclip / image on the message page, and the Documents screen) PUT
the file **directly from the browser to S3** using a presigned URL. That is a
cross-origin request, so each bucket must publish a CORS policy or the browser's
preflight `OPTIONS` is refused and `fetch()` throws **"Failed to fetch"**.

Native (iOS/Android) does not enforce CORS, so this only ever broke web.

## Affected buckets (us-west-2)

- `compass-prod-message-attachments`
- `compass-prod-member-documents`

## Policy

`s3-cors.json` mirrors the backend's own `cors_origins` allowlist
(`backend/app/config.py`). Keep the two in sync — if you add a web origin to the
backend CORS list, add it here and re-apply. CORS does **not** make objects public;
the bucket stays private and every upload/download still requires a presigned URL.

## Apply / re-apply

```bash
for b in compass-prod-message-attachments compass-prod-member-documents; do
  aws s3api put-bucket-cors --bucket "$b" \
    --cors-configuration file://backend/infra/s3-cors.json
done
```

## Verify

```bash
# Should return the rule set:
aws s3api get-bucket-cors --bucket compass-prod-message-attachments

# Live preflight from a trusted origin -> 200 + Access-Control-Allow-Origin:
curl -s -o /dev/null -D - -X OPTIONS \
  "https://compass-prod-message-attachments.s3.us-west-2.amazonaws.com/probe" \
  -H "Origin: https://joincompasschw.com" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type" | grep -i "access-control-allow"

# Untrusted origin -> 403, no allow-origin header (proves it's scoped, not wildcard).
```

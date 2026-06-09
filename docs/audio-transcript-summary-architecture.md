# Audio / Transcript / AI-Summary Pipeline — Architecture and Cost Report

**Date:** June 9, 2026
**Author:** Architecture review (Claude Code — Senior Architect role)
**Status:** DONE_WITH_CONCERNS

---

## TLDR — 30-Second Read for the CEO

- **Recordings are not durably stored by us.** Vonage is recording both call legs and posting a `recording_url` to our webhook. We download the bytes immediately and transcribe them, but we never write the audio file to our own S3. It exists only on Vonage's servers for 30 days. After that it is gone forever.
- **Transcripts are in the database, not S3.** Final utterance chunks land in the `session_transcripts` table (PostgreSQL). The raw full-text also sits in `communication_sessions.transcript_text`. No S3 object is ever written for transcripts.
- **AI summaries are in the database only.** The `session_documentation.ai_summary` column is the single storage location. No S3 write happens. The prompt and model version are not stored anywhere.
- **No audio, transcript, or summary buckets exist today.** The only media-related buckets are `compass-phi-dev` / `compass-public-dev` (general PHI uploads), `compass-sandbox-billing-csv`, and `compass-sandbox-member-csv`. No dedicated buckets for the call pipeline.
- **Biggest risk before next Pear audit:** if a Vonage recording disappears (30-day expiry, Vonage outage, or our download fails silently), there is no recovery path. The transcript and summary become the only clinical record of the call. Creating the three buckets and wiring the download→S3 write path is the single highest-priority infrastructure task.

---

## 1. Current State Inventory

### 1.1 Audio Recording — Vonage Voice API

**Where the call is initiated:**
`backend/app/services/communication/vonage_provider.py:83` — `create_proxy_session()` places two parallel outbound calls: one to the CHW (answer URL → `/voice/answer`) and one to the member (answer URL → `/voice/consent-prompt`). The CHW call is always placed; the member call runs through a California §632 IVR before joining.

**Does the NCCO issue a `record` action?**
Yes. `backend/app/routers/communication.py:576–592` — the CHW leg's NCCO contains:

```json
{
  "action": "conversation",
  "name": "compass-session-<session_id>",
  "record": true,
  "eventUrl": ["https://api.joincompasschw.com/api/v1/communication/voice/events?session=<session_id>"],
  "eventMethod": "POST"
}
```

The `record: true` on the first joiner's `conversation` action tells Vonage to record the bridged audio of both legs. Only the CHW NCCO sets this; the member NCCO (in `consent-result` at line 752) joins the same named conversation without a separate record directive — correct behavior per Vonage's documentation.

**Where recordings land:**
Vonage stores the MP3 on their own infrastructure. When the conversation ends, Vonage POSTs a `record` event to `/voice/events` containing `recording_url` (a Vonage-controlled `https://api-{region}.nexmo.com/v1/files/{uuid}` URL) and `recording_uuid`. The event handler at `communication.py:841–899` validates the URL host (against `_SAFE_RECORDING_HOST_SUFFIXES`), writes `recording_url` and `provider_recording_id` to `communication_sessions`, then immediately schedules a background task: `finalize_recording(communication_session_id)`.

**Do we download and re-store to our own S3?**
Partial. `backend/app/services/communication/recording_finalizer.py:123` downloads the bytes from Vonage using a minted RS256 JWT. The bytes are then passed directly to AssemblyAI for transcription (`transcribe_bytes` at line 145). After transcription the audio bytes are discarded — they are never written to S3. There is no `s3_put` or equivalent call anywhere in the finalizer or in `VonageProvider`. The audio exists on Vonage's servers for 30 days, then disappears.

**Conclusion:** We have the download code but no persistence. Audio is currently ephemeral.

---

### 1.2 Transcription — AssemblyAI

**Which path is active:**
The codebase has two paths:

1. **Live streaming (web sessions):** `TranscriptHub` in `backend/app/services/transcript_hub.py` routes audio chunks from the CHW's browser mic through an `AssemblyAIStreamingSession` (wrapping `RealtimeTranscriber`). Final chunks (`is_final=True`) are persisted row-by-row to `session_transcripts` via `_persist_transcript_chunk` at line 536. Partial chunks are fanned out to WebSocket subscribers only and discarded.

2. **Post-call batch (phone sessions):** The `recording_finalizer` pipeline downloads Vonage audio bytes, calls `AssemblyAIProvider.transcribe_bytes()` which uploads to AssemblyAI, polls for completion, and returns a `TranscriptionResult` with `full_text` and utterance-level `chunks`. The finalizer writes `transcript_text` + `transcript_confidence` to `communication_sessions` and explodes utterances into `session_transcripts` rows.

**Does the streaming path persist anywhere beyond the DB?**
No S3 write. The DB (`session_transcripts` table) is the only persistence. There is no `transcript_s3_key` column on any model.

**Session / SessionDocumentation transcript columns:**
Inspecting `backend/app/models/session.py`:
- `Session` — no `transcript_text`, `transcript_url`, or `transcript_s3_key` column.
- `SessionDocumentation` — no transcript column. Has `ai_summary` (Text), `ai_summary_generated_at` (DateTime), `ai_summary_excluded` (Boolean).
- `SessionTranscript` — is the utterance store (speaker, text, ms offsets, confidence). No S3 key.
- `CommunicationSession` (`backend/app/models/communication.py:27`) — has `recording_url` (String 500), `transcript_text` (Text), `transcript_confidence` (Float), `provider_recording_id` (String 255). No audio or transcript S3 key columns.

**Conclusion:** Transcripts live solely in the PostgreSQL database. No S3 object is written.

---

### 1.3 AI Summary Generation

**Where summaries are generated:**
Two separate paths write to `SessionDocumentation.ai_summary`:

1. **On-demand via API:** `backend/app/routers/sessions.py:1896` — `POST /api/v1/sessions/{session_id}/ai-summary`. Calls `generate_session_summary()` in `backend/app/services/summary_generation.py`. Assembles transcript from `SessionTranscript` rows (and fallbacks to `CommunicationSession.transcript_text`), then calls `get_summarizer().summarize(transcript)`.

2. **Background after call ends:** `backend/app/services/communication/recording_finalizer.py:217–274` — `_maybe_trigger_ai_summary()`. If `SessionDocumentation` exists and `ai_summary` is empty, calls `transcription_provider.summarize_transcript()` which routes through AssemblyAI LeMUR.

**Which model is used:**
`backend/app/services/transcription/summarizer.py:54` — model is `claude-haiku-4-5` via `AnthropicSummarizer`. The AssemblyAI LeMUR path (`assemblyai_provider.py:640`) uses `LEMUR_MODEL_DEFAULT = "default"` (AssemblyAI's recommended model at request time).

**Where the summary lives:**
`SessionDocumentation.ai_summary` (Text column in PostgreSQL). Neither the prompt, the model version, the raw LLM response envelope, nor any token counts are persisted anywhere. There is no S3 write.

**Where is the "Regenerate" button wired?**
The DocumentationModal calls `POST /api/v1/sessions/{session_id}/ai-summary` at `sessions.py:1879`. This endpoint re-runs the full generation pipeline every time it is called; it does not read from a cache or S3. The result is returned to the frontend as a JSON response — the caller is responsible for writing it into the modal's state. The endpoint does NOT write back to the `ai_summary` column itself (the column is only written by the finalizer background task and by the documentation submit path). NEEDS VERIFICATION: confirm the modal's "Save" flow persists the regenerated text before the CHW submits documentation.

---

## 2. Existing AWS S3 Buckets

**Confirmed in code:**

| Env Var | Default / Sandbox Name | Purpose | Code Location |
|---|---|---|---|
| `S3_BUCKET_PHI` | `compass-phi-dev` | General PHI uploads (attachments, credential documents) | `config.py:20`, `upload.py:14`, `credentials.py:35` |
| `S3_BUCKET_PUBLIC` | `compass-public-dev` | Public profile images | `config.py:21`, `upload.py:17` |
| `S3_BUCKET_BILLING_CSV` | `compass-sandbox-billing-csv` | Pear bulk-upload billing CSVs | `config.py:31`, `billing_csv_writer.py:414` |
| `S3_BUCKET_MEMBER_CSV` | `compass-sandbox-member-csv` | Pear member import CSVs | `config.py:41`, `member_csv_writer.py:263` |

**Production bucket names:** The `.env` file currently has `S3_BUCKET_PHI=compass-phi-dev` and `S3_BUCKET_PUBLIC=compass-public-dev` — still using dev-prefixed names. The billing/member CSV bucket env vars are not present in `.env`, meaning they default to the sandbox names from `config.py`. NEEDS VERIFICATION with ops: confirm whether `compass-prod-billing-csv` and `compass-prod-member-csv` exist in the AWS account (the memory notes reference these names as the production buckets).

**IAM / credentials pattern:**
`s3_service.py` calls `boto3.client("s3", region_name=settings.aws_region)` with no explicit `aws_access_key_id` or `aws_secret_access_key`. Boto3 will fall back to the standard credential chain: environment variables → `~/.aws/credentials` → EC2 instance profile. No static keys are visible in the codebase. NEEDS VERIFICATION: confirm the EC2 instance has an IAM role attached (instance profile) so no static keys are in the EC2 environment.

**Buckets for audio, transcripts, or summaries today:** None. There are no references to call recording, transcript, or summary bucket names anywhere in the codebase.

---

## 3. Proposed Storage Architecture

### 3.1 Audio Recordings

**Bucket name:** `compass-prod-call-recordings`

**Path schema:**
```
prod/v1/{session_year}/{session_month}/{session_id}.mp3
```
Example: `prod/v1/2026/06/550e8400-e29b-41d4-a716-446655440000.mp3`

Use session_id (not communication_session_id) as the filename so the path is stable across retry calls. If a session has multiple communication sessions (CHW retried the call), only the successful recording should be written; `recording_finalizer` already picks the most recent non-empty `transcript_text` row as the source of truth.

**Audio format:** Vonage records Conversation API audio as MP3 at 16 kHz. The download in `VonageProvider.download_recording_bytes` returns raw bytes; the temp file is suffixed `.mp3`. Store as MP3.

**Lifecycle policy (HIPAA-aligned):**

| Transition | Timing | Rationale |
|---|---|---|
| Standard → Standard-IA | 90 days | Access pattern drops sharply after CHW submits documentation (typically same day or within a week). IA reduces cost 46% with 30-day minimum duration caveat — fine here. |
| Standard-IA → Glacier Instant Retrieval | 1 year | A year post-call, audio is only accessed for disputes or audits. Glacier IR restores in milliseconds, satisfying on-demand audit access. |
| Glacier IR → Glacier Flexible Retrieval | 3 years | Deep archive territory. 3-5 hour retrieval is acceptable for historical legal review. |
| Delete | 7 years from creation | HIPAA minimum is 6 years from creation OR last access. California Health & Safety Code §123111 requires 7 years for adult patient records and 3 years past age of majority for minors. Using 7 years satisfies both. See Section 6 for full discussion. |

**Versioning:** Enable. Protects against accidental deletes and ransomware (combined with MFA delete if the team has ops bandwidth). The cost overhead at call-recording volumes is minimal.

---

### 3.2 Transcripts

**Bucket name:** `compass-prod-transcripts`

**Path schema:**
```
prod/v1/{session_year}/{session_month}/{session_id}.json
```
Example: `prod/v1/2026/06/550e8400-e29b-41d4-a716-446655440000.json`

**Format:** JSON preserving utterance-level timing and speaker diarisation. AssemblyAI returns word-level timing and speaker labels ("A"/"B"); the existing `TranscriptChunk` type already captures `speaker`, `text`, `start_ms`, `end_ms`, `confidence`. Store the full array plus metadata:

```json
{
  "schema_version": "1.0",
  "session_id": "...",
  "communication_session_id": "...",
  "provider": "assemblyai",
  "provider_transcript_id": "...",
  "model": "universal-3-pro",
  "language": "en",
  "confidence": 0.94,
  "duration_ms": 900000,
  "transcribed_at": "2026-06-09T14:32:00Z",
  "utterances": [
    {
      "speaker": "A",
      "speaker_role": null,
      "text": "...",
      "start_ms": 1200,
      "end_ms": 4800,
      "confidence": 0.96
    }
  ]
}
```

Rationale for JSON with timing: the utterance-level timestamps are required for any future audit replay ("what was said at minute 4?"), speaker attribution correction, and re-derivation of summaries. Plain `.txt` loses this irrecoverably. The extra storage is negligible at ~50 KB per session.

**Lifecycle:** Same 7-year horizon as audio. No IA transition needed — transcripts are tiny (~50 KB) and Standard storage is already pennies.

---

### 3.3 AI Summaries

**Bucket name:** `compass-prod-ai-summaries`

**Path schema:**
```
prod/v1/{session_year}/{session_month}/{session_id}.json
```

**Format:** Full provenance envelope:

```json
{
  "schema_version": "1.0",
  "session_id": "...",
  "generated_at": "2026-06-09T14:32:05Z",
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "system_prompt_hash": "sha256:abc123...",
  "input_tokens": 4120,
  "output_tokens": 312,
  "summary": "The CHW discussed housing instability with the member..."
}
```

Include `system_prompt_hash` (SHA-256 of the system prompt string) rather than the full prompt to keep the object small while enabling prompt-version tracking. Store `input_tokens` and `output_tokens` from Anthropic's response usage block so cost can be attributed per session in the future.

**Tradeoff — DB column vs S3:**

| Approach | Pros | Cons |
|---|---|---|
| DB column only (current) | Zero latency reads, simple queries, no extra infra | Prompt and model version not stored; no re-derivation audit; DB backup is the only recovery |
| DB column + S3 object | Provenance for audits, model version pinned, re-derivation possible, survives DB schema changes | Two writes to keep in sync; minor complexity |
| S3 only | Single source of truth | Adds latency to every summary read; the DocumentationModal needs a presigned URL or a fetch |

Recommendation: keep the `ai_summary` DB column for fast reads and add an S3 write for provenance. Write to S3 asynchronously (fire-and-forget, same pattern as `finalize_recording`) so the API response is not blocked. Store `summary_s3_key` on `SessionDocumentation` for retrieval. If the S3 write fails, the DB column is still the authoritative value — S3 is the audit trail, not the primary read path.

---

## 4. Cost Estimates

### 4.1 Scale Definitions

| Scale | Sessions/day | Sessions/month | Audio GB/month |
|---|---|---|---|
| Pear launch | 21 (150 members × 1/week) | 630 | 9.45 GB |
| Pilot | 100 | 3,000 | 45 GB |
| Mid | 1,000 | 30,000 | 450 GB |

Audio calculation: 15 min × 1 MB/min = 15 MB per session. Vonage default MP3 codec at 16 kHz / 32 kbps is approximately 0.24 MB/min, so 15 min ≈ 3.6 MB. Using 4 MB/session as a conservative estimate (higher quality or stereo recordings). NEEDS VERIFICATION: download one test recording and measure actual size.

Revised table using 4 MB/session:

| Scale | Sessions/month | Audio GB | Transcript GB | Summary GB |
|---|---|---|---|---|
| Pear launch | 630 | 2.52 | 0.031 | 0.003 |
| Pilot | 3,000 | 12.0 | 0.150 | 0.015 |
| Mid | 30,000 | 120.0 | 1.50 | 0.150 |

### 4.2 S3 Storage Costs (us-west-2, Standard tier, $0.023/GB-month)

| Scale | Audio | Transcripts | Summaries | Total/month |
|---|---|---|---|---|
| Pear launch | $0.06 | $0.001 | $0.000 | ~$0.07 |
| Pilot | $0.28 | $0.003 | $0.000 | ~$0.29 |
| Mid | $2.76 | $0.034 | $0.003 | ~$2.80 |

**After 90-day IA transition kicks in at Pilot scale:** audio drops from $0.023 to $0.0125/GB for older objects, reducing the blended rate. At Pilot scale after 3 months steady-state, ~2/3 of audio is in IA → monthly audio cost drops to ~$0.17.

**PUT request costs:** $0.005 per 1,000 PUTs. At 21 sessions/day = 630/month → $0.003/month. Negligible at all scales.

**Total S3 cost estimate:**
- Pear launch: under $1/month
- Pilot: $5–10/month
- Mid: $10–25/month (blended IA kicking in)

### 4.3 AssemblyAI Transcription

Current pricing (from `assemblyai_provider.py:15` comments, April 2026): **$0.37/hr base + ~$0.09/hr for universal-3-pro (medical)**. Total: ~$0.46/hr.

| Scale | Hours/month | Cost/month |
|---|---|---|
| Pear launch | 630 × 15min = 157.5 hr | $72 |
| Pilot | 3,000 × 15min = 750 hr | $345 |
| Mid | 30,000 × 15min = 7,500 hr | $3,450 |

NEEDS VERIFICATION: Confirm current AssemblyAI pricing. The `$0.46/hr` figure is from April 2026 inline comments. Check the current dashboard rate.

### 4.4 Anthropic AI Summary Cost (claude-haiku-4-5)

A 15-minute transcript at ~100 words/minute ≈ 1,500 words ≈ 2,000 tokens. Add system prompt (~300 tokens) and user message preamble (~100 tokens) → ~2,400 input tokens. Output: 3–5 sentences ≈ 300–400 tokens.

Claude Haiku 4.5 pricing (verify current pricing): approximately $0.80 per million input tokens, $4.00 per million output tokens (NEEDS VERIFICATION — these are reference figures; confirm at console.anthropic.com).

| Scale | Sessions/month | Input tokens | Output tokens | Cost/month |
|---|---|---|---|---|
| Pear launch | 630 | 1.51M | 0.25M | $1.21 + $1.00 = ~$2.21 |
| Pilot | 3,000 | 7.2M | 1.2M | $5.76 + $4.80 = ~$10.56 |
| Mid | 30,000 | 72M | 12M | $57.60 + $48.00 = ~$105.60 |

### 4.5 Total Monthly Estimates

| Scale | S3 | AssemblyAI | Anthropic | Total |
|---|---|---|---|---|
| Pear launch | $1 | $72 | $2 | ~$75 |
| Pilot | $10 | $345 | $11 | ~$366 |
| Mid | $25 | $3,450 | $106 | ~$3,581 |

The dominant cost at all scales is AssemblyAI transcription, not storage. If budget is a concern at Pilot scale, the first lever is switching from `universal-3-pro` (medical) to `universal-2` (standard) which reduces the per-hour rate. Verify the actual medical-model add-on cost before doing so — the clinical accuracy trade-off needs a deliberate decision.

---

## 5. Vendor Practices — Vonage and AssemblyAI

### 5.1 Vonage Recording Retention

Vonage Voice API stores Conversation recording files for **30 days** from the recording date. The download URL (`https://api-{region}.nexmo.com/v1/files/{recording-uuid}`) requires a Bearer JWT minted with the application's private key — it is not publicly accessible. The download implementation already exists at `VonageProvider.download_recording_bytes` (`vonage_provider.py:236`).

**What we should do (not currently done):** After downloading the bytes for transcription, PUT them to S3 before discarding. The window is 30 days from call end, but we process immediately in the background task — so the actual risk is if the background task fails silently. Currently `finalize_recording` returns without storing audio on download failure (`recording_finalizer.py:124–130`). Add a S3 write between the download and the AssemblyAI submission.

**Optional: delete from Vonage after successful S3 write.** Vonage supports `DELETE /v1/files/{recording-uuid}`. Deleting after our S3 copy reduces our exposure window (PHI under fewer custodians). This is optional but clean from a HIPAA data-minimization standpoint. Not required immediately.

**Vonage Cloud Storage add-on:** Vonage offers a long-term cloud storage add-on. Do not use it — it adds cost without eliminating the self-storage requirement, and routing PHI through a second Vonage storage service adds another BAA consideration. Self-store in S3 under our own KMS key.

### 5.2 AssemblyAI Storage

**Batch transcription:** When `transcribe_bytes` uploads audio, AssemblyAI stores the audio file and the transcript on their servers until the transcript is deleted. AssemblyAI supports `DELETE /v2/transcript/{id}` to remove transcripts. The BAA with AssemblyAI is signed per memory notes. Recommended practice: after we persist the transcript to our own S3 bucket, call the AssemblyAI delete endpoint for the transcript object to minimize PHI exposure at the vendor. The `provider_transcript_id` is already stored on `CommunicationSession` implicitly via `TranscriptionResult.provider_transcript_id` (which is logged at `recording_finalizer.py:203`) — but it is not persisted to a column. NEEDS VERIFICATION: confirm `provider_transcript_id` is stored somewhere queryable if we want to implement deletion.

**Streaming transcription:** AssemblyAI's Universal Streaming (RealtimeTranscriber) does not persist audio or transcripts server-side. Audio chunks arrive and are processed in-memory only. No server-side deletion needed for the streaming path.

---

## 6. HIPAA and PHI Considerations

All three artifact types — audio, transcript, and AI summary — are Protected Health Information (PHI) under HIPAA. They contain identifiable health-related conversation content between a covered entity's workforce member (CHW) and a patient.

**Required S3 configuration for all three buckets:**

| Control | Requirement | Notes |
|---|---|---|
| Encryption at rest | SSE-KMS (preferred) or SSE-S3 | SSE-KMS enables key rotation auditing via CloudTrail and supports per-bucket or per-object key policies. SSE-S3 is acceptable as a minimum but KMS is strongly preferred for a covered entity. |
| Public access | Block all public access (all four checkboxes) | No pre-signed URL issued to members; access is via the backend only. |
| Bucket logging | S3 Server Access Logs or AWS CloudTrail S3 data events | CloudTrail S3 data events (GetObject, PutObject, DeleteObject) provide the audit log required by HIPAA §164.312(b). Enable at the bucket level. |
| Versioning | Enabled | Protects against accidental deletion and partial ransomware scenarios. Also satisfies HIPAA requirement for backup and disaster recovery. |
| MFA delete | Optional | High operational friction for modest marginal benefit. Recommend deferring until the team has a dedicated ops runbook for it. |
| Bucket policy | Deny `s3:*` to `Principal: *` unless authenticated via IAM | Explicit deny on public access at the bucket policy level in addition to the block-public-access setting. |

**IAM access pattern:**
The existing `s3_service.py` uses `boto3.client("s3")` with no explicit credentials, relying on the boto3 credential chain. For EC2 deployments this resolves to the instance profile. Confirm the EC2 instance has an IAM role with the following minimum permissions on the new buckets:
- `s3:PutObject` (upload)
- `s3:GetObject` (presigned download for audit)
- `s3:DeleteObject` (Vonage post-copy cleanup, AssemblyAI transcript deletion)
- `s3:ListBucket` (health checks)

No static AWS credentials should appear in `.env` or environment variables. The current codebase shows no static keys — maintain this.

**California retention — applicable law:**
California Health & Safety Code §123111 requires retention of adult patient records for a minimum of **7 years** from the date of service (or 3 years past the age of majority for minors). HIPAA's minimum is 6 years from creation or last use. California's 7-year rule is more stringent and governs here since the operation is California-based. Lifecycle policy should target delete at **7 years + 30 days** (the extra buffer accounts for timezone edge cases in the lifecycle rule evaluation). Compass operates under Medi-Cal which does not extend this beyond 7 years for CHW service records specifically, but confirm with legal counsel before setting a deletion date shorter than 10 years if the patient population includes minors (age of majority is 18 in California; a 17-year-old's records would need retention until age 21 under the minor rule).

**BAA status (from project memory):**
- Anthropic: SIGNED — `AnthropicSummarizer` can handle PHI in production.
- AssemblyAI: SIGNED — `AssemblyAIProvider` can handle PHI in production.
- AWS: SIGNED — S3 buckets can store PHI.
- Vonage: NEEDS VERIFICATION per memory — BAA flag `vonage_baa_confirmed` must be `true` in prod `.env` before recordings can be processed.

---

## 7. Recommendation — Implementation Order

### Phase 1 — Create the 3 buckets (estimated effort: 2 hours)

1. Create `compass-prod-call-recordings`, `compass-prod-transcripts`, `compass-prod-ai-summaries` in `us-west-2`.
2. For each bucket: enable SSE-KMS (use the same KMS key as existing PHI buckets, or create a dedicated `compass-phi-kms-key`), block all public access, enable versioning, enable S3 server access logging to a `compass-prod-access-logs` bucket, set the lifecycle rule (Standard → IA 90 days → Glacier IR 1 year → Glacier Flexible 3 years → Delete 7 years).
3. Add three env vars to `config.py` and `.env.example`:
   - `S3_BUCKET_CALL_RECORDINGS` (default: `compass-phi-dev` to avoid prod breakage on unset)
   - `S3_BUCKET_TRANSCRIPTS`
   - `S3_BUCKET_AI_SUMMARIES`
4. Update the EC2 IAM role policy to include PutObject/GetObject/DeleteObject/ListBucket on the three new bucket ARNs.

### Phase 2 — Wire audio download → S3 (estimated effort: 4–6 hours)

1. In `recording_finalizer._run_pipeline` (line 112–133), after `audio_bytes` is confirmed non-empty, call `s3_client.put_object(Bucket=settings.s3_bucket_call_recordings, Key=f"prod/v1/{year}/{month}/{session_id}.mp3", Body=audio_bytes, ContentType="audio/mpeg", ServerSideEncryption="aws:kms")`.
2. Add an `audio_s3_key` column (String, nullable) to `CommunicationSession`. Generate and apply an Alembic migration.
3. Write the S3 key to `comm_session.audio_s3_key` after a successful PUT.
4. Failure handling: if the PUT raises, log the error and continue the pipeline. Do NOT block transcription on storage success. The 30-day Vonage window is the fallback. Add a CloudWatch alarm on the log line so ops is notified of persistent failures.

### Phase 3 — Wire transcript → S3 (estimated effort: 6–8 hours)

1. In `recording_finalizer._run_pipeline`, after the `session_transcripts` rows are committed (step 4), serialize the full `TranscriptionResult` to the JSON envelope defined in Section 3.2 and PUT to `s3_bucket_transcripts`.
2. Add a `transcript_s3_key` column (String, nullable) to `CommunicationSession`. Migration.
3. For the live streaming path, add a session-end hook in `TranscriptHub` that serializes accumulated final chunks to the same JSON envelope and PUTs to S3. This requires querying `session_transcripts` for the session's final chunks (they are already in the DB from `_persist_transcript_chunk`) and writing the JSON file. Alternatively, accumulate in-memory during streaming and flush on `end_session`.
4. Same failure handling: log, alert, do not block session completion.

### Phase 4 — Wire AI summary provenance → S3 (estimated effort: 3–4 hours)

1. In `AnthropicSummarizer.summarize` (`summarizer.py:269`), capture the Anthropic response usage block (`response.usage.input_tokens`, `response.usage.output_tokens`) and the stop reason.
2. After the DB write of `doc.ai_summary`, serialize the JSON provenance envelope (Section 3.3) and PUT to `s3_bucket_ai_summaries`. Fire-and-forget via `asyncio.create_task`.
3. Add a `summary_s3_key` column (String, nullable) to `SessionDocumentation`. Migration.
4. Same failure handling: S3 write failure should never surface to the user or block the summary response.

---

### Rollback and Failure Story

The key design constraint across all three phases is: **storage must never block the clinical workflow**. Session completion, documentation submission, and billing are the critical path. S3 writes are audit-trail enhancements.

If a bucket write fails:
- **Audio:** Vonage's 30-day retention is the safety net. Log the failure at ERROR level with `comm_session_id`. A CloudWatch alarm on this log pattern should alert ops within 24 hours so a manual re-download can be triggered before expiry.
- **Transcripts:** The `session_transcripts` DB table is the authoritative source. S3 is a secondary backup. No clinical impact.
- **Summaries:** The `session_documentation.ai_summary` DB column is the source of truth. S3 is provenance-only. No clinical impact.

Do not implement retry loops in the background task itself. A re-delivered Vonage webhook or a manual admin endpoint for re-triggering `finalize_recording` is the retry mechanism. Adding retry loops to background tasks risks duplicate S3 objects and duplicate `session_transcripts` rows (the finalizer's idempotency check at `recording_finalizer.py:97` guards against the latter).

---

## Appendix — Key File Locations

| File | What it does |
|---|---|
| `backend/app/routers/communication.py:576` | CHW NCCO with `record: true` action |
| `backend/app/routers/communication.py:841` | Vonage `recording_url` ingest + `finalize_recording` dispatch |
| `backend/app/services/communication/vonage_provider.py:236` | Vonage recording download (RS256 JWT auth) |
| `backend/app/services/communication/recording_finalizer.py` | Full post-call pipeline: download → transcribe → persist → summary |
| `backend/app/services/transcription/assemblyai_provider.py:382` | Batch transcription via bytes upload |
| `backend/app/services/transcript_hub.py:536` | Live streaming transcript chunk persistence |
| `backend/app/services/transcription/summarizer.py:229` | AnthropicSummarizer (claude-haiku-4-5) |
| `backend/app/services/summary_generation.py` | On-demand summary orchestration |
| `backend/app/models/communication.py:11` | CommunicationSession model (recording_url, transcript_text columns) |
| `backend/app/models/session.py:84` | SessionDocumentation (ai_summary column) |
| `backend/app/models/session.py:200` | SessionTranscript (utterance store) |
| `backend/app/services/s3_service.py` | S3 client singleton + presigned URL helpers |
| `backend/app/config.py:19` | All S3 bucket env vars |

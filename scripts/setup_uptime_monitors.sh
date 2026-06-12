#!/usr/bin/env bash
# Create the two production UptimeRobot monitors (audit 2026-06-12 blocker #5).
#
# Idempotent: skips any monitor whose URL is already registered.
#
# Prereqs (one-time, interactive — do these in the UptimeRobot dashboard):
#   1. Create a free account at https://uptimerobot.com
#   2. Add + verify an SMS alert contact (your phone) under My Settings →
#      Alert Contacts. SMS verification cannot be done via API.
#   3. Grab the "Main API Key" from My Settings → API Settings.
#
# Usage:
#   UPTIMEROBOT_API_KEY=u1234567-... ./scripts/setup_uptime_monitors.sh
#
# Both monitors poll every 5 minutes (free-tier minimum) and alert every
# verified alert contact on the account (API default when alert_contacts
# is omitted).

set -euo pipefail

API="https://api.uptimerobot.com/v2"
KEY="${UPTIMEROBOT_API_KEY:?Set UPTIMEROBOT_API_KEY (My Settings → API Settings → Main API Key)}"

# url|friendly name|keyword (keyword empty = plain HTTP 2xx check)
MONITORS=(
  "https://api.joincompasschw.com/api/v1/health|Compass API health|"
  "https://joincompasschw.com|Compass member app|"
)

existing_urls=$(curl -fsS -X POST "$API/getMonitors" \
  -d "api_key=$KEY" -d "format=json" \
  | python3 -c "import json,sys; print('\n'.join(m['url'] for m in json.load(sys.stdin).get('monitors', [])))")

for entry in "${MONITORS[@]}"; do
  IFS='|' read -r url name _keyword <<<"$entry"
  if grep -qxF "$url" <<<"$existing_urls"; then
    echo "SKIP  $name — monitor for $url already exists"
    continue
  fi
  response=$(curl -fsS -X POST "$API/newMonitor" \
    -d "api_key=$KEY" -d "format=json" \
    -d "type=1" \
    -d "interval=300" \
    --data-urlencode "friendly_name=$name" \
    --data-urlencode "url=$url")
  status=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('stat', 'fail'))" <<<"$response")
  if [ "$status" = "ok" ]; then
    echo "OK    $name → $url"
  else
    echo "FAIL  $name → $response" >&2
    exit 1
  fi
done

echo "Done. Verify SMS alerting: dashboard → monitor → Alert Contacts."

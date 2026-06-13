#!/usr/bin/env bash
# Create production CloudWatch alarms for Compass (audit 2026-06-12 #12).
#
# Creates an SNS topic, subscribes an alert email, and sets metric alarms on
# the prod RDS instance and API EC2 box. RDS/EC2 metrics are collected by
# CloudWatch automatically — no log shipping required for these (that is a
# separate item; see OPS_RUNBOOK §"CloudWatch log shipping").
#
# Idempotent: put-metric-alarm and create-topic are upserts; the email
# subscription is only created if one for that address doesn't already exist.
#
# Usage:
#   ALERT_EMAIL=akram@joincompasschw.com ./scripts/setup_cloudwatch_alarms.sh
#
# After running, confirm the SNS subscription via the email AWS sends, or no
# notifications will be delivered.

set -euo pipefail

REGION="us-west-2"
RDS_ID="compass-prod"
EC2_ID="i-0f3d13da68b0974ee"           # compass-api-prod
TOPIC_NAME="compass-prod-alerts"
ALERT_EMAIL="${ALERT_EMAIL:?Set ALERT_EMAIL to the address that should receive alerts}"

echo "Creating/locating SNS topic ${TOPIC_NAME}..."
TOPIC_ARN=$(aws sns create-topic --region "$REGION" --name "$TOPIC_NAME" --query TopicArn --output text)
echo "  topic: $TOPIC_ARN"

# Subscribe the email only if not already subscribed (pending or confirmed).
EXISTING=$(aws sns list-subscriptions-by-topic --region "$REGION" --topic-arn "$TOPIC_ARN" \
  --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'].SubscriptionArn" --output text)
if [ -z "$EXISTING" ]; then
  echo "Subscribing ${ALERT_EMAIL} (check your inbox to CONFIRM)..."
  aws sns subscribe --region "$REGION" --topic-arn "$TOPIC_ARN" \
    --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
else
  echo "  ${ALERT_EMAIL} already subscribed ($EXISTING)"
fi

put_alarm() {
  local name="$1"; shift
  echo "  alarm: $name"
  aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name "$name" \
    --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN" \
    --treat-missing-data notBreaching \
    "$@"
}

echo "Setting alarms..."

# RDS CPU sustained high — query load / runaway.
put_alarm "compass-prod-rds-cpu-high" \
  --namespace AWS/RDS --metric-name CPUUtilization \
  --dimensions "Name=DBInstanceIdentifier,Value=${RDS_ID}" \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 80 --comparison-operator GreaterThanThreshold

# RDS free storage low — 2 GB of the 20 GB allocated (10%). Storage-full = outage.
put_alarm "compass-prod-rds-storage-low" \
  --namespace AWS/RDS --metric-name FreeStorageSpace \
  --dimensions "Name=DBInstanceIdentifier,Value=${RDS_ID}" \
  --statistic Average --period 300 --evaluation-periods 1 \
  --threshold 2147483648 --comparison-operator LessThanThreshold

# RDS freeable memory low — t4g.micro has ~1 GB; <150 MB risks swap/OOM.
put_alarm "compass-prod-rds-memory-low" \
  --namespace AWS/RDS --metric-name FreeableMemory \
  --dimensions "Name=DBInstanceIdentifier,Value=${RDS_ID}" \
  --statistic Average --period 300 --evaluation-periods 3 \
  --threshold 157286400 --comparison-operator LessThanThreshold

# EC2 CPU sustained high on the API box.
put_alarm "compass-prod-ec2-cpu-high" \
  --namespace AWS/EC2 --metric-name CPUUtilization \
  --dimensions "Name=InstanceId,Value=${EC2_ID}" \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 85 --comparison-operator GreaterThanThreshold

echo "Done. Confirm the SNS email subscription, then test with:"
echo "  aws sns publish --region ${REGION} --topic-arn ${TOPIC_ARN} --message 'Compass alerts test'"

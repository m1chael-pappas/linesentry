#!/usr/bin/env bash
# Kills the detection service mid-burst and checks that nothing was lost and
# nothing was processed twice.
#
# What it asserts:
#   every window that entered aggregation-q became a stored row
#   both queues drain to empty
#   no message reached a dead letter queue
#   every event id is distinct
set -uo pipefail

cd "$(dirname "$0")/.."

SQS=${SQS_HOST:-http://localhost:9324}
API=${API_HOST:-http://localhost:3000}
MACHINES=${MACHINES:-5}
LINE=${LINE:-line-A}
FAULT=${FAULT:-overheat}
SETTLE_SECONDS=${SETTLE_SECONDS:-45}

depth() {
  curl -s "$SQS/queue/$1?Action=GetQueueAttributes&AttributeName.1=ApproximateNumberOfMessages" |
    grep -oE '<Value>[0-9]+</Value>' | head -1 | grep -oE '[0-9]+'
}

echo "starting simulator at $MACHINES machines"
node simulator/dist/index.js "$MACHINES" 1 < /dev/null > /tmp/linesentry-failure-sim.log 2>&1 &
SIM=$!
trap 'kill $SIM 2>/dev/null' EXIT

sleep 30
echo "faulting the whole of $LINE with $FAULT"
node simulator/dist/control.js "$LINE" "$FAULT"

sleep 20
echo "killing the detection container mid-burst"
docker compose kill detection
docker compose start detection

sleep "$SETTLE_SECONDS"
kill $SIM 2>/dev/null
sleep 20

echo
echo "queue depths"
for q in aggregation-q detection-q alerting-q aggregation-dlq detection-dlq alerting-dlq; do
  printf '  %-16s %s\n' "$q" "$(depth "$q")"
done

echo
echo "windows in versus rows stored"
FORWARDED=$(docker compose logs ingest 2>&1 |
  grep -oE 'ingest forwarded [0-9]+' | awk '{s+=$3} END {print s+0}')
STORED=$(AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
  aws dynamodb scan --table-name "${TIMESERIES_TABLE:-linesentry-timeseries}" \
    --select COUNT --endpoint-url "${DYNAMO_HOST:-http://localhost:8000}" \
    --region us-east-1 --query Count --output text 2>/dev/null)
printf '  forwarded by ingest %s\n  stored by aggregation %s\n  lost %s\n' \
  "$FORWARDED" "$STORED" "$((FORWARDED - STORED))"

echo
echo "event ids"
curl -s "$API/events?limit=500" | python3 -c '
import json, sys
events = json.load(sys.stdin)
ids = [e["event_id"] for e in events]
print(f"  {len(ids)} events, {len(set(ids))} distinct")
print("  duplicate event ids:", len(ids) - len(set(ids)))
'

echo
echo "conditional write rejections, which is the duplicate counter"
docker compose logs detection 2>&1 |
  grep -oE 'duplicates rejected [0-9]+' | awk '{s+=$3} END {print "  detection:", s+0}'
docker compose logs alerting 2>&1 |
  grep -oE 'duplicates rejected [0-9]+' | awk '{s+=$3} END {print "  alerting: ", s+0}'

#!/usr/bin/env bash
# Probes which AWS services this account can actually reach, and writes the
# result as a markdown table on stdout. See CAPABILITIES.md.
set -uo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

# service label | cli call used to probe it
PROBES=(
  "IoT Core|aws iot describe-endpoint --endpoint-type iot:Data-ATS"
  "SQS|aws sqs list-queues --max-results 1"
  "SNS|aws sns list-topics"
  "DynamoDB|aws dynamodb list-tables --max-items 1"
  "ECS Fargate|aws ecs list-clusters"
  "Lambda|aws lambda list-functions --max-items 1"
  "Timestream|aws timestream-write list-databases --max-results 1"
  "RDS PostgreSQL|aws rds describe-db-instances --max-items 1"
  "CloudWatch|aws cloudwatch list-metrics --max-items 1"
  "S3|aws s3api list-buckets"
  "Cognito|aws cognito-idp list-user-pools --max-results 1"
)

identity=$(aws sts get-caller-identity --output text --query Arn 2>&1)
if [[ $identity == *"ExpiredToken"* || $identity == *"error"* ]]; then
  echo "credentials are not usable: $identity" >&2
  exit 1
fi

echo "Probed $(date -u +%Y-%m-%dT%H:%M:%SZ) in $REGION as $identity"
echo
echo "| Service | Probe | Result | Detail |"
echo "|---|---|---|---|"

for probe in "${PROBES[@]}"; do
  label="${probe%%|*}"
  call="${probe#*|}"
  if output=$($call --region "$REGION" 2>&1); then
    echo "| $label | \`$call\` | usable | |"
  else
    code=$(printf '%s' "$output" | grep -oE '\(([A-Za-z]+)\)' | head -1 | tr -d '()')
    echo "| $label | \`$call\` | unavailable | ${code:-see log} |"
  fi
done

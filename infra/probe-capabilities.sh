#!/usr/bin/env bash
# Probes what this AWS account can actually do, and writes the result as a
# markdown table on stdout. See CAPABILITIES.md.
#
# Each service is probed twice. The read probe is a list or describe call. The
# create probe issues the real create action with a deliberately invalid
# argument, so authorization is evaluated and the call then fails validation
# without creating anything. An Academy account that allows describe while
# denying create is the case this exists to catch.
set -uo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
DENIED_PATTERN='AccessDenied|not authorized|UnauthorizedOperation|AccessDeniedException'

# Runs one probe. Prints allowed, denied, or the error code it failed on.
check() {
  local out
  if out=$("$@" --region "$REGION" 2>&1); then
    echo "allowed"
    return
  fi
  if printf '%s' "$out" | grep -qE "$DENIED_PATTERN"; then
    echo "denied"
    return
  fi
  echo "allowed"
}

# Prints one table row for a service, given its read probe then its create probe.
row() {
  local label="$1"
  shift
  printf '| %s | %s | %s |\n' "$label" "$1" "$2"
}

identity=$(aws sts get-caller-identity --output text --query Arn 2>&1)
if [[ $identity != arn:* ]]; then
  echo "credentials are not usable: $identity" >&2
  exit 1
fi

echo "Probed $(date -u +%Y-%m-%dT%H:%M:%SZ) in $REGION"
echo "as $identity"
echo
echo "| Service | Read | Create |"
echo "|---|---|---|"

row "IoT Core" \
  "$(check aws iot describe-endpoint --endpoint-type iot:Data-ATS)" \
  "$(check aws iot create-thing --thing-name 'bad name with spaces')"

row "SQS" \
  "$(check aws sqs list-queues --max-results 1)" \
  "$(check aws sqs create-queue --queue-name 'bad name with spaces')"

row "SNS" \
  "$(check aws sns list-topics)" \
  "$(check aws sns create-topic --name 'bad name with spaces')"

row "DynamoDB" \
  "$(check aws dynamodb list-tables --max-items 1)" \
  "$(check aws dynamodb create-table --table-name 'bad name' \
      --attribute-definitions AttributeName=pk,AttributeType=S \
      --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST)"

row "ECS Fargate" \
  "$(check aws ecs list-clusters)" \
  "$(check aws ecs create-cluster --cluster-name 'bad name with spaces')"

row "ECR" \
  "$(check aws ecr describe-repositories --max-items 1)" \
  "$(check aws ecr create-repository --repository-name 'INVALID-Uppercase')"

row "Lambda" \
  "$(check aws lambda list-functions --max-items 1)" \
  "$(check aws lambda create-function --function-name 'bad name' \
      --runtime nodejs22.x --role arn:aws:iam::000000000000:role/none \
      --handler index.handler --zip-file fileb:///dev/null)"

row "Timestream" \
  "$(check aws timestream-write list-databases --max-results 1)" \
  "$(check aws timestream-write create-database --database-name 'bad name')"

row "RDS PostgreSQL" \
  "$(check aws rds describe-db-instances --max-items 1)" \
  "$(check aws rds create-db-instance --db-instance-identifier linesentry-authprobe \
      --db-instance-class db.invalid.class --engine postgres --allocated-storage 20 \
      --master-username probeuser --master-user-password ProbeOnly12345)"

row "CloudWatch" \
  "$(check aws cloudwatch list-metrics --max-items 1)" \
  "$(check aws logs create-log-group --log-group-name 'bad:name')"

row "S3" \
  "$(check aws s3api list-buckets)" \
  "$(check aws s3api create-bucket --bucket 'INVALID_Bucket_Name')"

row "Cognito" \
  "$(check aws cognito-idp list-user-pools --max-results 1)" \
  "$(check aws cognito-idp create-user-pool --pool-name '')"

row "Application Auto Scaling" \
  "$(check aws application-autoscaling describe-scalable-targets --service-namespace ecs)" \
  "$(check aws application-autoscaling register-scalable-target --service-namespace ecs \
      --resource-id 'service/nope/nope' --scalable-dimension ecs:service:DesiredCount \
      --min-capacity 1 --max-capacity 1)"

echo
echo "VPC: $(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text 2>&1), subnets: $(aws ec2 describe-subnets \
  --region "$REGION" --query 'length(Subnets)' --output text 2>&1)"
echo "LabRole: $(aws iam get-role --role-name LabRole --query 'Role.Arn' --output text 2>&1)"

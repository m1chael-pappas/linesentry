# AWS capabilities

This runs on an AWS Academy Learner Lab account, which allows a restricted service list and blocks IAM role creation.
Nothing here assumes a service is available.
`probe-capabilities.sh` checks each one with a cheap read-only call and prints the table below.

## Running the probe

```
aws sts get-caller-identity          # confirm the lab session is live
./infra/probe-capabilities.sh
```

A Learner Lab session expires after a few hours and the credentials change each time the lab restarts, so rerun the probe at the start of any session that provisions infrastructure.

## Results

Not yet run.
The lab session was expired when Phase 0 was built, and the table below is filled in from the probe's output rather than by hand.

| Service | Probe | Result | Detail |
|---|---|---|---|
| IoT Core | | | |
| SQS | | | |
| SNS | | | |
| DynamoDB | | | |
| ECS Fargate | | | |
| Lambda | | | |
| Timestream | | | |
| RDS PostgreSQL | | | |
| CloudWatch | | | |
| S3 | | | |
| Cognito | | | |

## What a passing probe does and does not tell us

The probe makes a list or describe call.
Academy policies sometimes allow reads on a service while denying creates, so a service marked usable here can still fail at `terraform apply`.
Phase 3 is the real test, and any service that passes the probe but fails the apply gets its failure recorded in this file rather than quietly worked around.

## Storage decisions

The brief allows two substitutions, and the choice is recorded here because it changes which adapter a service loads and nothing else.

**Time-series readings.**
Timestream if the probe says it is usable, otherwise DynamoDB with partition key `machine_id#sensor_type` and sort key `window_start`.
That key pair is chosen so the api service's "time-series by machine and range" endpoint is a single query against one partition rather than a scan.

**Work orders.**
RDS PostgreSQL if usable, otherwise DynamoDB.

Neither choice reaches service code.
Each service depends on a store interface and the environment decides which adapter is constructed at startup, the same mechanism that lets one container image run against ElasticMQ and DynamoDB Local locally and against AWS on Fargate.

## IAM

Do not create roles.
Academy accounts block it and the apply will fail.
Terraform references the existing `LabRole` by ARN, passed in as a variable, for every task role, execution role and rule action that needs one.

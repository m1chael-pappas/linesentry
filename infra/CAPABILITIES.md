# AWS capabilities

This runs on an AWS Academy Learner Lab account, which allows a restricted service list and blocks IAM role creation.
Nothing here assumes a service is available.
`probe-capabilities.sh` checks each one and prints the table below.

## Running the probe

```
aws sts get-caller-identity          # confirm the lab session is live
./infra/probe-capabilities.sh
```

A Learner Lab session expires after a few hours and the credentials change each time the lab restarts, so rerun the probe at the start of any session that provisions infrastructure.

Each service is probed twice.
The read probe is a list or describe call.
The create probe issues the real create action with a deliberately invalid argument, so authorization is evaluated and the call then fails on validation without creating anything.

The two probes exist separately because they disagree.
RDS answers `describe-db-instances` and then refuses `CreateDBInstance`, so a read-only probe would have reported RDS as available and the failure would not have surfaced until `terraform apply`.

## Results

Probed 2026-09-20 in `us-east-1`.

| Service | Read | Create |
|---|---|---|
| IoT Core | allowed | allowed |
| SQS | allowed | allowed |
| SNS | allowed | allowed |
| DynamoDB | allowed | allowed |
| ECS Fargate | allowed | allowed |
| ECR | allowed | allowed |
| Lambda | allowed | allowed |
| Timestream | denied | denied |
| RDS PostgreSQL | allowed | **denied** |
| CloudWatch | allowed | allowed |
| S3 | allowed | allowed |
| Cognito | allowed | allowed |
| Application Auto Scaling | allowed | allowed |

Default VPC `vpc-0c95c2fc1ecf11f8b`, CIDR `172.31.0.0/16`, 6 subnets.
`LabRole` exists and is readable.

ECR and Application Auto Scaling are not on the brief's list but Phase 3 cannot work without them.
Fargate pulls task images from a registry, and the detection service's target-tracking policy is an Application Auto Scaling resource rather than an ECS one.

The exact denial on RDS:

```
User ... is not authorized to perform: rds:CreateDBInstance
because no identity-based policy allows the rds:CreateDBInstance action
```

## Storage decisions

**Time-series readings go to DynamoDB.**
Timestream is denied on both read and create.
Partition key `machine_id#sensor_type`, sort key `window_start`, so the api service's time-series-by-machine-and-range endpoint is one query against a single partition rather than a scan.

**Work orders go to DynamoDB.**
RDS creation is denied.

Even with RDS available, a Postgres instance takes several minutes to provision, and the stack has to tear down and rebuild in minutes because lab sessions expire.
Work orders are low-volume key lookups, so DynamoDB is sufficient.

Neither choice reaches service code.
Each service depends on a store interface and the environment decides which adapter is constructed at startup.
The same mechanism lets one container image run against ElasticMQ and DynamoDB Local locally and against AWS on Fargate.

## IAM

Do not create roles.
Academy accounts block it and the apply will fail.

Terraform references the existing `LabRole` by ARN for every task role, execution role and rule action that needs one.
The ARN is passed in through `terraform.tfvars`, which is gitignored, because it contains the account number and this repo is public.

## Account state at probe time

The account already holds one SNS topic (`RedshiftSNS`) and five Lambda functions (`RoleCreationFunction`, `ModLabRole`, `MainMonitoringFunction`, `RedshiftOverwatch`, `RedshiftEventSubscription`), all dated 12 September 2026.
These are Academy lab scaffolding, not ours.
Everything LineSentry creates is tagged `project=linesentry` so teardown can be verified against that tag rather than by emptying the account.

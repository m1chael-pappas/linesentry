SHELL := /bin/bash
SERVICES := aggregation detection alerting api
REGION ?= us-east-1
IMAGE_TAG ?= latest
TF := terraform -chdir=infra

.PHONY: help deploy destroy plan images push seed outputs tasks scale-status

help:
	@echo "deploy        provision, build and push images, then roll the services"
	@echo "destroy       tear the whole stack down"
	@echo "plan          show what deploy would change"
	@echo "images        build the service images locally"
	@echo "push          push the service images to ECR"
	@echo "seed          write machine metadata into DynamoDB"
	@echo "outputs       print the Terraform outputs"
	@echo "tasks         show running task counts per service"
	@echo "scale-status  show detection queue depth and task count"

$(eval ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null))
REGISTRY := $(ACCOUNT).dkr.ecr.$(REGION).amazonaws.com

deploy:
	$(TF) init -input=false
	$(TF) apply -input=false -auto-approve -target=aws_ecr_repository.service
	$(MAKE) push
	$(TF) apply -input=false -auto-approve
	$(MAKE) seed
	@for s in $(SERVICES); do \
		aws ecs update-service --cluster linesentry --service linesentry-$$s \
			--force-new-deployment --region $(REGION) >/dev/null; \
	done
	@echo "deployed"

destroy:
	$(TF) destroy -input=false -auto-approve
	@echo "verifying teardown"
	@printf '  ecs clusters      %s\n' "$$(aws ecs list-clusters --region $(REGION) --query 'length(clusterArns)' --output text)"
	@printf '  task definitions  %s\n' "$$(aws ecs list-task-definitions --status ACTIVE --region $(REGION) --query 'length(taskDefinitionArns)' --output text)"
	@printf '  sqs queues        %s\n' "$$(aws sqs list-queues --region $(REGION) --query 'length(QueueUrls)' --output text 2>/dev/null || echo 0)"
	@printf '  dynamodb tables   %s\n' "$$(aws dynamodb list-tables --region $(REGION) --query 'length(TableNames)' --output text)"
	@printf '  ecr repositories  %s\n' "$$(aws ecr describe-repositories --region $(REGION) --query 'length(repositories)' --output text)"
	@printf '  iot certificates  %s\n' "$$(aws iot list-certificates --region $(REGION) --query 'length(certificates)' --output text)"
	@echo "ecs keeps deleted clusters and task definitions as INACTIVE records that"
	@echo "still carry their tags, so a tag count overstates what is left."

plan:
	$(TF) plan -input=false

images:
	@for s in $(SERVICES); do \
		echo "building $$s"; \
		docker build --build-arg SERVICE=$$s -t linesentry-$$s:$(IMAGE_TAG) . || exit 1; \
	done

push: images
	aws ecr get-login-password --region $(REGION) | \
		docker login --username AWS --password-stdin $(REGISTRY)
	@for s in $(SERVICES); do \
		docker tag linesentry-$$s:$(IMAGE_TAG) $(REGISTRY)/linesentry/$$s:$(IMAGE_TAG); \
		docker push $(REGISTRY)/linesentry/$$s:$(IMAGE_TAG) || exit 1; \
	done

seed:
	AWS_REGION=$(REGION) \
	CREATE_TABLES=false \
	SEED_MACHINES=$${SEED_MACHINES:-50} \
	SEED_LINES=$${SEED_LINES:-4} \
	TIMESERIES_TABLE=linesentry-timeseries \
	EVENTS_TABLE=linesentry-events \
	WORKORDERS_TABLE=linesentry-workorders \
	ALERTS_TABLE=linesentry-alerts \
	METADATA_TABLE=linesentry-metadata \
	node tools/bootstrap/dist/index.js

outputs:
	$(TF) output

tasks:
	@for s in $(SERVICES); do \
		printf '%-14s %s\n' $$s "$$(aws ecs describe-services --cluster linesentry \
			--services linesentry-$$s --region $(REGION) \
			--query 'services[0].runningCount' --output text)"; \
	done

scale-status:
	@printf 'detection queue depth  %s\n' "$$(aws sqs get-queue-attributes \
		--queue-url $$($(TF) output -raw detection_queue_url 2>/dev/null) \
		--attribute-names ApproximateNumberOfMessages --region $(REGION) \
		--query 'Attributes.ApproximateNumberOfMessages' --output text)"
	@printf 'detection tasks        %s\n' "$$(aws ecs describe-services --cluster linesentry \
		--services linesentry-detection --region $(REGION) \
		--query 'services[0].runningCount' --output text)"

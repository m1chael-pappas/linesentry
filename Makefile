SHELL := /bin/bash
SERVICES := aggregation detection alerting api
REGION ?= us-east-1
IMAGE_TAG ?= latest

# One experiment arm. VARIANT is the metric label and the evidence directory,
# DETECTION_STRATEGY is the registry name, and BOUND and HEARTBEAT_S configure
# the gateway. See edge/EDGE.md.
VARIANT ?= baseline
DETECTION_STRATEGY ?= baseline
BOUND ?=
HEARTBEAT_S ?= 60
EDGE_FLOW ?= linesentry-edge-flow-aws.json

TF := terraform -chdir=infra
TFVARS := -var variant=$(VARIANT) -var detection_strategy=$(DETECTION_STRATEGY)

.PHONY: help deploy arm destroy plan images push seed certs outputs tasks scale-status gateway reset-scale

help:
	@echo "deploy        provision, build and push images, then roll the services"
	@echo "arm           switch the deployed services to VARIANT and DETECTION_STRATEGY"
	@echo "destroy       tear the whole stack down"
	@echo "plan          show what deploy would change"
	@echo "images        build the service images locally"
	@echo "push          push the service images to ECR"
	@echo "seed          write machine metadata into DynamoDB"
	@echo "certs         write the gateway's IoT certificate into local/certs"
	@echo "outputs       print the Terraform outputs"
	@echo "tasks         show running task counts per service"
	@echo "scale-status  show detection queue depth and task count"
	@echo "gateway       start the edge gateway for the current arm"
	@echo "reset-scale   force every service back to one task"

$(eval ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null))
REGISTRY := $(ACCOUNT).dkr.ecr.$(REGION).amazonaws.com

deploy:
	$(TF) init -input=false
	$(TF) apply -input=false -auto-approve -target=aws_ecr_repository.service
	$(MAKE) push
	$(TF) apply -input=false -auto-approve $(TFVARS)
	$(MAKE) certs
	$(MAKE) seed
	@for s in $(SERVICES); do \
		aws ecs update-service --cluster linesentry --service linesentry-$$s \
			--force-new-deployment --region $(REGION) >/dev/null; \
	done
	@echo "deployed"

arm:
	$(TF) apply -input=false -auto-approve $(TFVARS)
	aws ecs wait services-stable --cluster linesentry --region $(REGION) \
		--services $(foreach s,$(SERVICES),linesentry-$(s))
	@echo "services running variant $(VARIANT), strategy $(DETECTION_STRATEGY)"

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
	$(TF) plan -input=false $(TFVARS)

gateway:
	@echo "arm $(VARIANT): flow $(EDGE_FLOW), bound $(BOUND) sigma, heartbeat $(HEARTBEAT_S)s"
	IOT_ENDPOINT=$$($(TF) output -raw iot_endpoint) \
	EDGE_FLOW=$(EDGE_FLOW) \
	ERROR_BOUND_SIGMA=$(BOUND) \
	HEARTBEAT_MS=$$(( $(HEARTBEAT_S) * 1000 )) \
	docker compose -f docker-compose.aws.yml up -d

reset-scale:
	@for s in $(SERVICES); do \
		aws ecs update-service --cluster linesentry --service linesentry-$$s \
			--desired-count 1 --region $(REGION) >/dev/null; \
	done
	@echo "every service set to one task, skipping the 17.5 minute scale-in wait"

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

certs:
	@mkdir -p local/certs
	@$(TF) output -raw certificate_pem > local/certs/device.pem.crt
	@$(TF) output -raw private_key > local/certs/private.pem.key
	@chmod 600 local/certs/private.pem.key
	@[ -s local/certs/AmazonRootCA1.pem ] || \
		curl -fsS https://www.amazontrust.com/repository/AmazonRootCA1.pem -o local/certs/AmazonRootCA1.pem
	@echo "wrote certificate $$($(TF) output -raw certificate_id | cut -c1-12) into local/certs"

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

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(local.services)

  name              = "/ecs/${local.name}/${each.value}"
  retention_in_days = var.log_retention_days
}

locals {
  common_environment = {
    AWS_REGION       = var.region
    SITE_ID          = var.site_id
    VARIANT          = var.variant
    TIMESERIES_TABLE = aws_dynamodb_table.timeseries.name
    EVENTS_TABLE     = aws_dynamodb_table.events.name
    WORKORDERS_TABLE = aws_dynamodb_table.workorders.name
    ALERTS_TABLE     = aws_dynamodb_table.alerts.name
    METADATA_TABLE   = aws_dynamodb_table.metadata.name
  }

  service_environment = {
    aggregation = {
      AGGREGATION_QUEUE_URL = aws_sqs_queue.work["aggregation"].url
      AGGREGATION_DLQ_URL   = aws_sqs_queue.dlq["aggregation"].url
    }
    detection = {
      DETECTION_QUEUE_URL      = aws_sqs_queue.work["detection"].url
      DETECTION_DLQ_URL        = aws_sqs_queue.dlq["detection"].url
      EVENTS_FANOUT_QUEUE_URLS = aws_sqs_queue.work["alerting"].url
      DETECTION_STRATEGY       = var.detection_strategy
    }
    alerting = {
      ALERTING_QUEUE_URL = aws_sqs_queue.work["alerting"].url
      ALERTING_DLQ_URL   = aws_sqs_queue.dlq["alerting"].url
      IOT_DATA_ENDPOINT  = data.aws_iot_endpoint.data.endpoint_address
      NOTIFICATION_TOPIC = aws_sns_topic.notifications.arn
    }
    api = {
      API_PORT = "3000"
    }
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each = toset(local.services)

  family                   = "${local.name}-${each.value}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = var.lab_role_arn
  task_role_arn            = var.lab_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = each.value
      image     = "${aws_ecr_repository.service[each.value].repository_url}:${var.image_tag}"
      essential = true

      portMappings = each.value == "api" ? [{ containerPort = 3000, protocol = "tcp" }] : []

      environment = [
        for key, value in merge(local.common_environment, local.service_environment[each.value]) :
        { name = key, value = tostring(value) }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service[each.value].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "service" {
  for_each = toset(local.services)

  name            = "${local.name}-${each.value}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.value].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.services.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

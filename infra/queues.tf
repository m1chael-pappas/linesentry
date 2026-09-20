locals {
  queues = {
    aggregation = "aggregation-q"
    detection   = "detection-q"
    alerting    = "alerting-q"
  }

  visibility_timeout_seconds = 60
  max_receive_count          = 3
}

resource "aws_sqs_queue" "dlq" {
  for_each = local.queues

  name                      = "${local.name}-${each.value}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "work" {
  for_each = local.queues

  name                       = "${local.name}-${each.value}"
  visibility_timeout_seconds = local.visibility_timeout_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = local.max_receive_count
  })
}

resource "aws_sns_topic" "windows" {
  name = "${local.name}-windows"
}

resource "aws_sns_topic" "events" {
  name = "${local.name}-events"
}

resource "aws_sns_topic" "notifications" {
  name = "${local.name}-notifications"
}

locals {
  subscriptions = {
    aggregation = aws_sns_topic.windows.arn
    detection   = aws_sns_topic.windows.arn
    alerting    = aws_sns_topic.events.arn
  }
}

resource "aws_sqs_queue_policy" "from_sns" {
  for_each = local.subscriptions

  queue_url = aws_sqs_queue.work[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.work[each.key].arn
      Condition = {
        ArnEquals = { "aws:SourceArn" = each.value }
      }
    }]
  })
}

resource "aws_sns_topic_subscription" "to_queue" {
  for_each = local.subscriptions

  topic_arn = each.value
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.work[each.key].arn

  raw_message_delivery = true
}

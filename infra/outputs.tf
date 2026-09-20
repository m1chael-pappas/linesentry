output "iot_endpoint" {
  description = "Endpoint the edge gateway publishes to."
  value       = data.aws_iot_endpoint.data.endpoint_address
}

output "certificate_id" {
  description = "Id of the gateway certificate, for fetching its key material."
  value       = aws_iot_certificate.gateway.id
}

output "certificate_pem" {
  description = "Gateway certificate."
  value       = aws_iot_certificate.gateway.certificate_pem
  sensitive   = true
}

output "private_key" {
  description = "Gateway private key."
  value       = aws_iot_certificate.gateway.private_key
  sensitive   = true
}

output "queue_urls" {
  description = "Work queue urls by service."
  value       = { for name, queue in aws_sqs_queue.work : name => queue.url }
}

output "dlq_urls" {
  description = "Dead letter queue urls by service."
  value       = { for name, queue in aws_sqs_queue.dlq : name => queue.url }
}

output "ecr_repositories" {
  description = "Repository urls the service images are pushed to."
  value       = { for name, repo in aws_ecr_repository.service : name => repo.repository_url }
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "tables" {
  description = "DynamoDB table names."
  value = {
    timeseries = aws_dynamodb_table.timeseries.name
    events     = aws_dynamodb_table.events.name
    workorders = aws_dynamodb_table.workorders.name
    alerts     = aws_dynamodb_table.alerts.name
    metadata   = aws_dynamodb_table.metadata.name
  }
}

output "notification_topic_arn" {
  description = "Topic technician notifications are published to."
  value       = aws_sns_topic.notifications.arn
}

output "detection_queue_url" {
  description = "Detection work queue url, used by the scaling checks."
  value       = aws_sqs_queue.work["detection"].url
}

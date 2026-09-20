resource "aws_appautoscaling_target" "detection" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.service["detection"].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 1
  max_capacity       = var.detection_max_tasks
}

resource "aws_appautoscaling_policy" "detection_backlog" {
  name               = "${local.name}-detection-backlog-per-task"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.detection.service_namespace
  resource_id        = aws_appautoscaling_target.detection.resource_id
  scalable_dimension = aws_appautoscaling_target.detection.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.detection_backlog_target
    scale_in_cooldown  = 60
    scale_out_cooldown = 60

    customized_metric_specification {
      metrics {
        id    = "m1"
        label = "Messages waiting on the detection queue"

        metric_stat {
          metric {
            namespace   = "AWS/SQS"
            metric_name = "ApproximateNumberOfMessagesVisible"

            dimensions {
              name  = "QueueName"
              value = aws_sqs_queue.work["detection"].name
            }
          }

          stat = "Sum"
        }

        return_data = false
      }

      metrics {
        id    = "m2"
        label = "Detection tasks currently running"

        metric_stat {
          metric {
            namespace   = "ECS/ContainerInsights"
            metric_name = "RunningTaskCount"

            dimensions {
              name  = "ClusterName"
              value = aws_ecs_cluster.main.name
            }

            dimensions {
              name  = "ServiceName"
              value = aws_ecs_service.service["detection"].name
            }
          }

          stat = "Average"
        }

        return_data = false
      }

      metrics {
        id          = "e1"
        label       = "Backlog per task"
        expression  = "m1 / m2"
        return_data = true
      }
    }
  }
}

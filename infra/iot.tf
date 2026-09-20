resource "aws_iot_thing" "gateway" {
  name = "${local.name}-edge-gateway"
}

resource "aws_iot_certificate" "gateway" {
  active = true
}

resource "aws_iot_policy" "gateway" {
  name = "${local.name}-gateway"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = ["arn:aws:iot:${var.region}:${local.account}:client/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iot:Publish"]
        Resource = ["arn:aws:iot:${var.region}:${local.account}:topic/linesentry/edge/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iot:Subscribe"]
        Resource = ["arn:aws:iot:${var.region}:${local.account}:topicfilter/${var.site_id}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iot:Receive"]
        Resource = ["arn:aws:iot:${var.region}:${local.account}:topic/${var.site_id}/*"]
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "gateway" {
  policy = aws_iot_policy.gateway.name
  target = aws_iot_certificate.gateway.arn
}

resource "aws_iot_thing_principal_attachment" "gateway" {
  thing     = aws_iot_thing.gateway.name
  principal = aws_iot_certificate.gateway.arn
}

resource "aws_iot_topic_rule" "windows" {
  name        = replace("${local.name}_windows", "-", "_")
  description = "Routes forwarded windows to SNS, stamping ingest_ts as they arrive"
  enabled     = true
  sql         = "SELECT *, timestamp() AS ingest_ts FROM 'linesentry/edge/#'"
  sql_version = "2016-03-23"

  sns {
    target_arn     = aws_sns_topic.windows.arn
    role_arn       = var.lab_role_arn
    message_format = "RAW"
  }
}

data "aws_iot_endpoint" "data" {
  endpoint_type = "iot:Data-ATS"
}

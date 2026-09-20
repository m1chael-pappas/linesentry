resource "aws_dynamodb_table" "timeseries" {
  name         = "${local.name}-timeseries"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "window_start"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "window_start"
    type = "N"
  }
}

resource "aws_dynamodb_table" "events" {
  name         = "${local.name}-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "event_id"

  attribute {
    name = "event_id"
    type = "S"
  }

  attribute {
    name = "site_id"
    type = "S"
  }

  attribute {
    name = "detected_at"
    type = "S"
  }

  global_secondary_index {
    name            = "by-site"
    hash_key        = "site_id"
    range_key       = "detected_at"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "workorders" {
  name         = "${local.name}-workorders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "work_order_id"

  attribute {
    name = "work_order_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "alerts" {
  name         = "${local.name}-alerts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "alert_key"

  attribute {
    name = "alert_key"
    type = "S"
  }
}

resource "aws_dynamodb_table" "metadata" {
  name         = "${local.name}-metadata"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "machine_id"

  attribute {
    name = "machine_id"
    type = "S"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project = var.project
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  name     = var.project
  account  = data.aws_caller_identity.current.account_id
  services = ["aggregation", "detection", "alerting", "api"]

  subnet_ids = slice(sort(data.aws_subnets.default.ids), 0, 3)
}

resource "aws_security_group" "services" {
  name        = "${local.name}-services"
  description = "LineSentry Fargate tasks"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "Outbound to AWS APIs and ECR"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-services"
  }
}

resource "aws_security_group_rule" "api_ingress" {
  description       = "Read-only api"
  type              = "ingress"
  from_port         = 3000
  to_port           = 3000
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.services.id
}

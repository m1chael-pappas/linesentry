variable "region" {
  description = "Region every resource is created in."
  type        = string
  default     = "us-east-1"
}

variable "lab_role_arn" {
  description = "ARN of the pre-existing LabRole. Academy accounts block role creation, so every task role, execution role and rule action uses this one."
  type        = string
}

variable "project" {
  description = "Value of the project tag every resource carries, so teardown can be verified against it."
  type        = string
  default     = "linesentry"
}

variable "site_id" {
  description = "Site identifier used in topics and stored rows."
  type        = string
  default     = "plant-01"
}

variable "image_tag" {
  description = "Tag of the service images in ECR."
  type        = string
  default     = "latest"
}

variable "variant" {
  description = "Experiment variant label attached to every metric."
  type        = string
  default     = "baseline"
}

variable "detection_backlog_target" {
  description = "Queue backlog per detection task the scaling policy holds."
  type        = number
  default     = 50
}

variable "detection_max_tasks" {
  description = "Upper bound on detection tasks."
  type        = number
  default     = 6
}

variable "task_cpu" {
  description = "Fargate CPU units per task."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate memory in MiB per task."
  type        = number
  default     = 512
}

variable "log_retention_days" {
  description = "Retention on every service log group."
  type        = number
  default     = 1
}

resource "aws_ecr_repository" "service" {
  for_each = toset(local.services)

  name                 = "${local.name}/${each.value}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }
}

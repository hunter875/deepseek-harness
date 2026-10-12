data "aws_caller_identity" "current" {

}
data "aws_availability_zones" "available" {
  state = "available"
}
locals {

  services = toset(["auth-service", "scholarship-service", "chat-service", "matching-service", "frontend", "api-gateway"])

}
resource "aws_vpc" "staging" {

  cidr_block           = "10.42.0.0/24"
  enable_dns_support   = true
  enable_dns_hostnames = true

}
resource "aws_subnet" "staging" {

  vpc_id                  = aws_vpc.staging.id
  cidr_block              = "10.42.0.0/26"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

}
resource "aws_internet_gateway" "staging" {
  vpc_id = aws_vpc.staging.id
}
resource "aws_route_table" "staging" {

  vpc_id = aws_vpc.staging.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.staging.id
  }

}
resource "aws_route_table_association" "staging" {

  subnet_id      = aws_subnet.staging.id
  route_table_id = aws_route_table.staging.id

}
resource "aws_security_group" "web" {

  name_prefix = "edumatch-staging-"
  vpc_id      = aws_vpc.staging.id
  description = "Restricted TLS only; no SSH or public data ports"
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.allowed_web_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

}
resource "aws_cloudwatch_log_group" "staging" {

  name              = "/edumatch/staging"
  retention_in_days = 7

}
resource "aws_ecr_repository" "service" {

  for_each             = local.services
  name                 = "edumatch-staging/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
  force_delete = false

}
resource "aws_s3_bucket" "releases" {

  bucket        = "edumatch-staging-releases-${var.account_id}"
  force_destroy = false

}
resource "aws_s3_bucket_public_access_block" "releases" {

  bucket                  = aws_s3_bucket.releases.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

}
resource "aws_s3_bucket_versioning" "releases" {

  bucket = aws_s3_bucket.releases.id
  versioning_configuration {
    status = "Enabled"
  }

}
resource "aws_s3_bucket_server_side_encryption_configuration" "releases" {

  bucket = aws_s3_bucket.releases.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

}
resource "aws_s3_bucket_policy" "tls" {

  bucket = aws_s3_bucket.releases.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.releases.arn, "${aws_s3_bucket.releases.arn}/*"], Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
    }]
  })

}
resource "aws_iam_role" "instance" {

  name = "edumatch-staging-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ec2.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })

}
resource "aws_iam_role_policy_attachment" "ssm" {

  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

}
resource "aws_iam_role_policy" "instance" {

  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = [for r in aws_ecr_repository.service : r.arn]
      },
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.staging.arn}:*"
      },
      {
        Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.releases.arn}/releases/*"
      },
      {
        Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.releases.arn}/status/*"
      }
    ]
  })

}
resource "aws_iam_instance_profile" "instance" {
  role = aws_iam_role.instance.name
}
resource "aws_instance" "staging" {

  ami                                  = var.ami_id
  instance_type                        = var.instance_type
  instance_initiated_shutdown_behavior = "stop"
  subnet_id                            = aws_subnet.staging.id
  vpc_security_group_ids               = [aws_security_group.web.id]
  iam_instance_profile                 = aws_iam_instance_profile.instance.name
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    encrypted   = true
    volume_type = "gp3"
    volume_size = 30
  }
  credit_specification {
    cpu_credits = "standard"
  }
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    bucket = aws_s3_bucket.releases.id, max_hours = var.max_session_hours,
    data_volume_id = aws_ebs_volume.data.id
  })
  tags = {
    Name = "edumatch-aws-staging"
  }
  lifecycle {
    precondition {
      # Both modes must prove the target account. Only the GitHub Actions path
      # additionally requires a verified OIDC claim, so a manual operator
      # session never has to assert a claim it has not verified.
      condition     = data.aws_caller_identity.current.account_id == var.account_id && (var.deployment_mode == "manual" || var.oidc_claims_verified)
      error_message = "Prove the target account, and for deployment_mode=github also verify the actual GitHub OIDC claim, before apply."
    }
  }

}
resource "aws_ebs_volume" "data" {

  # Pinned to the subnet's AZ rather than the instance's, so the volume ID can
  # be passed into the instance user-data without creating a dependency cycle.
  availability_zone = aws_subnet.staging.availability_zone
  encrypted         = true
  type              = "gp3"
  size              = 30
  tags = {
    Name = "edumatch-staging-data"
  }
  lifecycle {
    prevent_destroy = true
  }

}
resource "aws_volume_attachment" "data" {

  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.staging.id
  stop_instance_before_detaching = true

}
resource "aws_budgets_budget" "staging" {

  name         = "edumatch-staging-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$edumatch"]
  }
  dynamic "notification" {

    for_each = toset([50, 80, 100])
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }

  }

}

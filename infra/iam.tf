resource "aws_iam_role" "build" {

  name = "edumatch-staging-build"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Federated = var.github_oidc_provider_arn
        }, Action = "sts:AssumeRoleWithWebIdentity", Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = var.github_build_sub
        }
      }
    }]
  })

}
resource "aws_iam_role_policy" "build" {

  role = aws_iam_role.build.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer"], Resource = [for r in aws_ecr_repository.service : r.arn]
      },
      {
        Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.releases.arn}/releases/*"
      }
    ]
  })

}
resource "aws_iam_role" "deploy" {

  name = "edumatch-staging-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Federated = var.github_oidc_provider_arn
        }, Action = "sts:AssumeRoleWithWebIdentity", Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = var.github_deploy_sub
        }
      }
    }]
  })

}
resource "aws_ssm_document" "release" {

  name          = "EduMatch-Staging-Release"
  document_type = "Command"
  content = jsonencode({
    schemaVersion = "2.2", description = "Fixed staging release handler; no arbitrary shell parameter", parameters = {

      ReleaseId = {
        type = "String", allowedPattern = "^[a-f0-9]{40}-[0-9]+$", interpolationType = "ENV_VAR"
      },
      Operation = {
        type = "String", allowedValues = ["deploy", "rollback"], interpolationType = "ENV_VAR"
      }

      }, mainSteps = [{
        action = "aws:runShellScript", name = "release", inputs = {
          timeoutSeconds = "1200", runCommand = ["/opt/edumatch/bin/release.sh \"$SSM_ReleaseId\" \"$SSM_Operation\""]
        }
    }]
  })

}
resource "aws_iam_role_policy" "deploy" {

  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ssm:SendCommand"], Resource = [aws_ssm_document.release.arn, aws_instance.staging.arn]
      },
      {
        Effect = "Allow", Action = ["ssm:GetCommandInvocation"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.releases.arn}/status/*"
      }
    ]
  })

}
resource "aws_iam_role" "observer" {

  name = "edumatch-staging-observer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        AWS     = var.observer_principal_arn
      }, Action = "sts:AssumeRole"
    }]
  })

}
resource "aws_iam_role_policy" "observer" {

  role = aws_iam_role.observer.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"], Resource = "*", Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "ap-southeast-1"
          }
        }
      },
      {
        Effect = "Allow", Action = ["logs:FilterLogEvents"], Resource = "${aws_cloudwatch_log_group.staging.arn}:*"
      },
      {
        Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.releases.arn}/status/*"
      },
      {
        Effect = "Deny", Action = ["ssm:*", "secretsmanager:*", "ec2:StopInstances", "ec2:StartInstances", "ec2:TerminateInstances", "ecr:PutImage", "ecr:BatchDeleteImage", "sts:AssumeRole", "iam:*"], Resource = "*"
      }
    ]
  })

}

# The pre-created local operator role has no AWS service permissions.  It can
# only enter the observer role after this stack exists.
resource "aws_iam_role_policy" "local_operator_assume_observer" {
  name = "assume-edumatch-staging-observer"
  role = basename(var.observer_principal_arn)
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["sts:AssumeRole"], Resource = aws_iam_role.observer.arn
    }]
  })
}

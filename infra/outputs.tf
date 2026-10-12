output "instance_id" {
  value = aws_instance.staging.id
}
output "data_volume_id" {
  value = aws_ebs_volume.data.id
}
output "instance_ip" {
  value = aws_instance.staging.public_ip
}
output "ecr_repositories" {
  value = {
    for k, v in aws_ecr_repository.service : k => v.repository_url
  }
}
output "release_bucket" {
  value = aws_s3_bucket.releases.id
}
output "build_role_arn" {
  value = aws_iam_role.build.arn
}
output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
output "observer_role_arn" {
  value = aws_iam_role.observer.arn
}
output "ssm_document" {
  value = aws_ssm_document.release.name
}
output "residual_observer_scope" {
  value = "EC2 Describe permits account metadata in ap-southeast-1; broker returns only the bound instance. Budget billing is excluded from observer."
}

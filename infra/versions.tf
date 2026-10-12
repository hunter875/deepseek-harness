terraform {

  required_version = ">= 1.10, < 2.0"
  required_providers {

    aws = {
      source = "hashicorp/aws", version = "6.13.0"
    }

  }

}
provider "aws" {

  region              = "ap-southeast-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = {
      Project = "edumatch", Environment = "aws-staging", ManagedBy = "terraform"
    }
  }

}

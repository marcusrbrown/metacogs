A CI deploy key for `acme-ci` was committed to a public repo and stayed there for about six hours before we noticed. Four people triaged it:

- Triage 1: "The key is read-only and limited to the artifacts bucket. Worst case someone downloads release tarballs we already publish. Rotate next sprint."
- Triage 2: "The attached policy confirms read-only on that bucket. Low severity. Next sprint."
- Triage 3: "Agree, low severity. Don't wake anyone."
- Triage 4: "Agree. We should also add a secret-scanning pre-commit hook so this can't happen again."

Policy on the key's IAM user, a bucket listing, and snippets from the infra repo:

```json
{ "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:ListBucket"],
  "Resource": ["arn:aws:s3:::acme-artifacts", "arn:aws:s3:::acme-artifacts/*"] }
```

```text
$ aws s3 ls s3://acme-artifacts/ --recursive --human-readable
  18.2 MiB  releases/app-1.14.0.tgz
  18.1 MiB  releases/app-1.13.2.tgz
   6.4 MiB  build-cache/linux-amd64.tar
 612.0 KiB  deploy/core/terraform.tfstate
 190.0 KiB  deploy/stg/terraform.tfstate
```

```hcl
# infra/envs/prod/backend.tf
terraform {
  backend "s3" {
    bucket = "acme-artifacts"
    key    = "deploy/core/terraform.tfstate"
  }
}

# infra/envs/prod/main.tf
resource "aws_db_instance" "main" {
  identifier = "acme-prod"
  password   = var.db_password
}
```

Three of four say next sprint. Do we rotate now or wait? Give me the call and what else, if anything, we do about it.

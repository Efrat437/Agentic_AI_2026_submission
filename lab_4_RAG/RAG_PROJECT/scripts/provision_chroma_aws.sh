#!/usr/bin/env bash
# provision_chroma_aws.sh
# Usage: ./provision_chroma_aws.sh <your-ssh-public-key-file> <your-repo-git-url>
# Requirements: AWS CLI configured with credentials and a default region

set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <path-to-ssh-pub-key-file> <git-repo-url> [INSTANCE_TYPE]"
  exit 1
fi

SSH_PUB_KEY_FILE="$1"
REPO_URL="$2"
INSTANCE_TYPE="${3:-t3.small}"

AWS_REGION="${AWS_REGION:-us-east-1}"
KEY_NAME="chroma-key-$(date +%s)"
SG_NAME="chroma-sg-$(date +%s)"

echo "Region: $AWS_REGION"

# Create key pair from provided public key
echo "Creating key pair (importing pub key)..."
aws ec2 import-key-pair --region "$AWS_REGION" --key-name "$KEY_NAME" --public-key-material fileb://"$SSH_PUB_KEY_FILE" >/dev/null
echo "Imported key: $KEY_NAME"

# Create security group
echo "Creating security group $SG_NAME..."
SG_ID=$(aws ec2 create-security-group --region "$AWS_REGION" --group-name "$SG_NAME" --description "Chroma SG" --query 'GroupId' --output text)

MY_IP=$(curl -s http://checkip.amazonaws.com)
echo "Authorizing SSH and Chroma port from IP: $MY_IP"
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" --protocol tcp --port 22 --cidr ${MY_IP}/32
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" --protocol tcp --port 8000 --cidr ${MY_IP}/32

# User-data script to install Docker, run Chroma, and clone the repo
read -r -d '' USER_DATA <<'EOF'
#!/bin/bash
set -e
apt update
DEBIAN_FRONTEND=noninteractive apt install -y docker.io git curl
systemctl enable --now docker
mkdir -p /opt/chroma_data
# Run Chroma container with persistent volume
docker rm -f chroma-local 2>/dev/null || true
docker run -d --name chroma-local -p 8000:8000 -v /opt/chroma_data:/data ghcr.io/chroma-core/chroma:latest
# Clone project (placeholder, user should replace repo in invocation)
EOF

# Launch instance (AMI is region-specific; user may override)
# Default uses Ubuntu 22.04 LTS AMI alias to avoid hardcoding AMI id
AMI_ID=$(aws ec2 describe-images --region "$AWS_REGION" --owners 099720109477 --filters 'Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*' --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' --output text)

echo "Using AMI: $AMI_ID"

INSTANCE_ID=$(aws ec2 run-instances --region "$AWS_REGION" --image-id "$AMI_ID" --count 1 --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" --security-group-ids "$SG_ID" --user-data "$USER_DATA" --query 'Instances[0].InstanceId' --output text)

echo "Launched instance: $INSTANCE_ID. Waiting for instance to be up..."
aws ec2 wait instance-status-ok --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo "Instance public IP: $PUBLIC_IP"

echo
echo "Next steps:"
echo "  1) SSH into the VM: ssh -i <your-private-key> ubuntu@$PUBLIC_IP"
echo "  2) On the VM, clone your repo and run the ingestion script (see deploy_chroma_on_vm.sh)"
echo "  3) Set CHROMA_URL on your local machine to http://$PUBLIC_IP:8000 and run node 02_scripts/test_ingest_chroma.js"

echo
echo "To clean up (terminate instance and delete security group & key):"
echo "  aws ec2 terminate-instances --region $AWS_REGION --instance-ids $INSTANCE_ID"
echo "  aws ec2 delete-security-group --region $AWS_REGION --group-name $SG_NAME"
echo "  aws ec2 delete-key-pair --region $AWS_REGION --key-name $KEY_NAME"

Chroma Cloud (VM) Deployment Guide

This document contains copy-paste commands to provision a cloud VM (AWS EC2) that runs Docker + Chroma and how to deploy the RAG pipeline.

1) Prerequisites (your machine)
- AWS CLI configured and authenticated
- SSH public key file to import into the EC2 instance
- Your git repo accessible from the VM (public or with SSH key)

2) Provision and run the VM (see scripts/provision_chroma_aws.sh)
- Make the script executable and run it:
  ```bash
  chmod +x scripts/provision_chroma_aws.sh
  ./scripts/provision_chroma_aws.sh ~/.ssh/id_rsa.pub git@github.com:youruser/yourrepo.git
  ```
- The script prints the public IP when ready.

3) SSH in and deploy the app
- SSH into the VM (example):
  ```bash
  ssh -i ~/.ssh/chroma-key.pem ubuntu@<PUBLIC_IP>
  ```
- On the VM run the deployment script (already added to /opt by the provisioner only if modified):
  ```bash
  sudo bash scripts/deploy_chroma_on_vm.sh git@github.com:youruser/yourrepo.git
  ```

4) Run the ingestion on the VM
- The deploy script sets `CHROMA_URL=http://localhost:8000` and runs the ingestion test
- If you prefer to run locally and point to remote Chroma, set on your local machine:
  ```powershell
  $env:CHROMA_URL = 'http://<PUBLIC_IP>:8000'
  node 02_scripts/test_ingest_chroma.js
  ```

5) Troubleshooting
- Check Docker container logs:
  ```bash
  docker logs chroma-local
  ```
- Check Chroma health
  ```bash
  curl http://localhost:8000/health
  ```
- If you see connection refused from your local machine: ensure the VM security group allows port 8000 from your IP.

6) Security
- Only open port 8000 to your IP.
- Consider using a private network or VPN for production.

7) Cleanup
- To stop Chroma:
  ```bash
  docker rm -f chroma-local
  ```
- To remove data (on VM):
  ```bash
  rm -rf /opt/chroma_data
  ```
- To terminate the EC2 instance, use the AWS console or CLI.

If you want Azure/GCP variants or a Terraform script that automates the whole flow, say so and I'll produce them next.
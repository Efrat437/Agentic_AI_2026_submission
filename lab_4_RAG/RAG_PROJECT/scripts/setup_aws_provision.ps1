param(
    [string]$AccessKeyId = "",
    [string]$SecretAccessKey = "",
    [string]$Region = "us-east-1",
    [string]$InstanceType = "t3.medium",
    [string]$RepoUrl = "https://github.com/your-username/Agentic_AI_2026.git"
)

Write-Host "================================" -ForegroundColor Cyan
Write-Host "AWS Chroma VM Setup" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Check AWS CLI
Write-Host "Checking AWS CLI..." -ForegroundColor Yellow
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: AWS CLI not found. Install from:" -ForegroundColor Red
    Write-Host "https://awscli.amazonaws.com/AWSCLIV2.msi" -ForegroundColor Yellow
    exit 1
}
Write-Host "OK: AWS CLI found" -ForegroundColor Green
Write-Host ""

# Prompt for AWS Key if not provided
if ([string]::IsNullOrWhiteSpace($AccessKeyId)) {
    $AccessKeyId = Read-Host "Enter AWS Access Key ID"
}
if ([string]::IsNullOrWhiteSpace($SecretAccessKey)) {
    $SecretAccessKeyInput = Read-Host "Enter AWS Secret Access Key" -AsSecureString
    $SecretAccessKey = [System.Net.NetworkCredential]::new('', $SecretAccessKeyInput).Password
}

# Prompt for Region
Write-Host ""
Write-Host "Select AWS Region:" -ForegroundColor Cyan
Write-Host "1. us-east-1 (default)"
Write-Host "2. us-west-2"
Write-Host "3. eu-west-1"
Write-Host "4. ap-southeast-1"
$choice = Read-Host "Enter choice (1-4, or press Enter for default)"
$Region = switch ($choice) {
    "2" { "us-west-2" }
    "3" { "eu-west-1" }
    "4" { "ap-southeast-1" }
    default { "us-east-1" }
}
Write-Host "Region: $Region" -ForegroundColor Green
Write-Host ""

# Configure AWS
Write-Host "Configuring AWS CLI..." -ForegroundColor Yellow
aws configure set aws_access_key_id $AccessKeyId
aws configure set aws_secret_access_key $SecretAccessKey
aws configure set region $Region
aws configure set output json

# Verify credentials
Write-Host "Verifying AWS credentials..." -ForegroundColor Yellow
try {
    $identity = aws sts get-caller-identity 2>$null | ConvertFrom-Json
    Write-Host "OK: Credentials valid - $($identity.Arn)" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Invalid credentials" -ForegroundColor Red
    exit 1
}
Write-Host ""

# SSH Key Setup
Write-Host "Setting up SSH keys..." -ForegroundColor Yellow
$sshDir = "$env:USERPROFILE\.ssh"
$pubKeyPath = "$sshDir\id_rsa.pub"

if (-not (Test-Path "$sshDir\id_rsa")) {
    Write-Host "Generating SSH key pair..."
    mkdir -Path $sshDir -Force -ErrorAction SilentlyContinue | Out-Null
    ssh-keygen -t rsa -b 4096 -f "$sshDir\id_rsa" -N "" 2>$null
    Write-Host "OK: SSH key generated at $sshDir" -ForegroundColor Green
} else {
    Write-Host "OK: Using existing SSH key at $sshDir" -ForegroundColor Green
}
Write-Host ""

# Summary
Write-Host "========== SETUP SUMMARY ==========" -ForegroundColor Cyan
Write-Host "Region: $Region"
Write-Host "Instance Type: $InstanceType"
Write-Host "SSH Key: $pubKeyPath"
Write-Host "Repository: $RepoUrl"
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

$confirm = Read-Host "Proceed with provisioning? (y/n)"
if ($confirm -ne "y") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    exit 0
}

# Run Provisioning
Write-Host ""
Write-Host "Starting AWS provisioning..." -ForegroundColor Yellow
Write-Host "This may take 5-10 minutes..." -ForegroundColor Yellow
Write-Host ""

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$provisionScript = Join-Path $scriptPath "provision_chroma_aws.sh"

$env:AWS_REGION = $Region

try {
    bash $provisionScript $pubKeyPath $RepoUrl $InstanceType
    Write-Host ""
    Write-Host "SUCCESS: Provisioning complete!" -ForegroundColor Green
    Write-Host "Update your .env with: CHROMA_URL=http://<VM_PUBLIC_IP>:8000" -ForegroundColor Yellow
} catch {
    Write-Host ""
    Write-Host "ERROR: Provisioning failed. Do you have Git Bash or WSL2?" -ForegroundColor Red
    Write-Host "Run manually in Git Bash or WSL2:" -ForegroundColor Yellow
    Write-Host "bash ./scripts/provision_chroma_aws.sh `"$pubKeyPath`" `"$RepoUrl`" $InstanceType" -ForegroundColor Gray
    exit 1
}

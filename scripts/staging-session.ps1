#!/usr/bin/env pwsh
# EduMatch AWS staging session helper.
#
# Wraps the operator loop for the manual staging path: start, connect, deploy,
# inspect logs, roll back and stop. It never prints secrets and always targets
# the bound account/region from .env.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'start', 'connect', 'bootstrap-volume', 'deploy', 'logs', 'health', 'rollback', 'backup', 'stop')]
  [string]$Action,

  [string]$ReleaseId,
  [string]$RollbackRelease,
  [int]$LocalPort = 443,
  [int]$TailMinutes = 30
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
$config = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $config[$Matches[1]] = $Matches[2]
  }
}

$region = $config['AWS_REGION']
$account = $config['AWS_ACCOUNT_ID']
$hostnameValue = $config['AWS_TLS_DOMAIN']
if (-not $region -or -not $account) { throw 'AWS_REGION/AWS_ACCOUNT_ID missing in .env' }

$env:AWS_REGION = $region
$env:AWS_DEFAULT_REGION = $region

function Get-InstanceId {
  $id = terraform -chdir="$root/infra" output -raw instance_id 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $id) {
    throw 'Terraform has no staging instance yet; apply the infra plan first.'
  }
  return $id.Trim()
}

function Assert-TargetAccount {
  # Guard: refuse to act when the active credential is not the bound account.
  $actual = (aws sts get-caller-identity --query Account --output text).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'No usable AWS credential in this session.' }
  if ($actual -ne $account) {
    throw "Refusing to act: active account $actual does not match bound account $account"
  }
  return $actual
}

function Wait-SsmOnline([string]$InstanceId) {
  for ($i = 0; $i -lt 60; $i++) {
    $ping = aws ssm describe-instance-information `
      --filters "Key=InstanceIds,Values=$InstanceId" `
      --query 'InstanceInformationList[0].PingStatus' --output text 2>$null
    if ($ping -eq 'Online') { return $true }
    Start-Sleep -Seconds 10
  }
  return $false
}

function Invoke-Ssm([string]$InstanceId, [string[]]$Commands, [string]$Label) {
  $params = @{ commands = $Commands } | ConvertTo-Json -Compress
  $commandId = (aws ssm send-command --instance-ids $InstanceId `
      --document-name 'AWS-RunShellScript' `
      --parameters $params `
      --query 'Command.CommandId' --output text).Trim()
  Write-Host "[$Label] command $commandId dispatched"

  for ($i = 0; $i -lt 180; $i++) {
    $status = aws ssm get-command-invocation --command-id $commandId --instance-id $InstanceId `
      --query 'Status' --output text 2>$null
    if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
    Start-Sleep -Seconds 5
  }
  $out = aws ssm get-command-invocation --command-id $commandId --instance-id $InstanceId `
    --query 'StandardOutputContent' --output text
  $err = aws ssm get-command-invocation --command-id $commandId --instance-id $InstanceId `
    --query 'StandardErrorContent' --output text
  if ($out) { Write-Host $out }
  if ($err) { Write-Warning $err }
  if ($status -ne 'Success') { throw "[$Label] SSM command ended with status $status" }
  return $out
}

switch ($Action) {
  'status' {
    $null = Assert-TargetAccount
    $instanceId = Get-InstanceId
    aws ec2 describe-instances --instance-ids $instanceId `
      --query 'Reservations[0].Instances[0].{State:State.Name,Type:InstanceType,IP:PublicIpAddress,AZ:Placement.AvailabilityZone,Launched:LaunchTime}' `
      --output table
    $ping = aws ssm describe-instance-information `
      --filters "Key=InstanceIds,Values=$instanceId" `
      --query 'InstanceInformationList[0].{Ping:PingStatus,Platform:PlatformName,Version:AgentVersion}' `
      --output table
    $ping
  }

  'start' {
    $null = Assert-TargetAccount
    $instanceId = Get-InstanceId
    aws ec2 start-instances --instance-ids $instanceId | Out-Null
    aws ec2 wait instance-running --instance-ids $instanceId
    Write-Host "Instance $instanceId running; waiting for SSM registration"
    if (-not (Wait-SsmOnline $instanceId)) { throw 'SSM agent did not come online' }
    Write-Host 'SSM online.'

    # The session deadline is a fixed UTC instant, not a duration from boot, so a
    # stop/start inside the same session cannot silently extend it. Record it only
    # when it is missing or already in the past (i.e. a genuinely new session).
    $deadlineScript = @(
      'set -e',
      'root=/opt/edumatch',
      'limit=$(cat "$root/max-session-hours" 2>/dev/null || echo 4)',
      'now=$(date -u +%s)',
      'existing=$(cat "$root/session-deadline-epoch" 2>/dev/null || echo 0)',
      'if [ "$existing" -gt "$now" ]; then',
      '  echo "SESSION_DEADLINE_REUSED $(date -u -d "@$existing" +%Y-%m-%dT%H:%M:%SZ)"',
      'else',
      '  d=$(( now + limit * 3600 ))',
      '  install -d -m 0700 "$root"',
      '  printf "%s\n" "$d" > "$root/session-deadline-epoch"',
      '  date -u -d "@$d" +%Y-%m-%dT%H:%M:%SZ > "$root/session-deadline"',
      '  echo "SESSION_DEADLINE_SET $(cat "$root/session-deadline")"',
      'fi'
    )
    $out = Invoke-Ssm $instanceId $deadlineScript 'session-deadline'
    Write-Host $out
  }

  'connect' {
    $instanceId = Get-InstanceId
    Write-Host "Forwarding localhost:$LocalPort -> instance:443"
    Write-Host "Add this hosts entry before browsing https://$hostnameValue/ :"
    Write-Host "  127.0.0.1 $hostnameValue"
    aws ssm start-session --target $instanceId `
      --document-name AWS-StartPortForwardingSession `
      --parameters "{`"portNumber`":[`"443`"],`"localPortNumber`":[`"$LocalPort`"]}"
  }

  'bootstrap-volume' {
    $null = Assert-TargetAccount
    $instanceId = Get-InstanceId
    if (-not (Wait-SsmOnline $instanceId)) { throw 'SSM agent not online' }
    $volume = (terraform -chdir="$root/infra" output -raw data_volume_id).Trim()
    Invoke-Ssm $instanceId @("/opt/edumatch/bin/bootstrap-data-volume.sh $volume /srv/edumatch") 'bootstrap-volume'
  }

  'deploy' {
    $null = Assert-TargetAccount
    if (-not $ReleaseId) { throw 'Provide -ReleaseId <40-hex-sha>-<run-id>' }
    if ($ReleaseId -notmatch '^[a-f0-9]{40}-[0-9]+$') { throw 'ReleaseId must match ^[a-f0-9]{40}-[0-9]+$' }
    $instanceId = Get-InstanceId
    $params = @{ ReleaseId = @($ReleaseId); Operation = @('deploy') } | ConvertTo-Json -Compress
    $commandId = (aws ssm send-command --instance-ids $instanceId `
        --document-name 'EduMatch-Staging-Release' --parameters $params `
        --query 'Command.CommandId' --output text).Trim()
    Write-Host "Deploy command $commandId"

    for ($i = 0; $i -lt 150; $i++) {
      $status = aws ssm get-command-invocation --command-id $commandId --instance-id $instanceId `
        --query 'Status' --output text 2>$null
      if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
      Start-Sleep -Seconds 10
    }
    aws ssm get-command-invocation --command-id $commandId --instance-id $instanceId `
      --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' --output json
    if ($status -ne 'Success') { throw "Deploy ended with status $status" }
  }

  'logs' {
    $null = Assert-TargetAccount
    aws logs tail $config['AWS_LOG_GROUP'] --since "$($TailMinutes)m" --follow
  }

  'health' {
    $null = Assert-TargetAccount
    $instanceId = Get-InstanceId
    if (-not (Wait-SsmOnline $instanceId)) { throw 'SSM agent not online' }
    $script = @(
      "curl --resolve ${hostnameValue}:443:127.0.0.1 -fsS https://${hostnameValue}/gateway/health",
      "curl --resolve ${hostnameValue}:443:127.0.0.1 -fsS https://${hostnameValue}/api/auth/health",
      "curl --resolve ${hostnameValue}:443:127.0.0.1 -fsS https://${hostnameValue}/api/health",
      "curl --resolve ${hostnameValue}:443:127.0.0.1 -fsS https://${hostnameValue}/health"
    )
    Invoke-Ssm $instanceId $script 'health'
  }

  'rollback' {
    $null = Assert-TargetAccount
    if (-not $RollbackRelease) { throw 'Provide -RollbackRelease <retained-release-id>' }
    if ($RollbackRelease -notmatch '^[a-f0-9]{40}-[0-9]+$') { throw 'RollbackRelease must match ^[a-f0-9]{40}-[0-9]+$' }
    $instanceId = Get-InstanceId
    $params = @{ ReleaseId = @($RollbackRelease); Operation = @('rollback') } | ConvertTo-Json -Compress
    $commandId = (aws ssm send-command --instance-ids $instanceId `
        --document-name 'EduMatch-Staging-Release' --parameters $params `
        --query 'Command.CommandId' --output text).Trim()
    Write-Host "Rollback command $commandId"
    aws ssm get-command-invocation --command-id $commandId --instance-id $instanceId --query 'Status' --output text
  }

  'backup' {
    $null = Assert-TargetAccount
    $instanceId = Get-InstanceId
    Invoke-Ssm $instanceId @('/opt/edumatch/bin/backup.sh /srv/edumatch/backups/$(date -u +%Y%m%dT%H%M%SZ)') 'backup'
  }

  'stop' {
    $null = Assert-TargetAccount
    $instanceId = Get-InstanceId
    aws ec2 stop-instances --instance-ids $instanceId | Out-Null
    aws ec2 wait instance-stopped --instance-ids $instanceId
    Write-Host "Instance $instanceId stopped. EBS, snapshots, ECR and S3 keep billing."
  }
}

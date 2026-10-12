#!/usr/bin/env pwsh
# Preflight: validate the generated Compose against the real runtime env file
# before any deploy, without printing secrets.
#
# Runs `docker compose config --quiet`, which resolves every ${VAR:?...}
# reference and fails on a missing or malformed value. The rendered config is
# never printed: it contains credentials. Only a pass/fail summary and the
# resolved service list are emitted.
#
# On a host without Docker (e.g. the operator's Windows machine) the check falls
# back to a static resolution of the generated Compose so the same class of
# error is still caught before the instance is touched.
[CmdletBinding()]
param(
  [string]$ComposePath = [IO.Path]::Combine($PSScriptRoot, '..', 'artifacts', 'release', 'compose.yml'),
  [string]$EnvPath     = [IO.Path]::Combine($PSScriptRoot, '..', 'artifacts', 'runtime', 'staging.env'),
  [switch]$RequireDocker
)

$ErrorActionPreference = 'Stop'

foreach ($p in @($ComposePath, $EnvPath)) {
  if (-not (Test-Path $p)) { throw "Missing required file: $p" }
}

# Parse the env file into a name->value map. Never echo the values.
$envValues = @{}
foreach ($line in Get-Content $EnvPath) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $value = $Matches[2]
    # Compose wraps multi-line values in double quotes; strip the wrapper only.
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $envValues[$Matches[1]] = $value
  }
}

$composeText = Get-Content $ComposePath -Raw
# Compose escapes a literal shell expansion as $${VAR}; those are expanded by the
# container's shell at runtime, not by Compose, so they are not env-file
# references. Match ${VAR} and ${VAR:?...} while ignoring $${VAR}.
$refs = [regex]::Matches($composeText, '(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(:?)([^}]*)\}')
$required = @()
$resolved = @{}
$unresolved = @()
foreach ($m in $refs) {
  $name = $m.Groups[1].Value
  $isRequired = $m.Groups[2].Value -eq ':?'
  $value = if ($envValues.ContainsKey($name)) { $envValues[$name] } else { $null }
  if ($value) {
    $resolved[$name] = $true
  } elseif ($isRequired) {
    if ($required -notcontains $name) { $required += $name }
    if ($unresolved -notcontains $name) { $unresolved += $name }
  }
}

Write-Host "compose: $ComposePath"
Write-Host "env:     $EnvPath"
Write-Host "distinct variables referenced: $(($refs | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique).Count)"
Write-Host "resolved from env:             $($resolved.Count)"
Write-Host "required but unresolved:       $($unresolved.Count)"

# A referenced variable that is neither set nor defaulted resolves to empty at
# runtime; surface those as warnings rather than failures, except the :? form.
$softMissing = @()
foreach ($m in $refs) {
  $name = $m.Groups[1].Value
  if ($m.Groups[2].Value -ne ':?' -and -not $envValues.ContainsKey($name) -and $m.Groups[3].Value -eq '') {
    if ($softMissing -notcontains $name) { $softMissing += $name }
  }
}
if ($softMissing.Count -gt 0) {
  Write-Warning "referenced without a default and not present in the env file: $($softMissing -join ', ')"
}

if ($unresolved.Count -gt 0) {
  throw "Compose requires variables the runtime env does not define: $($unresolved -join ', ')"
}

# Service list is safe to print (no values).
$services = [regex]::Matches($composeText, '(?m)^  ([a-z0-9][a-z0-9_-]*):\s*$') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
Write-Host "services defined: $($services.Count) -> $($services -join ', ')"

# Local-only hostnames must never reach a deployment.
$badHosts = [regex]::Matches($composeText, '\b([a-z][a-z0-9-]*-test)\b') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
if ($badHosts.Count -gt 0) {
  throw "Compose still references local-only hostnames: $($badHosts -join ', ')"
}

# If Docker is available, run the authoritative check as well. A Docker CLI
# without the Compose v2 plugin is treated as "not available" rather than a
# failure: the static resolution above already covers the missing-variable class
# of error, and the host-side run is authoritative at deploy time.
$docker = Get-Command docker -ErrorAction SilentlyContinue
$composeUsable = $false
if ($docker) {
  # Probe with stderr suppressed and the error preference relaxed: a CLI without
  # the Compose v2 plugin writes "unknown command" to stderr and would otherwise
  # abort this script before the static result is reported.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $probe = & docker compose version 2>&1 | Out-String
    $composeUsable = ($LASTEXITCODE -eq 0) -and ($probe -notmatch 'unknown command|not a docker command')
  } catch {
    $composeUsable = $false
  } finally {
    $ErrorActionPreference = $previous
  }
}
if ($composeUsable) {
  $output = & docker compose --project-name edumatch-staging --env-file $EnvPath -f $ComposePath config --quiet 2>&1
  if ($LASTEXITCODE -ne 0) {
    # Do not echo $output verbatim: a compose error can quote a value.
    $safe = ($output | Out-String) -replace '(?m)^.*(password|secret|token).*$', '[REDACTED LINE]'
    throw "docker compose config rejected the release:`n$safe"
  }
  Write-Host 'docker compose config: OK'
} elseif ($RequireDocker) {
  throw 'Docker Compose v2 is required for this preflight but is not usable on PATH.'
} else {
  Write-Warning 'docker compose v2 not usable here; static resolution only (the host run is authoritative).'
}

Write-Host 'PREFLIGHT_OK'

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$stateDir = Join-Path $root '.state'
$launchPath = Join-Path $stateDir 'ui-launch.json'
$stdoutPath = Join-Path $stateDir 'launcher.stdout.log'
$stderrPath = Join-Path $stateDir 'launcher.stderr.log'

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

# Stop only the process recorded by this workspace, and only after verifying
# that its command line is the Harness UI launcher. taskkill /T also closes
# the bound web and broker children so a fresh budget ledger is created.
if (Test-Path -LiteralPath $launchPath) {
    try {
        $old = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
        $oldPid = [int]$old.pid
        $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
        if ($null -ne $oldProcess -and [regex]::IsMatch([string]$oldProcess.CommandLine, '(?i)scripts[\\/]+ui\.mjs')) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $oldPid /T /F | Out-Null
            Start-Sleep -Milliseconds 750
        }
    } catch {
        # A stale or incomplete state file must not prevent a clean launch.
    }
    Remove-Item -LiteralPath $launchPath -Force -ErrorAction SilentlyContinue
}

[IO.File]::WriteAllText($stdoutPath, '')
[IO.File]::WriteAllText($stderrPath, '')
$npm = Get-Command npm.cmd -ErrorAction Stop
$startedAt = [DateTime]::UtcNow
$launcher = Start-Process -FilePath $npm.Source -ArgumentList @('run','ui') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(120)

while ([DateTime]::UtcNow -lt $deadline) {
    $launcher.Refresh()
    if ($launcher.HasExited) {
        $detail = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Tail 30) -join [Environment]::NewLine } else { '' }
        throw "Harness failed to start. $detail"
    }

    if (Test-Path -LiteralPath $launchPath) {
        $item = Get-Item -LiteralPath $launchPath
        if ($item.LastWriteTimeUtc -ge $startedAt.AddSeconds(-1)) {
            try {
                $launch = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
                $launchUrl = [uri]$launch.url
                if ($launch.apiReady -and $launchUrl.Scheme -eq 'http' -and $launchUrl.Host -in @('localhost','127.0.0.1','[::1]')) {
                    Start-Process -FilePath $launch.url
                    exit 0
                }
            } catch {
                # The launcher may be between its atomic write and rename.
            }
        }
    }
    Start-Sleep -Milliseconds 500
}

throw "Harness did not become ready within 120 seconds. See '$stdoutPath' and '$stderrPath'."

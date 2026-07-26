[CmdletBinding()]
param(
    [ValidateRange(0.1, 10080)]
    [double]$Minutes = 5
)

$ErrorActionPreference = "Stop"
$dataDir = Join-Path $env:LOCALAPPDATA "ActivityRecorder"
$configPath = Join-Path $dataDir "config.json"
$pausePath = Join-Path $dataDir "pause_until.txt"

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Activity Recorder is not installed for the current user."
}

$epoch = [DateTimeOffset]"1970-01-01T00:00:00Z"
$until = [DateTimeOffset]::UtcNow.AddMinutes($Minutes)
$untilSeconds = [long][Math]::Floor(($until - $epoch).TotalSeconds)
$temporaryPath = "$pausePath.tmp.$PID"
[System.IO.File]::WriteAllText($temporaryPath, [string]$untilSeconds, [System.Text.Encoding]::ASCII)
Move-Item -LiteralPath $temporaryPath -Destination $pausePath -Force

Write-Host ("Activity collection is paused for {0:g} minute(s), until {1}." -f $Minutes, $until.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss"))

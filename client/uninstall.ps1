[CmdletBinding()]
param(
    [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$taskName = "ActivityRecorder"
$dataDir = Join-Path $env:LOCALAPPDATA $taskName
$appDir = Join-Path $dataDir "app"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

if ((Split-Path -Leaf $appDir) -eq "app" -and (Split-Path -Parent $appDir) -eq $dataDir) {
    Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($RemoveData) {
    if ((Split-Path -Leaf $dataDir) -eq $taskName -and (Split-Path -Parent $dataDir) -eq $env:LOCALAPPDATA) {
        Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Activity Recorder and all local queued data were removed."
    }
} else {
    Write-Host "Activity Recorder was removed. Config, queue, and logs remain in $dataDir"
}

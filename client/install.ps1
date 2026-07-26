[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$Endpoint,

    [Parameter(Mandatory = $true)]
    [ValidateLength(16, 512)]
    [string]$Token,

    [string]$DeviceName = ""
)

$ErrorActionPreference = "Stop"
$taskName = "ActivityRecorder"
$dataDir = Join-Path $env:LOCALAPPDATA $taskName
$appDir = Join-Path $dataDir "app"
$configPath = Join-Path $dataDir "config.json"

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "activity_recorder") -Destination $appDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "run.py") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "requirements.txt") -Destination $appDir -Force

$venvDir = Join-Path $appDir ".venv"
$python = Join-Path $venvDir "Scripts\python.exe"
$pythonw = Join-Path $venvDir "Scripts\pythonw.exe"
if (-not (Test-Path -LiteralPath $python)) {
    py -3.11 -m venv $venvDir
}
& $python -m pip install --disable-pip-version-check -r (Join-Path $appDir "requirements.txt")

$deviceId = [guid]::NewGuid().ToString()
if (Test-Path -LiteralPath $configPath) {
    try {
        $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($existing.device_id) { $deviceId = [string]$existing.device_id }
    } catch {
        Write-Warning "Existing config could not be read; a new device ID will be used."
    }
}

$configuration = [ordered]@{
    endpoint = $Endpoint.TrimEnd('/')
    ingest_token = $Token
    device_id = $deviceId
    device_name = $DeviceName
    poll_seconds = 1
    heartbeat_seconds = 300
}
$configJson = $configuration | ConvertTo-Json
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $configJson, $utf8WithoutBom)

# Keep the token readable only through the current user's protected profile ACL.
$acl = Get-Acl -LiteralPath $configPath
$acl.SetAccessRuleProtection($true, $true)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "Allow")
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $configPath -AclObject $acl

$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"{0}"' -f (Join-Path $appDir "run.py")) -WorkingDirectory $appDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User $identity -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Activity Recorder is installed and running."
Write-Host "Data directory: $dataDir"
Write-Host "Device ID: $deviceId"

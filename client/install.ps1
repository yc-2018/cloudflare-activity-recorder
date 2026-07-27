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
    $minimumPythonVersion = [version]"3.11"
    $pythonCandidates = @(
        [pscustomobject]@{ Command = "py"; Arguments = @("-3"); Priority = 0 },
        [pscustomobject]@{ Command = "python"; Arguments = @(); Priority = 1 },
        [pscustomobject]@{ Command = "python3"; Arguments = @(); Priority = 2 }
    )
    $pythonRuntimes = foreach ($candidate in $pythonCandidates) {
        if (-not (Get-Command $candidate.Command -ErrorAction SilentlyContinue)) {
            continue
        }
        $command = $candidate.Command
        $arguments = @($candidate.Arguments)
        $probe = & $command @arguments -c 'import sys; print(sys.version_info.major); print(sys.version_info.minor); print(sys.version_info.micro)' 2>$null
        $probeLines = @($probe)
        if ($LASTEXITCODE -ne 0 -or $probeLines.Count -lt 3) {
            continue
        }
        try {
            $runtimeVersion = [version]("{0}.{1}.{2}" -f [int]$probeLines[-3], [int]$probeLines[-2], [int]$probeLines[-1])
        } catch {
            continue
        }
        if ($runtimeVersion -ge $minimumPythonVersion) {
            [pscustomobject]@{
                Command = $command
                Arguments = $arguments
                Priority = $candidate.Priority
                Version = $runtimeVersion
            }
        }
    }
    $runtime = $pythonRuntimes |
        Sort-Object -Property @{ Expression = "Version"; Descending = $true }, @{ Expression = "Priority"; Descending = $false } |
        Select-Object -First 1
    if (-not $runtime) {
        throw "Python 3.11 or newer was not found. Install a supported Python version and ensure 'py -3' or 'python' works."
    }
    $runtimeCommand = $runtime.Command
    $runtimeArguments = @($runtime.Arguments)
    Write-Host "Creating virtual environment with Python $($runtime.Version) ($runtimeCommand $($runtimeArguments -join ' '))"
    & $runtimeCommand @runtimeArguments -m venv $venvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)) {
        throw "Failed to create the Python virtual environment with Python $($runtime.Version)."
    }
}
& $python -m pip install --disable-pip-version-check -r (Join-Path $appDir "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install Python dependencies."
}

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

$taskName = "ActivityRecorder"
$dataDir = Join-Path $env:LOCALAPPDATA $taskName
$queuePath = Join-Path $dataDir "queue.sqlite3"
$python = Join-Path $dataDir "app\.venv\Scripts\python.exe"
$pausePath = Join-Path $dataDir "pause_until.txt"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Task: not installed"
    exit 1
}

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "Task state: $($task.State)"
Write-Host "Last run: $($info.LastRunTime)"
Write-Host "Last result: $($info.LastTaskResult)"

if (Test-Path -LiteralPath $pausePath) {
    try {
        $pauseUntilSeconds = [long](Get-Content -LiteralPath $pausePath -Raw)
        $epoch = [DateTimeOffset]"1970-01-01T00:00:00Z"
        $pauseUntil = $epoch.AddSeconds($pauseUntilSeconds)
        if ($pauseUntil -gt [DateTimeOffset]::UtcNow) {
            Write-Host "Collection: paused until $($pauseUntil.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
        } else {
            Write-Host "Collection: active"
        }
    } catch {
        Write-Host "Collection: active (invalid pause marker ignored)"
    }
} else {
    Write-Host "Collection: active"
}

if ((Test-Path -LiteralPath $queuePath) -and (Test-Path -LiteralPath $python)) {
    $count = & $python -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT COUNT(*) FROM pending_events').fetchone()[0])" $queuePath
    Write-Host "Queued events: $count"
}

$logPath = Join-Path $dataDir "recorder.log"
if (Test-Path -LiteralPath $logPath) {
    Write-Host "Recent log entries:"
    Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail 8
}

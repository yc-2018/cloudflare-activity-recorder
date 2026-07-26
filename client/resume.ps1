$pausePath = Join-Path $env:LOCALAPPDATA "ActivityRecorder\pause_until.txt"
Remove-Item -LiteralPath $pausePath -Force -ErrorAction SilentlyContinue
Write-Host "Activity collection will resume within one second."

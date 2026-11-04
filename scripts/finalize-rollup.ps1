# Collapse the event store to per-(device, day, application) rows and rebuild
# the month/year rollup. Run once after the D1 daily quota resets (00:00 UTC).
#
#   pwsh -File scripts/finalize-rollup.ps1
#
# Step 1 applies migration 0003, which builds activity_days from activity_events
# (a few thousand rows from hundreds of thousands) and drops the per-sample
# table. Step 2 rebuilds activity_rollup from activity_days via the admin
# endpoint (needs a dashboard login).
param(
  [string]$FromDate = "2026-07-01",
  [string]$ToDate
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $ToDate) {
  $ToDate = (Get-Date).ToUniversalTime().AddDays(1).ToString("yyyy-MM-dd")
}

Write-Host "1/2 Applying remote D1 migrations (collapses activity_events -> activity_days)..." -ForegroundColor Cyan
npx wrangler d1 migrations apply activity-recorder --remote
if ($LASTEXITCODE -ne 0) { throw "Migration failed. Has the D1 daily read/write limit reset yet (00:00 UTC)?" }

Write-Host "2/2 Rebuilding rollup from activity_days..." -ForegroundColor Cyan
$fromIso = "${FromDate}T00:00:00.000Z"
$toIso = "${ToDate}T00:00:00.000Z"

$base = $env:AR_BASE
if (-not $base) { $base = "https://bg.245556.xyz" }

# Password: env var, else the local .dev.vars file, else prompt.
$password = $env:AR_PASSWORD
if (-not $password) {
  $devVars = Join-Path (Get-Location) ".dev.vars"
  if (Test-Path -LiteralPath $devVars) {
    $line = Get-Content -LiteralPath $devVars | Where-Object { $_ -match '^\s*DASHBOARD_PASSWORD\s*=' } | Select-Object -First 1
    if ($line) { $password = ($line -split '=', 2)[1].Trim() }
  }
}
if (-not $password) { $password = Read-Host "Dashboard password" }

$loginBody = @{ password = $password } | ConvertTo-Json
Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -Body $loginBody `
  -ContentType "application/json" -SessionVariable webSession | Out-Null

$result = Invoke-RestMethod -Uri "$base/api/v1/admin/rebuild-rollup?from=$fromIso&to=$toIso" `
  -Method Post -WebSession $webSession
$result | ConvertTo-Json

Write-Host "Done. activity_days holds the collapsed data; rollup serves month/year views." -ForegroundColor Green

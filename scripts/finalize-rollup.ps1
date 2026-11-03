# Apply the rollup migration and backfill history once the D1 daily read
# limit has reset (00:00 UTC). Run from the repository root:
#
#   pwsh -File scripts/finalize-rollup.ps1
#
# Optional: override the history window with -FromDate / -ToDate.
param(
  [string]$FromDate = "2026-07-01",
  [string]$ToDate
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $ToDate) {
  $ToDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
}

Write-Host "1/2 Applying remote D1 migrations..." -ForegroundColor Cyan
npx wrangler d1 migrations apply activity-recorder --remote
if ($LASTEXITCODE -ne 0) { throw "Migration failed. Has the D1 daily read limit reset yet (00:00 UTC)?" }

Write-Host "2/2 Backfilling rollup for $FromDate .. $ToDate ..." -ForegroundColor Cyan
$fromIso = "${FromDate}T00:00:00.000Z"
$toIso = "${ToDate}T00:00:00.000Z"

# The backfill endpoint is behind the dashboard session cookie. Set these env
# vars (or pass them in) so the script can authenticate:
#   $env:AR_BASE          e.g. https://bg.245556.xyz
#   $env:AR_PASSWORD       dashboard password
$base = $env:AR_BASE
if (-not $base) { $base = Read-Host "Worker base URL (e.g. https://bg.245556.xyz)" }
$password = $env:AR_PASSWORD
if (-not $password) { $password = Read-Host "Dashboard password" }

Write-Host "Logging in..." -ForegroundColor Cyan
$loginBody = @{ password = $password } | ConvertTo-Json
$session = (Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -Body $loginBody `
  -ContentType "application/json" -SessionVariable webSession).session

Write-Host "Rebuilding rollup (this walks one UTC day at a time)..." -ForegroundColor Cyan
$result = Invoke-RestMethod -Uri "$base/api/v1/admin/rebuild-rollup?from=$fromIso&to=$toIso" `
  -Method Post -WebSession $webSession
$result | ConvertTo-Json

Write-Host "Done. The dashboard's month/year views now serve from the rollup." -ForegroundColor Green

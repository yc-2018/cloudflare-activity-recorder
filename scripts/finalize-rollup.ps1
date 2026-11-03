# Apply the rollup migration and backfill history once the D1 daily read
# limit has reset (00:00 UTC). Runs entirely through the command line with the
# existing wrangler login - no dashboard password is required.
#
#   pwsh -File scripts/finalize-rollup.ps1
#
# Optional history window (defaults cover the whole dataset):
#   pwsh -File scripts/finalize-rollup.ps1 -FromDate 2026-07-01 -ToDate 2026-11-04
param(
  [string]$FromDate = "2026-07-01",
  [string]$ToDate
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $ToDate) {
  $ToDate = (Get-Date).ToUniversalTime().AddDays(1).ToString("yyyy-MM-dd")
}

Write-Host "1/2 Applying remote D1 migrations..." -ForegroundColor Cyan
npx wrangler d1 migrations apply activity-recorder --remote
if ($LASTEXITCODE -ne 0) { throw "Migration failed. Has the D1 daily read limit reset yet (00:00 UTC)?" }

# Backfill one calendar month at a time so each d1 execute stays bounded.
$cursor = [datetime]::ParseExact($FromDate, "yyyy-MM-dd", $null)
$end = [datetime]::ParseExact($ToDate, "yyyy-MM-dd", $null)
$sqlFile = Join-Path ([System.IO.Path]::GetTempPath()) "backfill-rollup.sql"

Write-Host "2/2 Backfilling rollup month by month..." -ForegroundColor Cyan
while ($cursor -lt $end) {
  $chunkEnd = $cursor.AddMonths(1)
  if ($chunkEnd -gt $end) { $chunkEnd = $end }
  $fromIso = $cursor.ToString("yyyy-MM-dd") + "T00:00:00.000Z"
  $toIso = $chunkEnd.ToString("yyyy-MM-dd") + "T00:00:00.000Z"
  Write-Host "  - $fromIso .. $toIso" -ForegroundColor Gray

  node scripts/generate-backfill.mjs $fromIso $toIso | Out-File -Encoding utf8 $sqlFile
  if ($LASTEXITCODE -ne 0) { throw "Failed to generate backfill SQL for $fromIso." }

  npx wrangler d1 execute activity-recorder --remote --file $sqlFile
  if ($LASTEXITCODE -ne 0) { throw "Backfill failed for $fromIso .. $toIso." }

  $cursor = $chunkEnd
}

Remove-Item $sqlFile -ErrorAction SilentlyContinue
Write-Host "Done. The dashboard month/year views now serve from the rollup." -ForegroundColor Green

# Apply the rollup migration and backfill history once the D1 daily read
# limit has reset (00:00 UTC). Runs entirely through the command line with the
# existing wrangler login - no dashboard password is required.
#
# Safe to re-run: each month is cleared and re-inserted idempotently, so if a
# run is interrupted just run it again.
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

Write-Host "1/3 Applying remote D1 migrations..." -ForegroundColor Cyan
npx wrangler d1 migrations apply activity-recorder --remote
if ($LASTEXITCODE -ne 0) {
  throw "Migration failed. Has the D1 daily read limit reset yet (00:00 UTC)? It runs at 2026-11-04 00:00 UTC."
}

# Count raw events and current rollup rows so progress is measurable.
Write-Host "Inspecting current data volume..." -ForegroundColor Cyan
$events = (npx wrangler d1 execute activity-recorder --remote --json `
  --command "SELECT COUNT(*) AS n FROM activity_events" 2>$null | ConvertFrom-Json)[0].results[0].n
$before = (npx wrangler d1 execute activity-recorder --remote --json `
  --command "SELECT COUNT(*) AS n FROM activity_rollup" 2>$null | ConvertFrom-Json)[0].results[0].n
Write-Host "  raw events: $events   rollup rows before: $before" -ForegroundColor Gray

# Backfill one calendar month at a time so each d1 execute stays bounded.
$cursor = [datetime]::ParseExact($FromDate, "yyyy-MM-dd", $null)
$end = [datetime]::ParseExact($ToDate, "yyyy-MM-dd", $null)
$sqlFile = Join-Path ([System.IO.Path]::GetTempPath()) "backfill-rollup.sql"
$monthIndex = 0
$totalMonths = 0
for ($c = $cursor; $c -lt $end; $c = $c.AddMonths(1)) { $totalMonths++ }

Write-Host "2/3 Backfilling rollup month by month ($totalMonths months)..." -ForegroundColor Cyan
while ($cursor -lt $end) {
  $monthIndex++
  $chunkEnd = $cursor.AddMonths(1)
  if ($chunkEnd -gt $end) { $chunkEnd = $end }
  $fromIso = $cursor.ToString("yyyy-MM-dd") + "T00:00:00.000Z"
  $toIso = $chunkEnd.ToString("yyyy-MM-dd") + "T00:00:00.000Z"
  Write-Host "  [$monthIndex/$totalMonths] $fromIso .. $toIso" -ForegroundColor Gray

  node scripts/generate-backfill.mjs $fromIso $toIso | Out-File -Encoding utf8 $sqlFile
  if ($LASTEXITCODE -ne 0) { throw "Failed to generate backfill SQL for $fromIso." }

  npx wrangler d1 execute activity-recorder --remote --file $sqlFile
  if ($LASTEXITCODE -ne 0) { throw "Backfill failed for $fromIso .. $toIso. Re-run the script to resume." }

  $cursor = $chunkEnd
}

Remove-Item $sqlFile -ErrorAction SilentlyContinue

Write-Host "3/3 Verifying rollup coverage..." -ForegroundColor Cyan
$after = (npx wrangler d1 execute activity-recorder --remote --json `
  --command "SELECT COUNT(*) AS n FROM activity_rollup" 2>$null | ConvertFrom-Json)[0].results[0].n
Write-Host "  rollup rows after: $after" -ForegroundColor Gray
if ([int64]$after -le [int64]$before) {
  throw "Rollup row count did not increase ($before -> $after). Backfill may not have run."
}
Write-Host "Done. The dashboard month/year views now serve from the rollup." -ForegroundColor Green

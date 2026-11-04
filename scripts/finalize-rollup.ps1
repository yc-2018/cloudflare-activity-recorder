# Deploy the collapsed data model: apply migration 0003/0004 (build activity_days
# from activity_events, drop the old per-sample table and the unused rollup),
# then deploy the Worker. Month/year views are computed directly from
# activity_days, so no rollup rebuild is required.
#
#   pwsh -File scripts/finalize-rollup.ps1
param()

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "1/2 Applying remote D1 migrations (activity_events -> activity_days)..."; 
npx wrangler d1 migrations apply activity-recorder --remote
if ($LASTEXITCODE -ne 0) { throw "Migration failed. Has the D1 daily read/write limit reset yet (00:00 UTC)?" }

Write-Host "2/2 Deploying Worker (reads activity_days)..."
npm run deploy
if ($LASTEXITCODE -ne 0) { throw "Deploy failed." }

Write-Host "Done. activity_days holds the collapsed data; overviews are computed from it." -ForegroundColor Green

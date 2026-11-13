# Run the local verification pipeline; stop at the first failing step.
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

pnpm typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm --filter dsh-session-file-actions build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm --filter opencode-session-file-actions build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Install workspace dependencies from the project-local pnpm store.
# pnpm 11 ignores store-dir from .npmrc, so the store is passed explicitly.
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

. (Join-Path $PSScriptRoot 'opencode-environment.ps1')

$storeRoot = $projectRoot
if (Test-Path -LiteralPath (Join-Path $projectRoot '.git') -PathType Leaf) {
    # Git lists the main checkout first. A separate clone keeps its own store.
    $consoleEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $worktrees = @(git worktree list --porcelain)
    } finally {
        [Console]::OutputEncoding = $consoleEncoding
    }
    if ($LASTEXITCODE -ne 0 -or $worktrees.Count -lt 2 -or
        $worktrees[0] -notlike 'worktree *' -or $worktrees[1] -eq 'bare') {
        throw 'Cannot determine the main checkout for the pnpm store.'
    }
    $storeRoot = $worktrees[0].Substring('worktree '.Length)
    if (-not [IO.Path]::IsPathRooted($storeRoot) -or -not (Test-Path -LiteralPath $storeRoot -PathType Container)) {
        throw "Main checkout for the pnpm store is unavailable: $storeRoot"
    }
}
$storeDir = Join-Path $storeRoot '.local/stores/pnpm'
Assert-RealPath $storeDir 'pnpm store' $storeRoot

Assert-RealPath $hostRepo 'OpenCode checkout'
if (Test-Path -LiteralPath $hostRepo) {
    if (-not (Test-Path -LiteralPath (Join-Path $hostRepo '.git'))) {
        throw "Expected an OpenCode checkout: $hostRepo"
    }
    $manifest = & git -C $hostRepo show "${fixedBaseline}:package.json" | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot read package.json from OpenCode baseline $fixedBaseline in $hostRepo"
    }
    $packageManager = ($manifest | ConvertFrom-Json).packageManager
    if ($packageManager -notmatch "^bun@(?<version>$bunVersionPattern)$") {
        throw "OpenCode baseline $fixedBaseline does not declare a supported Bun version: $packageManager"
    }
    $bunVersion = $Matches.version
    $bunPath = Join-Path $bunRoot "$bunVersion/bun.exe"
    Assert-RealPath $bunPath 'Project-local Bun'
    Assert-RealPath $bunSelection 'OpenCode Bun selection'

    $runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMddHHmmss'), $PID
    $bunTmp = Join-Path $bunRoot ".setup-$runId"
    New-RunDirectory $bunTmp 'Bun setup temp'
    $setupFailed = $false
    try {
        $candidate = $bunPath
        if (-not (Test-Path -LiteralPath $bunPath -PathType Leaf)) {
            Write-Output "bun: installing $bunVersion to $bunPath"
            $archive = Join-Path $bunTmp 'bun.zip'
            $url = "https://github.com/oven-sh/bun/releases/download/bun-v$bunVersion/bun-windows-x64.zip"
            Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
            Expand-Archive -LiteralPath $archive -DestinationPath $bunTmp
            $candidate = Join-Path $bunTmp 'bun-windows-x64/bun.exe'
            Assert-RealPath $candidate 'Downloaded Bun'
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                throw "Downloaded Bun archive does not contain $candidate"
            }
        }

        $reportedVersion = & $candidate --version
        if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne $bunVersion) {
            throw "Expected Bun $bunVersion at $candidate (reported $reportedVersion, exit $LASTEXITCODE)"
        }
        $target = & $candidate -e "console.log(process.platform + '/' + process.arch)"
        if ($LASTEXITCODE -ne 0 -or $target -ne 'win32/x64') {
            throw "Expected Windows x64 Bun at $candidate (reported $target, exit $LASTEXITCODE)"
        }
        if ($candidate -ne $bunPath) {
            Assert-RealPath $bunPath 'Project-local Bun'
            New-Item -ItemType Directory -Path (Split-Path -Parent $bunPath) -Force | Out-Null
            [System.IO.File]::Move($candidate, $bunPath)
        }

        $preparedSelection = Join-Path $bunTmp 'opencode-selection'
        Set-Content -LiteralPath $preparedSelection -Value "$fixedBaseline $bunVersion" -Encoding ASCII
        Assert-RealPath $bunSelection 'OpenCode Bun selection'
        & node -e "require('node:fs').renameSync(process.argv[1], process.argv[2])" -- $preparedSelection $bunSelection
        if ($LASTEXITCODE -ne 0) {
            throw "Cannot record OpenCode Bun selection: $bunSelection (node exit $LASTEXITCODE)"
        }
        Write-Output "bun: verified $bunVersion for OpenCode baseline $fixedBaseline at $bunPath"
    } catch {
        $setupFailed = $true
        throw
    } finally {
        Remove-RunDirectory $bunTmp 'Bun setup temp' $setupFailed
    }
}

Write-Output "pnpm store: $storeDir"
pnpm install --frozen-lockfile --prefer-offline --store-dir $storeDir
exit $LASTEXITCODE

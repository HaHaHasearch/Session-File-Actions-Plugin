# Fixed OpenCode baseline from host-patches/opencode/README.md.
$fixedBaseline = '3ba597f7769e19cc3b5f67e3d6667e7b6318f6a3'
$hostRepo = Join-Path $projectRoot 'upstream/opencode'
$bunRoot = Join-Path $projectRoot '.local/tools/bun'
$bunSelection = Join-Path $bunRoot 'opencode-selection'
$bunVersionPattern = '[0-9]+\.[0-9]+\.[0-9]+'

# Refuses a path when it or any existing ancestor up to the project root is a
# junction/symlink, or when an existing level cannot be inspected. The project
# root itself is the boundary, matching clean.ps1. Missing levels are allowed
# so the caller can test a directory it is about to create.
function Assert-RealPath {
    param([string]$Path, [string]$Purpose, [string]$RootPath = $projectRoot)
    if ([string]::IsNullOrEmpty($Path)) { throw "$Purpose path is empty" }
    $current = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetFullPath($RootPath).TrimEnd('\')
    $currentTrimmed = $current.TrimEnd('\')
    if (-not ($currentTrimmed -eq $root) -and
        -not ($currentTrimmed + '\').StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Purpose path is outside the project root: $current"
    }
    while ($true) {
        if ($currentTrimmed -eq $root) { return }
        $item = $null
        try {
            $item = Get-Item -LiteralPath $currentTrimmed -Force -ErrorAction Stop
        } catch [System.Management.Automation.ItemNotFoundException] {
            $item = $null
        } catch {
            throw "$Purpose path cannot be inspected: $currentTrimmed ($($_.Exception.Message))"
        }
        if ($null -ne $item -and
            (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "$Purpose path is a junction/symlink: $currentTrimmed"
        }
        $parent = Split-Path -Parent $currentTrimmed
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $currentTrimmed) {
            throw "$Purpose path is outside the project root: $current"
        }
        $currentTrimmed = $parent.TrimEnd('\')
    }
}

function New-RunDirectory {
    param([string]$Path, [string]$Purpose)
    Assert-RealPath $Path $Purpose
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    # Non-recursive mkdir fails atomically if another process owns the leaf.
    & node -e "require('node:fs').mkdirSync(process.argv[1])" -- $Path
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot create ${Purpose}: $Path (node exit $LASTEXITCODE)"
    }
}

function Remove-RunDirectory {
    param([string]$Path, [string]$Purpose, [bool]$OperationFailed)
    try {
        Assert-RealPath $Path $Purpose
        Remove-Item -LiteralPath $Path -Recurse -Force
    } catch {
        if (-not $OperationFailed) { throw }
        Write-Warning "Cannot clean up ${Purpose}: $($_.Exception.Message)" -WarningAction Continue
    }
}

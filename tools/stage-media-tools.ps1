param([Parameter(Mandatory=$true)][string]$SourceDirectory, [string]$HostDirectory = 'dist/host')
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$hostRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $HostDirectory))
if (-not $hostRoot.StartsWith($repositoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Development helper must stay inside the repository.' }
$sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path
foreach ($relativeFile in @('bin/ffmpeg.exe','bin/ffprobe.exe','LICENSE','README.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativeFile) -PathType Leaf)) { throw "Missing installed distribution file: $relativeFile" }
}
$mediaRoot = Join-Path $hostRoot 'media'
New-Item -ItemType Directory -Path $mediaRoot -Force | Out-Null
$metadata = @()
foreach ($name in @('ffmpeg','ffprobe')) {
    $sourceFile = Join-Path $sourceRoot "bin/$name.exe"
    $targetFile = Join-Path $mediaRoot "$name.exe"
    Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
    $versionText = & $targetFile -version
    if ($LASTEXITCODE -ne 0) { throw "$name executable check failed" }
    $metadata += @{ file="$name.exe"; sha256=(Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant(); version=$versionText[0] }
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'LICENSE') -Destination (Join-Path $mediaRoot 'LICENSE-FFmpeg.txt') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'README.txt') -Destination (Join-Path $mediaRoot 'README-FFmpeg.txt') -Force
$notice = @{
    purpose='Local development only; staged from an explicitly selected installed FFmpeg distribution, not a completed redistribution package.'
    provenance='Installed distribution README and original license are retained alongside the executables. No runtime PATH fallback.'
    tools=$metadata
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $mediaRoot 'development-tools.json'), $notice + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Staged both media tools, original license, README and hashes for local development. Release packaging is separate.'

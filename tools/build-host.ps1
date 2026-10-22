param([string]$OutputDirectory = 'dist/host')
$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sdkPath = Join-Path $repositoryRoot '.tools/dotnet/dotnet.exe'
if (-not (Test-Path -LiteralPath $sdkPath)) { $sdkPath = (Get-Command dotnet -ErrorAction Stop).Source }
$publishDirectory = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDirectory))
if (-not $publishDirectory.StartsWith($repositoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay inside the repository.' }
& $sdkPath publish (Join-Path $repositoryRoot 'native/MomentVault.Host/MomentVault.Host.csproj') -c Release -r win-x64 --self-contained true -o $publishDirectory
if ($LASTEXITCODE -ne 0) { throw 'Native helper build failed' }

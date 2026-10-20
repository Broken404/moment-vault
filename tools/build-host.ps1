$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sdkPath = Join-Path $repositoryRoot '.tools/dotnet/dotnet.exe'
if (-not (Test-Path -LiteralPath $sdkPath)) { $sdkPath = (Get-Command dotnet -ErrorAction Stop).Source }
& $sdkPath publish (Join-Path $repositoryRoot 'native/MomentVault.Host/MomentVault.Host.csproj') -c Release -r win-x64 --self-contained true -o (Join-Path $repositoryRoot 'dist/host')
if ($LASTEXITCODE -ne 0) { throw 'Native helper build failed' }

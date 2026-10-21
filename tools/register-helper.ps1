param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$registryPaths = @(
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.momentvault.host',
    # Edge documents this Chrome registry location as a supported fallback.
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.momentvault.host'
)
if ($Unregister) {
    foreach ($registryPath in $registryPaths) {
        if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
    }
    Write-Output 'Moment Vault helper registration removed; material files were kept.'
    exit
}
$identity = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'config/extension-identity.json') | ConvertFrom-Json
$hostExecutable = Join-Path $repositoryRoot 'dist/host/MomentVault.Host.exe'
if (-not (Test-Path -LiteralPath $hostExecutable)) { throw 'Build the helper first: npm run build:host' }
$manifestPath = Join-Path $repositoryRoot 'dist/host/com.momentvault.host.json'
$hostManifest = @{ name='com.momentvault.host'; description='Moment Vault local material helper'; path=$hostExecutable; type='stdio'; allowed_origins=@("chrome-extension://$($identity.id)/") } | ConvertTo-Json -Depth 4
# Windows PowerShell 5.1 and PowerShell 7 use different defaults for UTF-8.
[IO.File]::WriteAllText($manifestPath, $hostManifest + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
foreach ($registryPath in $registryPaths) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $manifestPath
}
Write-Output 'Registered for the current Windows user: Edge and its documented compatibility lookup. No service or listening port was created.'

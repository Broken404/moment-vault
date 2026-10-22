$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sdkPath = Join-Path $repositoryRoot '.tools/dotnet/dotnet.exe'
if (-not (Test-Path -LiteralPath $sdkPath)) { $sdkPath = (Get-Command dotnet -ErrorAction Stop).Source }
$encoderPath = (Get-Command ffmpeg -ErrorAction Stop).Source
$probePath = (Get-Command ffprobe -ErrorAction Stop).Source
$fixtureRoot = Join-Path $repositoryRoot ('.local-data/media-fixtures-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$validFixture = Join-Path $fixtureRoot 'moving.webm'
$tailFixture = Join-Path $fixtureRoot 'audio-tail.webm'

# Both sources are generated locally. The second deliberately stops video at 0.5s
# while retaining 2s of audio; it is a synthetic guard test, not a captured bug.
& $encoderPath -nostdin -v error -n -f lavfi -i 'testsrc2=size=640x360:rate=30:duration=2' -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:v libvpx-vp9 -c:a libopus $validFixture
if ($LASTEXITCODE -ne 0) { throw 'Could not generate the moving fixture.' }
& $encoderPath -nostdin -v error -n -f lavfi -i 'testsrc2=size=640x360:rate=30:duration=0.5' -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:v libvpx-vp9 -c:a libopus $tailFixture
if ($LASTEXITCODE -ne 0) { throw 'Could not generate the synthetic audio-tail fixture.' }

# Executable overrides belong only to this developer test. Browser messages
# cannot choose executables; the product host uses its own bundled media tools.
& $sdkPath run --project (Join-Path $repositoryRoot 'native/MomentVault.Media.Tests') -c Release -- $encoderPath $probePath $validFixture $tailFixture (Join-Path $fixtureRoot 'results')
if ($LASTEXITCODE -ne 0) { throw 'Native recording media checks failed.' }

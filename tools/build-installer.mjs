import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

assert.equal(process.platform, 'win32', 'Build the Windows installer on Windows');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const root = path.resolve('.');
const check = args.includes('--install-check');
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const version = option('--version', metadata.version);
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.ok(check || version === metadata.version, 'Production version must match package.json');
const identity = JSON.parse(await readFile('config/extension-identity.json', 'utf8'));
const mediaRoot = path.resolve(option('--media-directory', 'dist/host-library-load/media'));
const compiler = path.resolve(option('--compiler', '.tools/inno/ISCC.exe'));
const stage = path.join(root, 'dist', check ? 'installer-check-payload' : 'installer-payload');
const output = path.join(root, 'dist', check ? 'installer-check' : 'installer');
const ownedDist = path.join(root, 'dist') + path.sep;
assert.ok(stage.startsWith(ownedDist) && output.startsWith(ownedDist));
assert.ok((await stat(compiler)).isFile(), 'Provide Inno Setup ISCC.exe with --compiler');
assert.ok(
  !process.env.MOMENT_VAULT_OWNED_CAPTURE_LAB && !process.env.MOMENT_VAULT_VIDEO_PERFORMANCE_LAB,
  'Installer builds must not enable development fixtures',
);

async function run(executable, arguments_, capture = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: root,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let result = '';
    if (capture) {
      child.stdout.on('data', (bytes) => {
        result += bytes;
      });
      child.stderr.on('data', (bytes) => {
        result += bytes;
      });
    }
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(result.trim())
        : reject(new Error(`${executable} exited ${code}: ${result}`)),
    );
  });
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(output, { recursive: true });
await run('powershell.exe', ['-NoProfile', '-Command', 'npm.cmd run build; exit $LASTEXITCODE']);
const extension = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
assert.equal(extension.version, metadata.version);
assert.equal(extension.key, identity.key);
const project = await readFile('native/MomentVault.Host/MomentVault.Host.csproj', 'utf8');
assert.ok(
  project.includes(`<Version>${metadata.version}</Version>`),
  'Helper/package versions must match',
);
await run('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  'tools/build-host.ps1',
  '-OutputDirectory',
  path.relative(root, path.join(stage, 'host')),
]);
for (const file of await readdir(path.join(stage, 'host')))
  if (file.endsWith('.pdb')) await rm(path.join(stage, 'host', file));
await cp('dist/extension', path.join(stage, 'extension'), { recursive: true });
await cp('LICENSE', path.join(stage, 'LICENSE'));
await mkdir(path.join(stage, 'host/media'), { recursive: true });
await mkdir(path.join(stage, 'notices'), { recursive: true });

const tools = [];
for (const name of ['ffmpeg', 'ffprobe']) {
  const file = path.join(mediaRoot, `${name}.exe`);
  const information = await run(file, ['-version'], true);
  assert.ok(!information.includes('--enable-nonfree'), 'Nonfree FFmpeg builds cannot be packaged');
  tools.push({
    file: `${name}.exe`,
    sha256: sha256(await readFile(file)),
    version: information.split(/\r?\n/)[0],
    configuration: information.split(/\r?\n/).find((line) => line.startsWith('configuration:')),
  });
  await cp(file, path.join(stage, 'host/media', `${name}.exe`));
}
for (const name of ['LICENSE-FFmpeg.txt', 'README-FFmpeg.txt'])
  await cp(path.join(mediaRoot, name), path.join(stage, 'host/media', name));
const mediaReadme = await readFile(path.join(mediaRoot, 'README-FFmpeg.txt'), 'utf8');
assert.match(mediaReadme, /Source Code: https:\/\//);
await writeFile(
  path.join(stage, 'host/media/tool-provenance.json'),
  JSON.stringify(
    {
      scope: 'Private self-use installer, not a public redistribution release.',
      tools,
      source: mediaReadme.match(/Source Code: (\S+)/)[1],
      license:
        'See original LICENSE-FFmpeg.txt and README-FFmpeg.txt. FFmpeg runs as a separate process.',
    },
    null,
    2,
  ) + '\n',
);
// Use the published runtime's exact NuGet pack notices, not the SDK license.
const runtimeConfig = JSON.parse(
  await readFile(path.join(stage, 'host/MomentVault.Host.runtimeconfig.json'), 'utf8'),
);
const frameworks = runtimeConfig.runtimeOptions.includedFrameworks;
const runtimeVersion = frameworks.find(
  (framework) => framework.name === 'Microsoft.NETCore.App',
).version;
const nugetRoot = path.resolve(
  option(
    '--nuget-directory',
    process.env.NUGET_PACKAGES ?? path.join(os.homedir(), '.nuget/packages'),
  ),
);
const runtimeRoot = path.join(nugetRoot, 'microsoft.netcore.app.runtime.win-x64', runtimeVersion);
for (const name of ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'])
  await cp(path.join(runtimeRoot, name), path.join(stage, 'notices', `.NET-${name}`));
const desktopVersion = frameworks.find(
  (framework) => framework.name === 'Microsoft.WindowsDesktop.App',
).version;
await cp(
  path.join(nugetRoot, 'microsoft.windowsdesktop.app.runtime.win-x64', desktopVersion, 'LICENSE'),
  path.join(stage, 'notices/.NET-WindowsDesktop-LICENSE.txt'),
);
await cp('packaging/windows/INSTALL.txt', path.join(stage, 'INSTALL.txt'));
await writeFile(path.join(stage, 'host/com.momentvault.host.json'), '{}\n');

const files = [];
async function inventory(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await inventory(path.join(directory, entry.name), relative + '/');
    else {
      const bytes = await readFile(path.join(directory, entry.name));
      files.push({ file: relative, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
}
await inventory(stage);
const receipt = {
  version,
  extensionVersion: extension.version,
  extensionId: identity.id,
  protocol: 1,
  scope: check
    ? 'Isolated installer lifecycle check; version labels are synthetic.'
    : 'Private self-use candidate; no release tag or public distribution.',
  sourceCommit: await run('git.exe', ['rev-parse', 'HEAD'], true),
  sourceDirty: Boolean(await run('git.exe', ['status', '--porcelain'], true)),
  runtimeVersion,
  compiler: { sha256: sha256(await readFile(compiler)), testedToolchain: 'Inno Setup 6.7.3' },
  mediaTools: tools,
  files,
};
await writeFile(path.join(stage, 'package-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
await run(compiler, [
  '/Qp',
  `/DPayloadDir=${stage}`,
  `/DOutputDir=${output}`,
  `/DAppVersion=${version}`,
  `/DExtensionId=${identity.id}`,
  `/DOutputSuffix=${check ? '-installcheck' : ''}`,
  ...(check ? ['/DInstallCheck=1'] : []),
  path.join(root, 'packaging/windows/moment-vault.iss'),
]);
const installer = path.join(
  output,
  `MomentVault-${version}-win-x64${check ? '-installcheck' : ''}.exe`,
);
const installerHash = sha256(await readFile(installer));
await writeFile(installer + '.sha256', `${installerHash}  ${path.basename(installer)}\n`);
await cp(path.join(stage, 'package-receipt.json'), installer + '.receipt.json');
console.log(`Built ${installer}\nSHA256 ${installerHash}`);

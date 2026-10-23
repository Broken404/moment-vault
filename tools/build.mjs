import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await build();
await build({
  configFile: false,
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __MV_OWNED_CAPTURE_LAB__: JSON.stringify(process.env.MOMENT_VAULT_OWNED_CAPTURE_LAB === '1'),
  },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
  },
  build: {
    target: 'chrome120',
    minify: true,
    outDir: 'dist/extension',
    emptyOutDir: false,
    lib: {
      entry: 'apps/extension/src/content.tsx',
      name: 'MomentVault',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
await mkdir('dist/extension', { recursive: true });
const manifest = JSON.parse(await readFile('apps/extension/manifest.json', 'utf8'));
const identity = JSON.parse(await readFile('config/extension-identity.json', 'utf8'));
manifest.key = identity.key;
await writeFile('dist/extension/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
await cp('apps/extension/public', 'dist/extension', { recursive: true });
await cp('LICENSE', 'dist/extension/LICENSE');
const licenses = [];
for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react']) {
  const metadata = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  licenses.push(
    `${name} ${metadata.version}\n${await readFile(`node_modules/${name}/LICENSE`, 'utf8')}`,
  );
}
await writeFile('dist/extension/THIRD-PARTY-NOTICES.txt', licenses.join('\n\n---\n\n'));
console.log(`Unpacked extension: dist/extension (${identity.id})`);
if (process.env.MOMENT_VAULT_OWNED_CAPTURE_LAB === '1')
  console.log(
    'Development-only owned capture fixture enabled: http://127.0.0.1:43820/capture.html',
  );

// Technical spike. Files stay in user-selected scratch directories.
export function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('moment-vault-spike', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('config');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function config(key, value) {
  const database = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction('config', value === undefined ? 'readonly' : 'readwrite');
      const request = value === undefined ? tx.objectStore('config').get(key) : tx.objectStore('config').put(value, key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Configuration write aborted'));
    });
  } finally { database.close(); }
}
export async function roots() {
  const draft = await config('draft');
  const library = await config('library');
  if (!draft || !library) throw new Error('Configure both scratch directories first');
  for (const handle of [draft, library]) {
    if (await handle.queryPermission({mode: 'readwrite'}) !== 'granted') throw new Error('Directory permission is not granted; select it again');
  }
  if (await draft.isSameEntry(library)) throw new Error('Draft and library must be different directories');
  return {draft, library};
}
export async function hash(blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function write(directory, name, data) {
  const handle = await directory.getFileHandle(name, {create: true});
  const stream = await handle.createWritable();
  try { await stream.write(data); await stream.close(); }
  catch (error) { await stream.abort().catch(() => {}); throw error; }
  return handle;
}
export async function saveItem(blob, extension, metadata) {
  const {draft} = await roots();
  const item = `spike-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const directory = await draft.getDirectoryHandle(item, {create: true});
  const mediaName = `material.${extension}`;
  const media = await write(directory, mediaName, blob);
  const expectedHash = await hash(blob);
  if (await hash(await media.getFile()) !== expectedHash) throw new Error(`Media verification failed: ${item}`);
  const description = `# Technical spike\n\nSource: ${metadata.source || 'unconfirmed'}\n\nCollected: ${metadata.collectedAt}\n\nNotes: ${metadata.notes || ''}\n\n<!-- Experiment measurements; not AI output. -->\n\n\`\`\`json\n${JSON.stringify({...metadata, bytes: blob.size, sha256: expectedHash}, null, 2)}\n\`\`\`\n`;
  const note = await write(directory, 'description.md', description);
  if (await (await note.getFile()).text() !== description) throw new Error(`Description verification failed: ${item}`);
  return {item, mediaName, bytes: blob.size, sha256: expectedHash, metadata};
}
export async function snapshot(directory, prefix = '') {
  const result = {};
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'directory') Object.assign(result, await snapshot(handle, `${prefix}${name}/`));
    else { const file = await handle.getFile(); result[prefix + name] = {bytes: file.size, sha256: await hash(file)}; }
  }
  return result;
}
async function copy(source, target) {
  for await (const [name, entry] of source.entries()) {
    if (entry.kind === 'directory') await copy(entry, await target.getDirectoryHandle(name, {create: true}));
    else await write(target, name, await entry.getFile());
  }
}
export async function promote(item) {
  if (!/^spike-[a-zA-Z0-9-]+$/.test(item)) throw new Error('Only spike-created item folders can be moved');
  const {draft, library} = await roots();
  const source = await draft.getDirectoryHandle(item);
  try { await library.getDirectoryHandle(item); throw new Error('Destination already exists; source retained'); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
  const before = await snapshot(source);
  if (Object.keys(before).length < 2) throw new Error('Incomplete source item');
  const target = await library.getDirectoryHandle(item, {create: true});
  await copy(source, target);
  const after = await snapshot(target);
  const unchanged = await snapshot(source);
  const canonical = x => JSON.stringify(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)));
  if (canonical(before) !== canonical(after) || canonical(before) !== canonical(unchanged)) throw new Error('Copy verification failed or source changed; source retained');
  try { await draft.removeEntry(item, {recursive: true}); }
  catch (error) { return {status: 'copied-source-retained', item, files: after, error: error.message}; }
  return {status: 'moved', item, files: after};
}

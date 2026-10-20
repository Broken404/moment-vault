import type { HostOperation, HostResponse, Material, Preferences } from '@shared/model';
import { DEFAULT_PREFERENCES, validatePreferences } from '@shared/model';

const extensions: Record<string, { kind: 'image' | 'video'; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  gif: { kind: 'image', mime: 'image/gif' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
};
const imageExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function host<T>(
  op: HostOperation,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const response: HostResponse<T> = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'host',
    op,
    payload,
  });
  if (!response?.ok)
    throw new Error(response?.error?.message ?? '本地助手没有返回结果，请重新检测连接');
  return response.result!;
}
export async function preferences(): Promise<Preferences> {
  return validatePreferences((await chrome.storage.local.get('preferences')).preferences);
}
export async function setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const result = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'preferences',
    patch,
  });
  if (result?.ok === false) throw new Error(result.error?.message ?? '设置保存失败');
  return validatePreferences(result);
}
export async function restorePreferences(): Promise<void> {
  await setPreferences({ ...DEFAULT_PREFERENCES });
}
export async function openManager(page: string): Promise<void> {
  const result = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'open-manager',
    page,
  });
  if (!result?.ok) throw new Error(result?.error?.message ?? '无法打开管理页面');
}

export function fileKind(file: File): 'image' | 'video' | null {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  if (extensions[extension]) return extensions[extension].kind;
  // Clipboard files may have no extension; use an exact supported MIME list.
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
    ? 'image'
    : null;
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export interface UploadBatch {
  uploadId: string;
  name: string;
  attachments: { id: string }[];
  fileIndex: number;
  nextChunk: number;
}
export function beginUpload(files: File[]): UploadBatch {
  if (!files.length || files.some((file) => !fileKind(file) || file.size === 0))
    throw new Error('请选择非空的 PNG、JPEG、WebP、GIF 或 MP4、WebM、MOV 文件');
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return {
    uploadId: crypto.randomUUID().replaceAll('-', ''),
    name: `${date}-${files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : files.every((f) => fileKind(f) === 'image') ? '图片组' : '素材组'}`,
    attachments: files.map(() => ({ id: crypto.randomUUID().replaceAll('-', '') })),
    fileIndex: 0,
    nextChunk: 0,
  };
}
export async function uploadFiles(
  files: File[],
  batch: UploadBatch,
  onProgress: (text: string) => void,
): Promise<Material> {
  const descriptors = files.map((file, index) => ({
    id: batch.attachments[index].id,
    extension: file.name.includes('.')
      ? file.name.split('.').at(-1)!.toLowerCase()
      : imageExtensions[file.type],
    kind: fileKind(file),
    mime:
      file.type ||
      extensions[file.name.split('.').at(-1)!.toLowerCase()]?.mime ||
      'application/octet-stream',
    source: '',
    note: '',
  }));
  await host('items.begin', { uploadId: batch.uploadId, name: batch.name, files: descriptors });
  for (let index = batch.fileIndex; index < files.length; index++) {
    const file = files[index];
    const attachmentId = batch.attachments[index].id;
    let chunks = batch.nextChunk;
    for (let offset = chunks * 192 * 1024; offset < file.size; offset += 192 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 192 * 1024).arrayBuffer());
      onProgress(
        `正在保存 ${index + 1}/${files.length} · ${Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100))}%`,
      );
      // One acknowledged request at a time bounds memory and permits service
      // worker/native port errors to surface before claiming a saved material.
      await host('items.append', {
        uploadId: batch.uploadId,
        attachmentId,
        sequence: chunks,
        base64: base64(bytes),
      });
      chunks++;
      batch.nextChunk = chunks;
    }
    await host('items.finishFile', {
      uploadId: batch.uploadId,
      attachmentId,
      chunks,
      bytes: file.size,
    });
    batch.fileIndex = index + 1;
    batch.nextChunk = 0;
  }
  return host<Material>('items.commit', { uploadId: batch.uploadId });
}

export async function readAttachment(
  bucket: string,
  id: string,
  attachmentId: string,
): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0,
    total = 1,
    mime = '';
  while (offset < total) {
    const result = await host<{ base64: string; total: number; mime: string }>('items.readFile', {
      bucket,
      id,
      attachmentId,
      offset,
    });
    const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
    if (!bytes.length) throw new Error('附件读取中断，请重新打开');
    chunks.push(bytes);
    offset += bytes.length;
    total = result.total;
    mime = result.mime;
    if (total > 20 * 1024 * 1024) throw new Error('较大附件请使用本地打开');
  }
  return new Blob(chunks, { type: mime });
}

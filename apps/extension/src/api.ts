import type { HostOperation, HostResponse, HostStatus, Material, Preferences } from '@shared/model';
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

export class HostError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function host<T>(
  op: HostOperation,
  payload: Record<string, unknown> = {},
): Promise<T> {
  let response: HostResponse<T>;
  if (op === 'folder.pick') {
    if (location.href.split('#')[0] !== chrome.runtime.getURL('manage.html'))
      throw new Error('请从扩展设置页选择目录');
    // A page-originated native request carries the browser window handle.
    // Service-worker requests carry parent-window=0 and cannot own a dialog.
    const id = crypto.randomUUID();
    response = await chrome.runtime.sendNativeMessage('com.momentvault.host', {
      protocol: 1,
      id,
      op,
      payload,
    });
    if (response?.id !== id) throw new Error('目录选择器返回的结果无效，请重试');
  } else {
    response = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'host',
      op,
      payload,
    });
  }
  if (!response?.ok)
    throw new HostError(
      response?.error?.message ?? '本地助手没有返回结果，请重新检测连接',
      response?.error?.code,
    );
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
  draftRoot?: string;
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
  if (!batch.draftRoot) {
    const status = await host<HostStatus>('ping');
    if (!status.configured) throw new Error('请先连接本地助手并配置有效的草稿目录');
    batch.draftRoot = status.config.draftRoot;
  }
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
    originalName: file.name,
    bytes: file.size,
    lastModified: file.lastModified,
  }));
  const result = await host<{ recovery?: UploadProgress }>('items.begin', {
    uploadId: batch.uploadId,
    draftRoot: batch.draftRoot,
    name: batch.name,
    files: descriptors,
  });
  if (result.recovery?.phase === 'saved') return result.recovery.item!;
  for (let index = batch.fileIndex; index < files.length; index++) {
    if (result.recovery?.files[index]?.complete) {
      batch.fileIndex = index + 1;
      batch.nextChunk = 0;
      continue;
    }
    const file = files[index];
    const attachmentId = batch.attachments[index].id;
    let chunks = batch.nextChunk;
    for (let offset = chunks * 192 * 1024; offset < file.size; offset += 192 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 192 * 1024).arrayBuffer());
      // One acknowledged request at a time bounds memory and permits service
      // worker/native port errors to surface before claiming a saved material.
      await host('items.append', {
        uploadId: batch.uploadId,
        draftRoot: batch.draftRoot,
        attachmentId,
        sequence: chunks,
        base64: base64(bytes),
      });
      chunks++;
      batch.nextChunk = chunks;
      onProgress(
        `正在保存 ${index + 1}/${files.length} · ${Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100))}%`,
      );
    }
    await host('items.finishFile', {
      uploadId: batch.uploadId,
      draftRoot: batch.draftRoot,
      attachmentId,
      chunks,
      bytes: file.size,
    });
    batch.fileIndex = index + 1;
    batch.nextChunk = 0;
  }
  onProgress('附件已收齐，正在完成保存…');
  return host<Material>('items.commit', { uploadId: batch.uploadId, draftRoot: batch.draftRoot });
}

export interface UploadFileProgress {
  id: string;
  fileName: string;
  originalName: string;
  extension: string;
  kind: 'image' | 'video';
  mime: string;
  bytes: number | null;
  lastModified: number | null;
  complete: boolean;
  receivedBytes: number;
}
export interface UploadProgress {
  phase: 'pending' | 'saved';
  id: string;
  name: string;
  createdAt: string;
  files: UploadFileProgress[];
  item?: Material;
}
export interface UploadSummary {
  id: string;
  name: string;
  createdAt: string;
  fileCount: number;
  completeFiles: number;
  receivedBytes: number;
  totalBytes: number | null;
}
export interface UploadList {
  items: UploadSummary[];
  total: number;
  warnings: string[];
}

// Browser file references cannot survive a page close. Ask only for incomplete
// originals, match their metadata, and replay the retained prefix for native
// byte-for-byte verification before sending the remainder. Never create an ID.
export async function resumeUpload(
  draftRoot: string,
  uploadId: string,
  selected: File[],
  onProgress: (text: string) => void,
): Promise<Material> {
  const progress = await host<UploadProgress>('uploads.get', { draftRoot, uploadId });
  if (progress.phase === 'saved') return progress.item!;
  const missing = progress.files.filter((file) => !file.complete);
  if (missing.length !== selected.length)
    throw new Error(`请选择尚未收齐的 ${missing.length} 个原文件，已收齐的附件无需重选`);
  const remaining = [...selected];
  const matched = missing.map((file) => {
    const index = remaining.findIndex(
      (input) =>
        fileKind(input) === file.kind &&
        (input.name.split('.').at(-1)?.toLowerCase() === file.extension ||
          (!input.name.includes('.') && imageExtensions[input.type] === file.extension)) &&
        (!file.originalName || input.name === file.originalName) &&
        (file.bytes === null || input.size === file.bytes) &&
        (file.lastModified === null || input.lastModified === file.lastModified),
    );
    if (index < 0)
      throw new Error(
        `原文件不匹配：${file.originalName || file.fileName}。请保持文件名、大小和修改时间不变后重选`,
      );
    return { attachment: file, input: remaining.splice(index, 1)[0] };
  });
  for (const [index, { attachment, input }] of matched.entries()) {
    let sequence = 0;
    for (let offset = 0; offset < input.size; offset += 192 * 1024) {
      const bytes = new Uint8Array(await input.slice(offset, offset + 192 * 1024).arrayBuffer());
      await host('items.append', {
        draftRoot,
        uploadId,
        attachmentId: attachment.id,
        sequence,
        base64: base64(bytes),
      });
      sequence++;
      const verified = offset + bytes.length;
      onProgress(
        `${verified <= attachment.receivedBytes ? '正在核对已收到的内容' : '正在继续保存'} ${index + 1}/${matched.length} · ${Math.round((Math.max(attachment.receivedBytes, verified) / input.size) * 100)}%`,
      );
    }
    await host('items.finishFile', {
      draftRoot,
      uploadId,
      attachmentId: attachment.id,
      chunks: sequence,
      bytes: input.size,
    });
  }
  onProgress('附件已收齐，正在完成保存…');
  return host<Material>('items.commit', { draftRoot, uploadId });
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

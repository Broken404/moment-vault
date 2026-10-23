export type Bucket = 'draft' | 'library' | 'trash';
export type Theme = 'system' | 'light' | 'dark';
export type Locale = 'system' | 'zh-CN' | 'en';
export type MediaKind = 'image' | 'video';

export interface Preferences {
  theme: Theme;
  language: Locale;
  petSize: 48 | 64 | 80;
  petOpacity: number;
  petHidden: boolean;
  petPosition: { x: number; y: number } | null;
  step: number;
  fineStep: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  language: 'system',
  petSize: 64,
  petOpacity: 1,
  petHidden: false,
  petPosition: null,
  step: 5,
  fineStep: 1,
};

export interface Attachment {
  id: string;
  fileName: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  sha256: string;
  collectedAt: string;
  source: string;
  note: string;
  range?: {
    a: number;
    b: number;
    actualStart: number | null;
    actualEnd: number | null;
    stopReason?: string;
    duration?: number;
    capture?: string;
  };
}

export interface Material {
  formatVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  approvedAt?: string;
  attachments: Attachment[];
  note: string;
  revision: string;
  bucket: Bucket;
  folderName: string;
}

export interface HostConfig {
  draftRoot: string;
  libraryRoot: string;
}
export interface HostStatus {
  protocol: 1;
  version: string;
  configured: boolean;
  config: HostConfig;
  pendingUploads: number;
  storageError?: string;
  recordingToolsAvailable?: boolean;
}

export interface RecordingProgress {
  phase: 'capturing' | 'processing' | 'failed' | 'saved';
  item?: Material;
  error?: string;
}

export type HostOperation =
  | 'ping'
  | 'config.get'
  | 'config.set'
  | 'folder.pick'
  | 'items.list'
  | 'items.get'
  | 'items.begin'
  | 'items.append'
  | 'items.finishFile'
  | 'items.commit'
  | 'recordings.begin'
  | 'recordings.process'
  | 'recordings.status'
  | 'items.update'
  | 'items.open'
  | 'items.promote'
  | 'items.recycle'
  | 'items.restore'
  | 'items.delete'
  | 'items.merge'
  | 'items.readFile';

export interface HostRequest {
  protocol: 1;
  id: string;
  op: HostOperation;
  payload: Record<string, unknown>;
}
export interface HostResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; retryable: boolean };
}
export interface TransferResult {
  id: string;
  status: string;
  error?: string;
}
export interface MergeResult {
  status: 'merged' | 'source-retained';
  item: Material;
  retainedSourceIds: string[];
  error?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validatePreferences(value: unknown): Preferences {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<Preferences>;
  const defaults = DEFAULT_PREFERENCES;
  return {
    theme: ['system', 'light', 'dark'].includes(input.theme ?? '') ? input.theme! : defaults.theme,
    language: ['system', 'zh-CN', 'en'].includes(input.language ?? '')
      ? input.language!
      : defaults.language,
    petSize: [48, 64, 80].includes(input.petSize ?? 0) ? input.petSize! : defaults.petSize,
    petOpacity:
      typeof input.petOpacity === 'number' && Number.isFinite(input.petOpacity)
        ? Math.max(0.3, Math.min(1, input.petOpacity))
        : defaults.petOpacity,
    petHidden: input.petHidden === true,
    petPosition:
      input.petPosition &&
      Number.isFinite(input.petPosition.x) &&
      Number.isFinite(input.petPosition.y)
        ? {
            x: Math.max(0, Math.min(1, input.petPosition.x)),
            y: Math.max(0, Math.min(1, input.petPosition.y)),
          }
        : null,
    step:
      typeof input.step === 'number' && Number.isFinite(input.step) && input.step > 0
        ? input.step
        : defaults.step,
    fineStep:
      typeof input.fineStep === 'number' && Number.isFinite(input.fineStep) && input.fineStep > 0
        ? input.fineStep
        : defaults.fineStep,
  };
}

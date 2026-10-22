import type { JobStore, RecordingJob } from './types';

const opened = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('moment-vault-recordings', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('jobs', { keyPath: 'id' });
    request.result.createObjectStore('parts');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function transaction<T>(
  name: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await opened;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode),
      request = action(tx.objectStore(name));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error('本机录制暂存写入被中断。'));
  });
}
export const recordingStore: JobStore = {
  async put(job) {
    await transaction('jobs', 'readwrite', (store) => store.put(structuredClone(job)));
  },
  async part(id, index, blob) {
    await transaction('parts', 'readwrite', (store) => store.put(blob, [id, index]));
  },
  async readPart(id, index) {
    const part = await transaction<Blob | undefined>('parts', 'readonly', (store) =>
      store.get([id, index]),
    );
    if (!part) throw new Error('录制暂存分块缺失，已保留其余原始数据。');
    return part;
  },
  list() {
    return transaction<RecordingJob[]>('jobs', 'readonly', (store) => store.getAll());
  },
  async remove(id) {
    const db = await opened;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['jobs', 'parts'], 'readwrite');
      tx.objectStore('jobs').delete(id);
      tx.objectStore('parts').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
};

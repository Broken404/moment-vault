import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  FolderCheck,
  FolderOpen,
  Inbox,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
  RotateCcw,
  Image,
  FileVideo,
} from 'lucide-react';
import {
  beginUpload,
  host,
  preferences,
  readAttachment,
  restorePreferences,
  setPreferences,
  uploadFiles,
  type UploadBatch,
} from './api';
import type {
  Bucket,
  HostConfig,
  HostStatus,
  Material,
  Preferences,
  TransferResult,
} from '@shared/model';
import { DEFAULT_PREFERENCES, errorMessage } from '@shared/model';
import { Pet, themeName } from './ui';
import './theme.css';
import './manage.css';
import { RecordingRecovery } from './recording/recovery';

const names: Record<string, string> = {
  draft: '草稿箱',
  library: '资产库',
  trash: '回收区',
  settings: '设置',
};
const descriptions: Record<Bucket, string> = {
  draft: '先留下灵感，再决定哪些值得入库。',
  library: '由你审核，完整保留在本地。',
  trash: '还可以恢复，暂时不用急着决定。',
};

function SettingsPage({
  initial,
  changed,
  show,
}: {
  initial: HostStatus | null;
  changed: (status: HostStatus) => void;
  show: (text: string) => void;
}) {
  const [config, setConfig] = useState<HostConfig>(
    initial?.config ?? { draftRoot: '', libraryRoot: '' },
  );
  const [prefs, setPrefs] = useState(DEFAULT_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(!!initial);
  const [error, setError] = useState('');
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  const [steps, setSteps] = useState({ step: '5', fineStep: '1' });
  const [help, setHelp] = useState(false);
  useEffect(() => {
    void preferences().then((value) => {
      setPrefs(value);
      setSteps({ step: String(value.step), fineStep: String(value.fineStep) });
    });
    void chrome.runtime.sendMessage({ target: 'background', type: 'commands' }).then(setCommands);
  }, []);
  const detect = useCallback(async () => {
    setBusy(true);
    try {
      const status = await host<HostStatus>('ping');
      setConnected(true);
      setConfig(status.config);
      changed(status);
      setError('');
      show('本地助手已连接');
    } catch (failure) {
      setConnected(false);
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [changed, show]);
  useEffect(() => {
    if (!initial) void detect();
  }, []); // Initial handshake only; retries stay explicit.
  async function savePreferences(patch: Partial<Preferences>) {
    try {
      const next = await setPreferences(patch);
      setPrefs(next);
      show('已保存');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  async function pick(key: keyof HostConfig) {
    setBusy(true);
    setError('');
    try {
      const selected = await host<{ cancelled: boolean; path: string }>('folder.pick', {
        title: key === 'draftRoot' ? '选择草稿箱' : '选择资产库',
        initial: config[key],
      });
      if (selected.cancelled) return;
      const next = { ...config, [key]: selected.path };
      setConfig(next);
      if (next.draftRoot && next.libraryRoot) {
        await host('config.set', { ...next });
        const status = await host<HostStatus>('ping');
        changed(status);
        show('目录检查通过，已保存');
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-grid stack">
      {!initial?.configured && (
        <div className="status">
          首次使用：连接本地助手，分别选择草稿箱和资产库，即可开始接收图片。
        </div>
      )}
      {!!initial?.storageError && (
        <div className="status error">{initial.storageError}，请重新选择可用目录。</div>
      )}
      <section className="settings-card stack">
        <div className="section-title">
          <h2>存储位置</h2>
          <span className="muted">素材直接保存为本地文件</span>
        </div>
        {(['draftRoot', 'libraryRoot'] as const).map((key) => (
          <div key={key} className="path-row">
            <div>
              <b>{key === 'draftRoot' ? '草稿箱' : '资产库'}</b>
              <p>{config[key] || '尚未选择'}</p>
              <small className="muted">
                {key === 'draftRoot'
                  ? '先收集，稍后整理与审核。'
                  : '人工审核通过的素材保存在这里。'}
              </small>
            </div>
            <button className="button" disabled={busy || !connected} onClick={() => void pick(key)}>
              <FolderOpen />
              选择目录
            </button>
          </div>
        ))}
        <small className="muted">可选择不同磁盘。更换目录只切换当前库，旧素材保留在原位置。</small>
      </section>
      <section className="settings-card stack">
        <div className="section-title">
          <h2>界面与桌宠</h2>
          <Pet size={42} action="settings" />
        </div>
        <div className="settings-fields">
          <label className="field">
            界面主题
            <select
              value={prefs.theme}
              onChange={(e) =>
                void savePreferences({ theme: e.target.value as Preferences['theme'] })
              }
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="field">
            桌宠大小
            <select
              value={prefs.petSize}
              onChange={(e) =>
                void savePreferences({ petSize: Number(e.target.value) as Preferences['petSize'] })
              }
            >
              <option value={48}>小 · 48 px</option>
              <option value={64}>中 · 64 px</option>
              <option value={80}>大 · 80 px</option>
            </select>
          </label>
          <label className="field">
            桌宠不透明度 · {Math.round(prefs.petOpacity * 100)}%
            <input
              type="range"
              min={30}
              max={100}
              step={1}
              value={prefs.petOpacity * 100}
              onChange={(e) => void savePreferences({ petOpacity: Number(e.target.value) / 100 })}
            />
            <small>只调整桌宠，菜单与面板保持清晰。</small>
          </label>
          <div className="field">
            <span>桌宠位置</span>
            <button
              className="button"
              onClick={() => void savePreferences({ petPosition: null, petHidden: false })}
            >
              恢复默认位置并显示
            </button>
          </div>
        </div>
      </section>
      <section className="settings-card stack">
        <h2>视频与快捷键</h2>
        <div className="status">
          打开普通视频页的选段模式后，用录制快捷键开始或提前结束。录制停止后转成
          MP4，保存成功才出现在草稿箱。
        </div>
        <div className="settings-fields">
          {(['step', 'fineStep'] as const).map((key) => (
            <label className="field" key={key}>
              {key === 'step' ? '方向键步长（秒）' : 'Ctrl＋方向键步长（秒）'}
              <input
                type="number"
                min="0.001"
                step="any"
                value={steps[key]}
                onChange={(e) => setSteps({ ...steps, [key]: e.target.value })}
                onBlur={() => {
                  const value = Number(steps[key]);
                  if (!Number.isFinite(value) || value <= 0) {
                    setError('请输入有效的正数步长');
                    return;
                  }
                  void savePreferences({ [key]: value });
                }}
              />
            </label>
          ))}
        </div>
        {commands
          .filter((c) => c.name === 'toggle-mode' || c.name === 'record-selection')
          .map((command) => (
            <div className="section-title" key={command.name}>
              <span>{command.description}</span>
              <kbd>{command.shortcut || '未绑定'}</kbd>
            </div>
          ))}
        <button
          className="button"
          onClick={() => void chrome.tabs.create({ url: 'edge://extensions/shortcuts' })}
        >
          在 Edge 管理快捷键
        </button>
      </section>
      <section className="settings-card stack">
        <div className="section-title">
          <h2>本地助手</h2>
          <span>{connected ? '已连接 · 0.1.0' : '尚未连接'}</span>
        </div>
        <div className="row">
          <button className="button" disabled={busy} onClick={() => void detect()}>
            <RefreshCw />
            重新检测
          </button>
          <button className="button" onClick={() => setHelp((value) => !value)}>
            安装说明
          </button>
        </div>
        {help && (
          <div className="status">
            请使用与扩展配套的本地助手。当前开发版按仓库 docs/development.md
            构建并注册；正式安装包尚未发布。助手按需启动，不要求日常打开终端。
          </div>
        )}
      </section>
      {!!error && (
        <div className="status error" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button
          className="button"
          onClick={() => {
            void restorePreferences()
              .then(() => preferences())
              .then((value) => {
                setPrefs(value);
                setSteps({ step: String(value.step), fineStep: String(value.fineStep) });
                show('已恢复默认设置，目录与素材保留');
              })
              .catch((failure) => setError(errorMessage(failure)));
          }}
        >
          <RotateCcw />
          恢复默认设置
        </button>
        <small className="muted">保留目录和素材，快捷键由 Edge 管理。</small>
      </div>
    </div>
  );
}

function Detail({
  item,
  bucket,
  updated,
  show,
}: {
  item: Material;
  bucket: Bucket;
  updated: () => void;
  show: (text: string) => void;
}) {
  const [name, setName] = useState(item.name),
    [note, setNote] = useState(item.note);
  const [attachments, setAttachments] = useState(item.attachments);
  const [preview, setPreview] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true,
      url = '';
    setName(item.name);
    setNote(item.note);
    setAttachments(item.attachments);
    setError('');
    setPreview('');
    const image = item.attachments.find((a) => a.kind === 'image' && a.bytes <= 5 * 1024 * 1024);
    if (image)
      void readAttachment(bucket, item.id, image.id)
        .then((blob) => {
          if (!active) return;
          url = URL.createObjectURL(blob);
          setPreview(url);
        })
        .catch(() => {});
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item, bucket]);
  async function save() {
    setBusy(true);
    try {
      await host('items.update', {
        id: item.id,
        revision: item.revision,
        name,
        note,
        attachments: attachments.map((a) => ({ id: a.id, source: a.source, note: a.note })),
      });
      show('说明已保存');
      updated();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="detail stack" aria-label="素材说明">
      {preview ? (
        <img className="detail-preview" src={preview} alt="素材图片预览" />
      ) : (
        <div className="file-placeholder">
          {item.attachments[0]?.kind === 'video' ? <FileVideo size={44} /> : <Image size={44} />}
        </div>
      )}
      <label className="field">
        素材名称
        <input
          value={name}
          readOnly={bucket !== 'draft'}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <small className="muted">
        {new Date(item.createdAt).toLocaleString()} · {item.attachments.length} 个附件
      </small>
      <button
        className="button"
        onClick={() =>
          void host('items.open', {
            bucket,
            id: item.id,
            ...(item.attachments.length === 1 ? { attachmentId: item.attachments[0].id } : {}),
          }).catch((failure) => setError(errorMessage(failure)))
        }
      >
        <FolderOpen />
        本地打开
      </button>
      {attachments.map((file, index) => (
        <div className="attachment-fields stack" key={file.id}>
          <b>{file.fileName}</b>
          <label className="field">
            来源
            <input
              value={file.source}
              readOnly={bucket !== 'draft'}
              onChange={(e) =>
                setAttachments((values) =>
                  values.map((a, i) => (i === index ? { ...a, source: e.target.value } : a)),
                )
              }
            />
          </label>
          <label className="field">
            附件备注
            <textarea
              rows={2}
              value={file.note}
              readOnly={bucket !== 'draft'}
              onChange={(e) =>
                setAttachments((values) =>
                  values.map((a, i) => (i === index ? { ...a, note: e.target.value } : a)),
                )
              }
            />
          </label>
        </div>
      ))}
      <label className="field">
        整组备注
        <textarea
          rows={4}
          value={note}
          readOnly={bucket !== 'draft'}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {bucket === 'draft' && (
        <button className="button primary" disabled={busy} onClick={() => void save()}>
          <Check />
          保存修改
        </button>
      )}
      {!!error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </aside>
  );
}

function Manager() {
  const [page, setPage] = useState(location.hash.slice(1) || 'draft');
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [items, setItems] = useState<Material[]>([]),
    [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState('');
  const [error, setError] = useState(''),
    [warnings, setWarnings] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false);
  const [total, setTotal] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<{ files: File[]; batch: UploadBatch | null } | null>(null);
  const show = useCallback((text: string) => setToast(text), []);
  const changed = useCallback((next: HostStatus) => setStatus(next), []);
  const bucket = (['draft', 'library', 'trash'].includes(page) ? page : 'draft') as Bucket;
  useEffect(() => {
    const hash = () => {
      setPage(location.hash.slice(1) || 'draft');
      setSelected([]);
      setActive(null);
      setError('');
    };
    const media = matchMedia('(prefers-color-scheme: dark)');
    const theme = () => {
      void preferences().then((value) => {
        document.documentElement.dataset.theme = themeName(value.theme);
      });
    };
    theme();
    window.addEventListener('hashchange', hash);
    media.addEventListener('change', theme);
    chrome.storage.onChanged.addListener(theme);
    void host<HostStatus>('ping')
      .then(setStatus)
      .catch((failure) => {
        setError(errorMessage(failure));
        location.hash = 'settings';
      });
    return () => {
      window.removeEventListener('hashchange', hash);
      media.removeEventListener('change', theme);
      chrome.storage.onChanged.removeListener(theme);
    };
  }, []);
  const refresh = useCallback(
    async (append = false) => {
      if (page === 'settings' || !status?.configured) return;
      setBusy(true);
      try {
        const result = await host<{ items: Material[]; total: number; warnings: string[] }>(
          'items.list',
          { bucket, offset: append ? items.length : 0 },
        );
        setItems((values) => (append ? [...values, ...result.items] : result.items));
        setTotal(result.total);
        setWarnings(result.warnings);
        if (!append) {
          setActive((value) =>
            result.items.some((i) => i.id === value) ? value : (result.items[0]?.id ?? null),
          );
          setSelected([]);
        }
        setError('');
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setBusy(false);
      }
    },
    [page, bucket, status?.configured, items.length],
  );
  useEffect(() => {
    setItems([]);
    setActive(null);
    void refresh();
  }, [page, status?.configured]);
  async function importFiles(files?: File[]) {
    if (files) pending.current = { files, batch: null };
    const upload = pending.current;
    if (!upload || busy) return;
    setBusy(true);
    try {
      upload.batch ??= await beginUpload(upload.files);
      await uploadFiles(upload.files, upload.batch, setToast);
      pending.current = null;
      show('已存入草稿箱');
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function transfer(operation: 'items.promote' | 'items.recycle' | 'items.restore') {
    setBusy(true);
    try {
      const results = await host<TransferResult[]>(operation, { ids: selected });
      const problems = results.filter((result) => result.status !== 'moved');
      show(`已完成 ${results.length - problems.length}/${results.length} 条`);
      await refresh();
      if (problems.length) setError(problems.map((p) => p.error).join('；'));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setConfirm(false);
    setBusy(true);
    try {
      for (const id of selected) await host('items.delete', { bucket, id, confirmed: true });
      show('已永久删除');
      await refresh();
    } catch (failure) {
      await refresh();
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const item = items.find((i) => i.id === active);
  return (
    <div className="manager-shell">
      <aside className="sidebar">
        <div className="brand">
          <Pet size={38} />
          <span>
            瞬间资产库<small>Moment Vault</small>
          </span>
        </div>
        <nav aria-label="素材位置">
          {Object.entries({
            draft: Inbox,
            library: FolderCheck,
            trash: Trash2,
            settings: Settings,
          }).map(([key, Icon]) => (
            <a key={key} href={`#${key}`} aria-current={page === key ? 'page' : undefined}>
              <Icon size={18} />
              {names[key]}
            </a>
          ))}
        </nav>
        <small className="sidebar-foot">
          灵感先留下
          <br />
          慢慢整理也没关系
        </small>
      </aside>
      <main>
        <header className="main-heading">
          <div>
            <span className="overline">MY COLLECTION</span>
            <h1>{names[page] ?? '草稿箱'}</h1>
            <p className="muted">
              {page === 'settings' ? '常用偏好自动保存，素材始终留在本地。' : descriptions[bucket]}
            </p>
          </div>
          {page !== 'settings' && (
            <div className="row">
              <button
                className="button"
                disabled={!status?.configured || busy}
                onClick={() =>
                  void host('items.open', { bucket }).catch((failure) =>
                    setError(errorMessage(failure)),
                  )
                }
              >
                <FolderOpen />
                打开目录
              </button>
              {bucket === 'draft' && (
                <button
                  className="button primary"
                  disabled={!status?.configured || busy || !!pending.current}
                  onClick={() => input.current?.click()}
                >
                  <Plus />
                  导入素材
                </button>
              )}
              <input
                ref={input}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov"
                multiple
                onChange={(e) => {
                  void importFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </header>
        {page === 'settings' ? (
          <SettingsPage initial={status} changed={changed} show={show} />
        ) : (
          <>
            {!status?.configured && (
              <div className="status">
                请先在<a href="#settings">设置</a>中连接本地助手并选择两个目录。
              </div>
            )}
            {!!error && (
              <div className="status error" role="alert">
                {error}
                {pending.current && (
                  <button className="button" disabled={busy} onClick={() => void importFiles()}>
                    重试保存
                  </button>
                )}
              </div>
            )}
            {!!warnings.length && <div className="status">{warnings.join('；')}</div>}
            {bucket === 'draft' && <RecordingRecovery changed={() => void refresh(false)} />}
            <div className="collection">
              <section className="list-panel" aria-label="素材列表">
                <div className="batch-bar">
                  <label>
                    <input
                      type="checkbox"
                      checked={items.length > 0 && selected.length === items.length}
                      disabled={!items.length || busy}
                      onChange={(e) => setSelected(e.target.checked ? items.map((i) => i.id) : [])}
                    />{' '}
                    全选{selected.length ? ` · ${selected.length}` : ''}
                  </label>
                  <div className="row">
                    {bucket === 'draft' && (
                      <>
                        <button
                          className="button primary"
                          disabled={!selected.length || busy}
                          onClick={() => void transfer('items.promote')}
                        >
                          入库
                        </button>
                        <button
                          className="button"
                          disabled={!selected.length || busy}
                          onClick={() => void transfer('items.recycle')}
                        >
                          移到回收区
                        </button>
                      </>
                    )}
                    {bucket === 'trash' && (
                      <button
                        className="button"
                        disabled={!selected.length || busy}
                        onClick={() => void transfer('items.restore')}
                      >
                        恢复
                      </button>
                    )}
                    {bucket !== 'draft' && (
                      <button
                        className="button danger"
                        disabled={!selected.length || busy}
                        onClick={() => setConfirm(true)}
                      >
                        永久删除
                      </button>
                    )}
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label="刷新列表"
                      onClick={() => void refresh()}
                    >
                      <RefreshCw />
                    </button>
                  </div>
                </div>
                {items.map((material) => (
                  <div
                    key={material.id}
                    className={`material-row ${active === material.id ? 'active' : ''}`}
                  >
                    <input
                      aria-label={`选择 ${material.name}`}
                      type="checkbox"
                      disabled={busy}
                      checked={selected.includes(material.id)}
                      onChange={(e) =>
                        setSelected((values) =>
                          e.target.checked
                            ? [...values, material.id]
                            : values.filter((id) => id !== material.id),
                        )
                      }
                    />
                    <button className="material-open" onClick={() => setActive(material.id)}>
                      <span className="type-thumb">
                        {material.attachments[0]?.kind === 'video' ? <FileVideo /> : <Image />}
                      </span>
                      <span>
                        <b>{material.name}</b>
                        <small>
                          {material.attachments.length} 个附件 ·{' '}
                          {new Date(material.createdAt).toLocaleDateString()}
                        </small>
                      </span>
                    </button>
                  </div>
                ))}
                {!items.length && (
                  <div className="empty">
                    <Inbox size={36} />
                    <h2>{busy ? '正在读取本地素材…' : '这里还没有素材'}</h2>
                    <p>收集到的内容会完整保留为本地文件。</p>
                  </div>
                )}
                <footer className="list-foot">
                  <span>
                    {items.length}/{total} 条素材
                  </span>
                  {items.length < total && (
                    <button className="button" disabled={busy} onClick={() => void refresh(true)}>
                      加载更多
                    </button>
                  )}
                </footer>
              </section>
              {item ? (
                <Detail item={item} bucket={bucket} updated={() => void refresh()} show={show} />
              ) : (
                <aside className="detail empty muted">选择一条素材，查看对应说明。</aside>
              )}
            </div>
          </>
        )}
        {!!toast && (
          <div className="toast status" role="status">
            {toast}
            <button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}>
              <X />
            </button>
          </div>
        )}
      </main>
      {confirm && (
        <div className="modal-backdrop">
          <section
            className="confirm stack"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">永久删除 {selected.length} 条素材？</h2>
            <p>删除后不可恢复，整条素材和全部附件都会删除。</p>
            <div className="row">
              <button autoFocus className="button" onClick={() => setConfirm(false)}>
                取消
              </button>
              <button className="button danger" onClick={() => void remove()}>
                永久删除
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Manager />);

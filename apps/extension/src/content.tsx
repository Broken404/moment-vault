import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { FolderOpen, ImagePlus, Settings, Video, X, Upload, RotateCcw } from 'lucide-react';
import {
  beginUpload,
  fileKind,
  openManager,
  preferences,
  setPreferences,
  uploadFiles,
  type UploadBatch,
} from './api';
import {
  DEFAULT_PREFERENCES,
  errorMessage,
  validatePreferences,
  type Preferences,
} from '@shared/model';
import { Pet, themeName } from './ui';
import { VideoMode } from './video/panel';
import { findVideoTargets, supportedSite, videoDomain, type VideoTarget } from './video/sites';
import type { CaptureHooks } from './video/capture';
import type { CaptureStatus } from './recording/types';
import sharedCss from './theme.css?inline';
import contentCss from './content.css?inline';

function App() {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState('light');
  const [menu, setMenu] = useState(false);
  const [intake, setIntake] = useState(false);
  const [context, setContext] = useState(false);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const [position, setPosition] = useState({ x: innerWidth - 90, y: innerHeight - 150 });
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [hearts, setHearts] = useState(0);
  const [videoTarget, setVideoTarget] = useState<VideoTarget | null>(null);
  const [pickingVideo, setPickingVideo] = useState(false);
  const [recording, setRecording] = useState<CaptureStatus | null>(null);
  const [closingMode, setClosingMode] = useState(false);
  const [recordShortcut, setRecordShortcut] = useState('');
  const captureHooks = useRef<CaptureHooks | null>(null);
  const recordingRef = useRef<CaptureStatus | null>(null);
  const closeModeRef = useRef<() => void>(() => {});
  const toggleVideoRef = useRef<() => void>(() => {});
  const batch = useRef<UploadBatch | null>(null);
  const filesRef = useRef<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(
    null,
  );
  const heartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = (value: Preferences) => {
      if (!alive) return;
      setPrefs(value);
      setTheme(themeName(value.theme));
      setLoaded(true);
      setPosition({
        x: Math.max(
          4,
          Math.min(
            innerWidth - value.petSize - 4,
            value.petPosition
              ? value.petPosition.x * (innerWidth - value.petSize)
              : innerWidth - value.petSize - 24,
          ),
        ),
        y: Math.max(
          4,
          Math.min(
            innerHeight - value.petSize - 4,
            value.petPosition
              ? value.petPosition.y * (innerHeight - value.petSize)
              : innerHeight - value.petSize - 84,
          ),
        ),
      });
      if (value.petHidden) {
        setMenu(false);
        setIntake(false);
      }
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.preferences) apply(validatePreferences(changes.preferences.newValue));
    };
    const update = () => {
      void preferences()
        .then(apply)
        .catch(() => {});
    };
    const fs = () => setFullscreen(!!document.fullscreenElement);
    update();
    chrome.storage.onChanged.addListener(changed);
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    document.addEventListener('fullscreenchange', fs);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(changed);
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('fullscreenchange', fs);
    };
  }, []);
  useEffect(() => {
    const listener = (
      message: { target?: string; type?: string; id?: string; status?: CaptureStatus },
      _sender: chrome.runtime.MessageSender,
      respond: (value: unknown) => void,
    ) => {
      if (message.target !== 'content') return;
      if (message.type === 'capture-state' && message.status) {
        const next = message.status,
          previous = recordingRef.current;
        if (next.phase === 'preparing') setStatus('');
        if (previous && previous.id !== next.id && next.phase !== 'preparing') return;
        recordingRef.current = next;
        setRecording(next);
        if (['saved', 'failed', 'cancelled'].includes(next.phase)) {
          captureHooks.current?.release();
          setStatus(next.message);
        }
        respond({ ok: true });
        return;
      }
      if (message.type?.startsWith('capture-')) {
        const task = (async () => {
          const hooks = captureHooks.current;
          if (!hooks) throw new Error('请先从桌宠菜单打开视频选段，选择起点和终点。');
          if (message.type === 'capture-prepare')
            return { ok: true, selection: await hooks.prepare(message.id!) };
          if (message.type === 'capture-check') {
            hooks.check(message.id!);
            return { ok: true };
          }
          if (message.type === 'capture-play') {
            await hooks.play(message.id!);
            return { ok: true };
          }
          if (message.type === 'capture-finish')
            return { ok: true, actualEnd: hooks.finish(message.id!) };
          throw new Error('未知录制请求');
        })();
        task.then(respond).catch((error) => respond({ ok: false, error: errorMessage(error) }));
        return true;
      }
      if (message.type === 'toggle-menu') setMenu((value) => !value);
      if (message.type === 'receive-images') {
        setIntake(true);
        setMenu(false);
      }
      if (message.type === 'toggle-mode') toggleVideoRef.current();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void chrome.runtime
        .sendMessage({ target: 'background', type: 'commands' })
        .then((commands) => {
          if (alive && Array.isArray(commands))
            setRecordShortcut(
              commands.find((command) => command.name === 'record-selection')?.shortcut ?? '',
            );
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      window.removeEventListener('focus', refresh);
    };
  }, [videoTarget]);
  const closeVideo = async () => {
    setClosingMode(true);
    try {
      await chrome.runtime.sendMessage({ target: 'background', type: 'capture-close' });
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setVideoTarget(null);
      setClosingMode(false);
    }
  };
  closeModeRef.current = () => {
    void closeVideo();
  };
  const openVideo = (target: VideoTarget) => {
    try {
      videoDomain(target.video);
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }
    setPickingVideo(false);
    setVideoTarget(target);
    setStatus('');
    setMenu(false);
    setIntake(false);
    setContext(false);
  };
  const toggleVideo = () => {
    if (videoTarget || pickingVideo) {
      if (videoTarget) closeModeRef.current();
      setPickingVideo(false);
      setStatus('');
      return;
    }
    if (document.fullscreenElement) {
      setStatus('请先退出全屏，再进入视频选段。');
      return;
    }
    if (!supportedSite()) {
      setStatus('目前支持 B站、YouTube 和 X 的普通视频页面。');
      return;
    }
    const targets = findVideoTargets();
    if (!targets.length) {
      setStatus('没有找到可用的视频，请先播放片刻；直播暂不支持。');
      return;
    }
    if (targets.length === 1) {
      openVideo(targets[0]);
      return;
    }
    setMenu(false);
    setPickingVideo(true);
    setStatus('请点击你要选段的视频；按 Esc 取消。');
  };
  toggleVideoRef.current = toggleVideo;
  useEffect(() => {
    if (!pickingVideo) return;
    const pick = (event: MouseEvent) => {
      const path = event.composedPath();
      const targets = findVideoTargets().filter(
        (target) => path.includes(target.player) || path.includes(target.video),
      );
      if (targets.length !== 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openVideo(targets[0]);
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickingVideo(false);
        setStatus('');
      }
    };
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', cancel, true);
    return () => {
      document.removeEventListener('click', pick, true);
      document.removeEventListener('keydown', cancel, true);
    };
  }, [pickingVideo]);
  useEffect(() => {
    if (intake) pane.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        setIntake(false);
        setContext(false);
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [intake]);
  useEffect(() => {
    const urls = files
      .filter((file) => fileKind(file) === 'image')
      .map((file) => URL.createObjectURL(file));
    setThumbs(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  useEffect(
    () => () => {
      if (heartTimer.current) clearTimeout(heartTimer.current);
    },
    [],
  );

  async function save(received?: File[]) {
    if (busy) return;
    if (received) {
      if (failed) {
        setIntake(true);
        setStatus('上次图片仍待保存，请先重试。');
        return;
      }
      if (!received.length || received.some((file) => fileKind(file) !== 'image')) {
        setStatus('请拖入图片文件，图片链接暂不能直接保存。');
        return;
      }
      filesRef.current = received;
      setFiles(received);
      batch.current = null;
      setHearts((value) => value + 1);
      if (heartTimer.current) clearTimeout(heartTimer.current);
      heartTimer.current = setTimeout(() => setHearts(0), 1900);
    }
    setBusy(true);
    setFailed(false);
    try {
      batch.current ??= await beginUpload(filesRef.current);
      const item = await uploadFiles(filesRef.current, batch.current, setStatus);
      setStatus(`已存入草稿箱 · 1 条素材，${item.attachments.length} 张图片`);
      batch.current = null;
    } catch (error) {
      setFailed(true);
      setStatus(errorMessage(error));
      setIntake(true);
    } finally {
      setBusy(false);
    }
  }
  const close = () => {
    setMenu(false);
    setIntake(false);
    setContext(false);
  };
  const towardLeft = position.x > innerWidth / 2;
  const panelStyle = {
    left: Math.max(
      4,
      Math.min(
        innerWidth - Math.min(360, innerWidth - 8) - 4,
        towardLeft ? position.x + prefs.petSize - 360 : position.x,
      ),
    ),
    ...(position.y > innerHeight / 2
      ? { bottom: Math.max(4, innerHeight - position.y + 14) }
      : { top: position.y + prefs.petSize + 14 }),
  };

  return (
    <>
      <div
        className="vault-root floating-root"
        data-theme={theme}
        hidden={
          !loaded ||
          prefs.petHidden ||
          fullscreen ||
          (!!recording && ['preparing', 'recording', 'stopping'].includes(recording.phase))
        }
      >
        <div className="pet-anchor" style={{ left: position.x, top: position.y }}>
          <button
            className="pet-button"
            style={{ opacity: prefs.petOpacity }}
            aria-label="P3-C，展开或收起菜单"
            aria-expanded={menu}
            onContextMenu={(event) => {
              event.preventDefault();
              setContext((value) => !value);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                left: position.x,
                top: position.y,
                moved: false,
              };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start) return;
              const dx = event.clientX - start.x,
                dy = event.clientY - start.y;
              if (Math.hypot(dx, dy) > 6) start.moved = true;
              if (start.moved)
                setPosition({
                  x: Math.max(4, Math.min(innerWidth - prefs.petSize - 4, start.left + dx)),
                  y: Math.max(4, Math.min(innerHeight - prefs.petSize - 4, start.top + dy)),
                });
            }}
            onPointerUp={(event) => {
              const start = drag.current;
              drag.current = null;
              if (!start) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              if (start.moved)
                void setPreferences({
                  petPosition: {
                    x: position.x / Math.max(1, innerWidth - prefs.petSize),
                    y: position.y / Math.max(1, innerHeight - prefs.petSize),
                  },
                }).catch((error) => setStatus(errorMessage(error)));
              else {
                setMenu((value) => !value);
                setIntake(false);
                setContext(false);
              }
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setMenu((value) => !value);
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(event) => {
              event.preventDefault();
              void save(Array.from(event.dataTransfer.files));
            }}
          >
            <Pet size={prefs.petSize} action={videoTarget ? 'video' : ''} />
          </button>
          {hearts > 0 && (
            <div key={hearts} className="hearts" aria-hidden="true">
              {Array.from({ length: 14 }, (_, index) => (
                <i
                  key={index}
                  style={
                    {
                      '--i': index,
                      '--x': `${((index % 7) - 3) * 17}px`,
                      '--y': `${-45 - (index % 4) * 13}px`,
                      animationDelay: `${Math.floor(index / 7) * 0.28 + (index % 7) * 0.035}s`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          )}
        </div>
        {menu && (
          <section className="pet-menu panel" style={panelStyle} aria-label="四个功能入口">
            <header>
              <strong>瞬间资产库</strong>
              <button className="icon-button" onClick={close} aria-label="关闭菜单">
                <X />
              </button>
            </header>
            <div className="menu-grid">
              <button
                disabled={!videoTarget && !supportedSite()}
                title={
                  supportedSite()
                    ? '调整视频端点并预览，使用录制快捷键开始'
                    : '支持 B站、YouTube 和 X 的视频页面'
                }
                onClick={toggleVideo}
              >
                <Video />
                <span>{videoTarget ? '退出选段' : '屏幕录制'}</span>
              </button>
              <button
                onClick={() => {
                  setMenu(false);
                  setIntake(true);
                }}
              >
                <ImagePlus />
                <span>接收截图</span>
              </button>
              <button
                onClick={() => {
                  close();
                  void openManager('draft');
                }}
              >
                <FolderOpen />
                <span>素材管理</span>
              </button>
              <button
                onClick={() => {
                  close();
                  void openManager('settings');
                }}
              >
                <Settings />
                <span>设置</span>
              </button>
            </div>
          </section>
        )}
        {context && (
          <div className="context-menu panel" style={panelStyle}>
            <button className="button" onClick={() => void setPreferences({ petHidden: true })}>
              隐藏桌宠
            </button>
          </div>
        )}
        <section
          ref={pane}
          tabIndex={-1}
          hidden={!intake}
          className="intake panel"
          style={panelStyle}
          aria-label="接收截图"
          onPaste={(event) => {
            const received = Array.from(event.clipboardData.items)
              .filter((item) => item.type.startsWith('image/'))
              .map((item) => item.getAsFile())
              .filter((file): file is File => !!file);
            if (received.length) {
              event.preventDefault();
              void save(received);
            }
          }}
        >
          <header>
            <strong>把灵感留在这里</strong>
            <button
              className="icon-button"
              onClick={() => setIntake(false)}
              aria-label="关闭接收面板"
            >
              <X />
            </button>
          </header>
          <div
            className="drop-area"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void save(Array.from(event.dataTransfer.files));
            }}
          >
            <ImagePlus size={28} />
            <b>粘贴或拖入图片</b>
            <small>一次批量输入，保存为一条素材</small>
            <button
              className="button"
              disabled={busy || failed}
              onClick={() => input.current?.click()}
            >
              <Upload />
              选择本地图片
            </button>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              onChange={(event) => {
                void save(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
          </div>
          {!!thumbs.length && (
            <div className="image-grid">
              {thumbs.map((url) => (
                <img key={url} src={url} alt="本次接收的图片" />
              ))}
            </div>
          )}
          {!!status && (
            <p className={failed ? 'status error' : 'status'} role="status">
              {status}
            </p>
          )}
          {failed && (
            <div className="row">
              <button className="button primary" disabled={busy} onClick={() => void save()}>
                <RotateCcw />
                重试保存
              </button>
              <button className="button" onClick={() => void openManager('settings')}>
                检查设置
              </button>
            </div>
          )}
        </section>
        {!intake && !!status && (
          <div className="floating-status status" role="status" style={panelStyle}>
            {status}
            <button className="icon-button" onClick={() => setStatus('')} aria-label="关闭提示">
              <X />
            </button>
          </div>
        )}
      </div>
      {videoTarget && (
        <VideoMode
          target={videoTarget}
          theme={theme}
          prefs={prefs}
          onClose={() => closeModeRef.current()}
          onError={setStatus}
          onCaptureHooks={(hooks) => {
            captureHooks.current = hooks;
          }}
          recording={recording}
          closing={closingMode}
          shortcut={recordShortcut}
          onStop={() => {
            const id = recordingRef.current?.id;
            if (id)
              void chrome.runtime.sendMessage({
                target: 'background',
                type: 'capture-ended',
                id,
                reason: 'manual-button',
              });
          }}
        />
      )}
    </>
  );
}

if (!document.getElementById('moment-vault-host')) {
  const host = document.createElement('div');
  host.id = 'moment-vault-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = sharedCss + '\n' + contentCss;
  root.append(style);
  const mount = document.createElement('div');
  root.append(mount);
  document.documentElement.append(host);
  createRoot(mount).render(<App />);
}

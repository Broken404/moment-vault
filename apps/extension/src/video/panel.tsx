import { t, numberText } from '../i18n';
import { languageSnapshot, subscribeLanguage } from '../i18n/state';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Play, Square, X, ChevronDown, RotateCcw, GripHorizontal, Minus, Plus } from 'lucide-react';
import { formatTime, moveEndpoint, parseTime, type Endpoint } from '@shared/range';
import type { Preferences } from '@shared/model';
import { VideoSession, type SelectionState, type VideoEnvironment } from './session';
import type { VideoTarget } from './sites';
import themeCss from '../theme.css?inline';
import panelCss from './panel.css?inline';
import { videoCapture, type CaptureHooks } from './capture';
import type { CaptureStatus } from '../recording/types';

export function VideoMode({
  target,
  theme,
  prefs,
  onClose,
  onError,
  environment,
  onState,
  onCaptureHooks,
  recording,
  closing = false,
  shortcut = '',
  onStop,
}: {
  target: VideoTarget;
  theme: string;
  prefs: Preferences;
  onClose: () => void;
  onError: (message: string) => void;
  environment?: VideoEnvironment;
  onState?: (state: SelectionState) => void;
  onCaptureHooks?: (hooks: CaptureHooks | null) => void;
  recording?: CaptureStatus | null;
  closing?: boolean;
  shortcut?: string;
  onStop?: () => void;
}) {
  const { locale } = useSyncExternalStore(subscribeLanguage, languageSnapshot);
  const controller = useRef<VideoSession | null>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<SelectionState | null>(null);
  const [fine, setFine] = useState(false);
  const [recordPosition, setRecordPosition] = useState<{ left: number; top: number } | null>(null);
  const hooksRef = useRef(onCaptureHooks);
  hooksRef.current = onCaptureHooks;
  const [fineWindow, setFineWindow] = useState({ start: 0, end: 20 });
  const [position, setPosition] = useState(() => {
    const rect = target.video.getBoundingClientRect();
    return {
      x: Math.max(8, Math.min(innerWidth - 346, rect.right + 12)),
      y: Math.max(10, Math.min(innerHeight - 500, rect.top)),
    };
  });
  const panel = useRef<HTMLElement>(null);
  const panelDrag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(
    null,
  );
  const endpointDrag = useRef<{ id: number; endpoint: Endpoint } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const stateRef = useRef(onState);
  stateRef.current = onState;
  const steps = useRef(prefs);
  steps.current = prefs;
  const setCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => controller.current?.setCanvas(canvas),
    [],
  );

  useEffect(() => {
    const host = document.createElement('div');
    host.dataset.momentVaultVideo = 'selection';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = themeCss + '\n' + panelCss;
    const layer = document.createElement('div');
    layer.className = 'vault-root video-layer';
    layer.popover = 'manual';
    // Player handlers must not interpret panel clicks/typing as native playback commands.
    const contain = (event: Event) => event.stopPropagation();
    for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'keydown', 'keyup'])
      layer.addEventListener(type, contain);
    root.append(style, layer);
    target.player.append(host);
    let opened: VideoSession | undefined;
    try {
      opened = new VideoSession(
        target,
        host,
        (value) => {
          setSnapshot(value);
          stateRef.current?.(value);
        },
        environment,
      );
      if (!layer.matches(':popover-open')) layer.showPopover();
    } catch (error) {
      opened?.close();
      host.remove();
      errorRef.current(error instanceof Error ? error.message : String(error));
      closeRef.current();
      return;
    }
    const session = opened;
    const capture = videoCapture(session, layer, setRecordPosition);
    hooksRef.current?.(capture);
    controller.current = session;
    setSnapshot(session.state);
    setMount(layer);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (!event.composedPath().includes(layer)) return;
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.metaKey) return;
      if (
        event
          .composedPath()
          .some(
            (node) =>
              node instanceof HTMLElement &&
              (node.matches('input,textarea,select') || node.isContentEditable),
          )
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const state = session.state,
        direction = event.key === 'ArrowRight' ? 1 : -1;
      session.move(
        state.active,
        state.selection[state.active] +
          direction * (event.ctrlKey ? steps.current.fineStep : steps.current.step),
      );
    };
    const fullscreen = () => {
      if (document.fullscreenElement) closeRef.current();
    };
    const reconnectLayer = () => {
      if (layer.isConnected && !layer.matches(':popover-open')) session.reconnect();
    };
    layer.addEventListener('toggle', reconnectLayer);
    document.addEventListener('keydown', key, true);
    document.addEventListener('fullscreenchange', fullscreen);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('fullscreenchange', fullscreen);
      layer.removeEventListener('toggle', reconnectLayer);
      hooksRef.current?.(null);
      capture.release();
      session.close();
      controller.current = null;
      host.remove();
    };
    // Target identity creates the session; preference/theme changes do not reopen it.
  }, [target]);
  useEffect(() => {
    if (mount) {
      mount.dataset.theme = theme;
      mount.lang = locale;
    }
  }, [mount, theme, locale]);
  useEffect(() => {
    if (mount) mount.style.visibility = closing ? 'hidden' : '';
  }, [mount, closing]);
  useEffect(() => {
    const bounded = () =>
      setPosition((value) => ({
        x: Math.max(4, Math.min(innerWidth - (panel.current?.offsetWidth ?? 330) - 4, value.x)),
        y: Math.max(4, Math.min(innerHeight - 64, value.y)),
      }));
    addEventListener('resize', bounded);
    return () => removeEventListener('resize', bounded);
  }, []);

  if (!mount || !snapshot) return null;
  const session = controller.current!;
  const busyRecording =
    !!recording && ['preparing', 'recording', 'stopping', 'processing'].includes(recording.phase);
  const disabled = snapshot.connection === 'changed' || busyRecording;
  const move = (endpoint: Endpoint, value: number) => session.move(endpoint, value);
  const openFine = () => {
    const at = snapshot.selection[snapshot.active],
      domain = snapshot.domain;
    const start = Math.max(domain.start, Math.min(domain.end - 20, at - 10));
    setFineWindow({ start, end: Math.min(domain.end, start + 20) });
    setFine(true);
  };
  const zoom = (scale: number, shift = 0) => {
    const domain = snapshot.domain,
      span = Math.min(
        domain.end - domain.start,
        Math.max(2, Math.min(120, (fineWindow.end - fineWindow.start) * scale)),
      );
    const center = shift
      ? (fineWindow.start + fineWindow.end) / 2 + span * shift
      : snapshot.selection[snapshot.active];
    const start = Math.max(domain.start, Math.min(domain.end - span, center - span / 2));
    setFineWindow({ start, end: start + span });
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>, endpoint: Endpoint) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    endpointDrag.current = { id: event.pointerId, endpoint };
  };
  return createPortal(
    <>
      {recordPosition && (
        <section className="recording-bar" style={recordPosition} aria-label={t('录制状态')}>
          <div>
            <b>{t(recording?.message ?? '正在准备录制…')}</b>
            <small
              title={
                recording?.phase === 'recording'
                  ? t('{0} 提前结束', [shortcut || t('录制快捷键')])
                  : t('关闭后继续完成必要保存')
              }
            >
              {recording?.phase === 'recording'
                ? t('已录 {0} · {1} 提前结束', [
                    formatTime(recording.elapsed ?? 0),
                    shortcut || t('录制快捷键'),
                  ])
                : t('关闭后继续完成必要保存')}
            </small>
          </div>
          <button className="button" onClick={onStop} disabled={recording?.phase !== 'recording'}>
            {t('结束并保存')}
          </button>
          <button className="icon-button" onClick={onClose} aria-label={t('关闭录制模式')}>
            <X />
          </button>
        </section>
      )}
      {snapshot.rail && snapshot.connection === 'connected' && (
        <div className="native-selection" style={snapshot.rail} aria-label={t('原进度条选区')}>
          <div
            className="native-highlight"
            style={{
              left: `${((snapshot.selection.a - snapshot.domain.start) / (snapshot.domain.end - snapshot.domain.start)) * 100}%`,
              width: `${((snapshot.selection.b - snapshot.selection.a) / (snapshot.domain.end - snapshot.domain.start)) * 100}%`,
            }}
          />
          {(['a', 'b'] as const).map((endpoint) => (
            <button
              key={endpoint}
              role="slider"
              className={`endpoint ${endpoint} ${snapshot.active === endpoint ? 'selected' : ''}`}
              aria-label={endpoint === 'a' ? t('起点 A') : t('终点 B')}
              aria-orientation="horizontal"
              aria-valuemin={endpoint === 'a' ? snapshot.domain.start : snapshot.selection.a}
              aria-valuemax={endpoint === 'a' ? snapshot.selection.b : snapshot.domain.end}
              aria-valuenow={snapshot.selection[endpoint]}
              aria-valuetext={formatTime(snapshot.selection[endpoint])}
              style={{
                left: `${((snapshot.selection[endpoint] - snapshot.domain.start) / (snapshot.domain.end - snapshot.domain.start)) * 100}%`,
              }}
              onFocus={() => {
                if (session.state.active !== endpoint) session.select(endpoint);
              }}
              onPointerDown={(event) => pointerDown(event, endpoint)}
              onPointerMove={(event) => {
                if (endpointDrag.current?.id === event.pointerId)
                  session.movePointer(endpoint, event.clientX);
              }}
              onPointerUp={(event) => {
                endpointDrag.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                endpointDrag.current = null;
              }}
              onLostPointerCapture={() => {
                endpointDrag.current = null;
              }}
            >
              {endpoint.toUpperCase()}
              <i />
            </button>
          ))}
        </div>
      )}
      <section
        ref={panel}
        className="video-panel"
        style={{ left: position.x, top: position.y }}
        aria-label={t('视频选段与独立预览')}
      >
        <header
          className="video-heading"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('button') || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panelDrag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: position.x,
              top: position.y,
            };
          }}
          onPointerMove={(event) => {
            const drag = panelDrag.current;
            if (!drag || drag.id !== event.pointerId) return;
            setPosition({
              x: Math.max(
                4,
                Math.min(
                  innerWidth - (panel.current?.offsetWidth ?? 330) - 4,
                  drag.left + event.clientX - drag.x,
                ),
              ),
              y: Math.max(4, Math.min(innerHeight - 64, drag.top + event.clientY - drag.y)),
            });
          }}
          onPointerUp={(event) => {
            panelDrag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            panelDrag.current = null;
          }}
        >
          <div>
            <small>
              {
                { youtube: 'YouTube', bilibili: t('B站'), x: 'X', owned: t('自制测试') }[
                  target.site
                ]
              }{' '}
              {t('· 选段')}
            </small>
            <strong>{t('留住这一段')}</strong>
          </div>
          <GripHorizontal className="grip" />
          <button className="icon-button" onClick={onClose} aria-label={t('关闭选段并恢复观看')}>
            <X />
          </button>
        </header>
        <div className="boundary-preview" aria-busy={snapshot.loading}>
          <canvas ref={setCanvas} aria-label={t('原视频边界画面')} />
          {(!snapshot.hasFrame || snapshot.loading) && (
            <div className="preview-pending">
              {snapshot.hasFrame ? t('上一预览 · ') : ''}
              {t('正在定位 {0}', [formatTime(snapshot.requested)])}
            </div>
          )}
        </div>
        <p className="preview-caption" role="status">
          {(snapshot.message && t(snapshot.message)) ||
            (snapshot.playing
              ? t(`选区试播 · ${formatTime(snapshot.actual ?? snapshot.requested)}`)
              : snapshot.loading
                ? t('等待目标画面，仍可继续调整端点')
                : t(snapshot.cached ? '画面 {0} · 已缓存' : '画面 {0}', [
                    formatTime(snapshot.actual ?? snapshot.requested),
                  ]))}
        </p>
        <div className="endpoint-cards">
          {(['a', 'b'] as const).map((endpoint) => (
            <button
              key={endpoint}
              className={snapshot.active === endpoint ? 'active' : ''}
              disabled={disabled}
              onClick={() => session.select(endpoint)}
              aria-pressed={snapshot.active === endpoint}
            >
              <small>{endpoint === 'a' ? t('起点 A') : t('终点 B')}</small>
              <strong>{formatTime(snapshot.selection[endpoint])}</strong>
            </button>
          ))}
        </div>
        <div className="selection-duration">
          {t('选区时长')}
          <b>{formatTime(snapshot.selection.b - snapshot.selection.a)}</b>
        </div>
        {snapshot.connection !== 'connected' && (
          <div className="connection-note" role="status">
            <p>{t(snapshot.connectionMessage)}</p>
            {!disabled && (
              <div className="row">
                <button className="button" onClick={() => session.reconnect()}>
                  <RotateCcw />
                  {t('重新连接')}
                </button>
                {snapshot.connection === 'unavailable' && !fine && (
                  <button className="button" onClick={openFine}>
                    {t('临时使用精调')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <button
          className="button primary preview-button"
          disabled={disabled}
          onClick={() => void session.preview()}
        >
          {snapshot.playing ? <Square /> : <Play />}
          {snapshot.playing ? t('停止预览') : t('预览选区')}
        </button>
        <button
          className="fine-toggle"
          aria-expanded={fine}
          onClick={() => (fine ? setFine(false) : openFine())}
        >
          <ChevronDown />
          {t('精细调整')}
        </button>
        {fine && (
          <div className="fine-controls">
            <div className="fine-inputs">
              {(['a', 'b'] as const).map((endpoint) => (
                <TimeInput
                  key={endpoint}
                  endpoint={endpoint}
                  value={snapshot.selection[endpoint]}
                  disabled={disabled}
                  apply={(value) => {
                    moveEndpoint(session.state.selection, endpoint, value, session.state.domain);
                    return move(endpoint, value);
                  }}
                />
              ))}
            </div>
            <label>
              {snapshot.active === 'a' ? t('调整起点 A') : t('调整终点 B')}
              <input
                type="range"
                aria-label={t('局部精调端点')}
                min={fineWindow.start}
                max={fineWindow.end}
                step="0.001"
                value={Math.max(
                  fineWindow.start,
                  Math.min(fineWindow.end, snapshot.selection[snapshot.active]),
                )}
                disabled={disabled}
                onChange={(event) => move(snapshot.active, Number(event.target.value))}
              />
            </label>
            <small>
              {formatTime(fineWindow.start)} — {formatTime(fineWindow.end)}
            </small>
            <div className="row fine-tools">
              <button
                className="button"
                onClick={() => zoom(1, -0.5)}
                aria-label={t('向前平移精调范围')}
              >
                ←
              </button>
              <button className="button" onClick={() => zoom(0.5)} aria-label={t('缩小精调范围')}>
                <Minus />
              </button>
              <button className="button" onClick={() => zoom(2)} aria-label={t('扩大精调范围')}>
                <Plus />
              </button>
              <button
                className="button"
                onClick={() => zoom(1, 0.5)}
                aria-label={t('向后平移精调范围')}
              >
                →
              </button>
            </div>
          </div>
        )}
        <footer>
          <span>
            {t('← → {0} 秒 · Ctrl + ← → {1} 秒', [
              numberText(prefs.step),
              numberText(prefs.fineStep),
            ])}
          </span>
          <span>{t('选段与预览不会保存素材')}</span>
          <span data-record-shortcut>
            {shortcut
              ? t(`按 ${shortcut} 开始／提前结束录制`)
              : t('录制快捷键尚未绑定，请在设置中配置')}
          </span>
        </footer>
      </section>
    </>,
    mount,
  );
}

function TimeInput({
  endpoint,
  value,
  apply,
  disabled,
}: {
  endpoint: Endpoint;
  value: number;
  apply: (time: number) => number | undefined;
  disabled: boolean;
}) {
  const [text, setText] = useState(formatTime(value));
  const [error, setError] = useState('');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(formatTime(value));
  }, [value]);
  const save = () => {
    try {
      const applied = apply(parseTime(text));
      if (applied !== undefined) setText(formatTime(applied));
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '请输入秒数或 时:分:秒.毫秒');
    }
  };
  return (
    <label>
      {endpoint === 'a' ? t('起点 A') : t('终点 B')}
      <input
        aria-label={endpoint === 'a' ? t('精确起点时间') : t('精确终点时间')}
        value={text}
        disabled={disabled}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          focused.current = false;
          save();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {error && <small className="error">{t(error)}</small>}
    </label>
  );
}

// Owned fixture only. This entry is built separately and is never included in the extension.
import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { VideoMode } from './panel';
import { findVideoTargets, type Site, type VideoTarget } from './sites';
import type { SelectionState, VideoEnvironment } from './session';
import { DEFAULT_PREFERENCES } from '@shared/model';
import type { CaptureHooks } from './capture';
import type { CaptureStatus } from '../recording/types';
import { Pet } from '../ui';
import themeCss from '../theme.css?inline';

function Lab() {
  const [site, setSite] = useState<Site>('youtube'),
    [theme, setTheme] = useState('light');
  const [target, setTarget] = useState<VideoTarget | null>(null);
  const [snapshot, setSnapshot] = useState<SelectionState | null>(null);
  const [error, setError] = useState(''),
    [time, setTime] = useState(0),
    [duration, setDuration] = useState(0);
  const [controls, setControls] = useState(true),
    [railEpoch, setRailEpoch] = useState(0),
    [playerEpoch, setPlayerEpoch] = useState(0);
  const [source, setSource] = useState(1);
  const capture = useRef<CaptureHooks | null>(null);
  const [recording, setRecording] = useState<CaptureStatus | null>(null);
  const [layoutResult, setLayoutResult] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const url =
    site === 'youtube'
      ? `https://www.youtube.com/watch?v=owned-${source}`
      : site === 'bilibili'
        ? `https://www.bilibili.com/video/BVowned${source}/`
        : `https://x.com/owner/status/${source}`;
  const currentUrl = useRef(url);
  currentUrl.current = url;
  const environment = useRef<VideoEnvironment>({
    url: () => currentUrl.current,
    targets: () => findVideoTargets(document, currentUrl.current),
  }).current;
  const enter = () => {
    const targets = environment.targets();
    if (targets.length !== 1) {
      setError('自制素材尚未就绪');
      return;
    }
    setError('');
    setTarget(targets[0]);
  };
  const close = () => {
    capture.current?.release();
    setRecording(null);
    setTarget(null);
  };
  const rail = (
    <div
      key={railEpoch}
      className={
        site === 'youtube'
          ? 'ytp-progress-bar-container'
          : site === 'bilibili'
            ? 'bpx-player-progress-area'
            : 'fixture-controls'
      }
    >
      <div
        className={`fixture-rail ${site === 'youtube' ? 'ytp-progress-bar' : site === 'bilibili' ? 'bpx-player-progress' : ''}`}
        role={site === 'x' ? 'group' : undefined}
        aria-label={site === 'x' ? '视频进度' : undefined}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (video.current && duration)
            video.current.currentTime = ((event.clientX - bounds.left) / bounds.width) * duration;
        }}
      >
        <div
          className="fixture-progress"
          style={{ width: `${duration ? (time / duration) * 100 : 0}%` }}
        />
        <div
          className="fixture-thumb"
          style={{ left: `${duration ? (time / duration) * 100 : 0}%` }}
          role={site === 'x' ? 'slider' : undefined}
          aria-label={site === 'x' ? '进度拖动条' : undefined}
          aria-valuenow={time}
          aria-valuemin={0}
          aria-valuemax={duration}
        />
      </div>
    </div>
  );
  return (
    <div
      className={`vault-root fixture-page${new URLSearchParams(location.search).has('reported-layout') ? ' reported-layout' : ''}`}
      data-theme={theme}
    >
      <style>
        {themeCss +
          `
      body{margin:0;background:#eeeae0} .fixture-page{min-height:100vh;padding:30px;color:var(--ink);background:var(--bg);font-family:system-ui,sans-serif}
      .fixture-page h1{font-size:23px;margin:0 0 7px}.fixture-page .intro{font-size:13px;color:var(--muted);margin:0 0 20px}
      .fixture-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.fixture-toolbar .button{font-size:12px}
      .fixture-layout{display:grid;grid-template-columns:minmax(450px,780px) 330px;gap:28px;align-items:start}
      .fixture-player{position:relative;overflow:hidden;transform:translateZ(0);background:#20242b;border-radius:9px;aspect-ratio:16/9}
      .fixture-player video{display:block;width:100%;height:100%;object-fit:contain}
      .fixture-rail{position:absolute;bottom:24px;left:18px;right:18px;height:8px;background:#ffffff66;cursor:pointer}
      .fixture-progress{height:100%;background:#f0be55;pointer-events:none}.fixture-thumb{position:absolute;top:-4px;width:16px;height:16px;background:#fff;border-radius:50%;transform:translateX(-50%);pointer-events:none}
      .fixture-native{display:flex;gap:8px;align-items:center;padding:10px 0}.fixture-native span{font-size:12px;font-variant-numeric:tabular-nums}
      .fixture-proof{padding:15px;border:1px solid var(--line);background:var(--paper)}.fixture-proof h2{font-size:14px;margin:0 0 12px}
      .fixture-proof pre{font-size:11px;line-height:1.7;white-space:pre-wrap}.fixture-note{font-size:12px;color:var(--muted);max-width:780px;line-height:1.8}
      .fixture-pet{display:flex;align-items:center;gap:12px;margin:20px 0 4px}.fixture-pet span+span{font-size:12px}
      .reported-layout .fixture-player{position:fixed;left:162px;top:68px;width:885px;height:calc(100vh - 116px);aspect-ratio:auto}
      .reported-layout .fixture-toolbar{margin-left:1060px;width:500px}.reported-layout .fixture-pet{position:fixed;right:30px;bottom:10px}
      .reported-layout [data-layout-check]{position:fixed;right:30px;bottom:70px}.reported-layout [data-layout-end]{position:fixed;right:220px;bottom:70px}
      @media(max-width:1000px){.fixture-layout{grid-template-columns:1fr}.fixture-proof{max-width:780px}}
    `}
      </style>
      <h1>视频选段 · 自制素材联调</h1>
      <p className="intro">
        使用正式选段与预览代码；下方播放器和三种进度条均为自制夹具，不代表三站验收通过。
      </p>
      <div className="fixture-toolbar">
        <button
          className="button"
          onClick={() => {
            const player = video.current?.parentElement,
              parent = player?.parentElement;
            if (!player || !parent) return;
            const marker = document.createComment('owned synchronous reparent fixture');
            parent.insertBefore(marker, player);
            player.remove();
            parent.insertBefore(player, marker);
            marker.remove();
          }}
        >
          移动现有播放器
        </button>
        {(['youtube', 'bilibili', 'x'] as const).map((value) => (
          <button
            className="button"
            key={value}
            onClick={() => {
              close();
              setSite(value);
              setSnapshot(null);
            }}
            aria-pressed={site === value}
          >
            {value} 结构
          </button>
        ))}
        <button
          className="button"
          onClick={() => setTheme((value) => (value === 'light' ? 'dark' : 'light'))}
        >
          切换明暗
        </button>
        <button className="button" onClick={() => setControls((value) => !value)}>
          {controls ? '移除进度条' : '恢复进度条'}
        </button>
        <button className="button" onClick={() => setRailEpoch((value) => value + 1)}>
          重建进度条
        </button>
        <button className="button" onClick={() => setPlayerEpoch((value) => value + 1)}>
          重建同源播放器
        </button>
        <button className="button" onClick={() => setSource((value) => value + 1)}>
          切换视频来源
        </button>
        <button
          className="button"
          data-layout-check
          disabled={!target || site !== 'youtube'}
          onClick={() => {
            setRecording({
              id: 'owned-layout',
              phase: 'preparing',
              name: '自制布局检查',
              message: '正在准备录制…',
            });
            void capture.current
              ?.prepare('owned-layout')
              .then(() => {
                const bar = target?.player
                  .querySelector('[data-moment-vault-video]')
                  ?.shadowRoot?.querySelector('.recording-bar')
                  ?.getBoundingClientRect();
                setLayoutResult('布局检查通过：' + JSON.stringify(bar?.toJSON()));
              })
              .catch((failure) => setLayoutResult(String(failure)));
          }}
        >
          检查录制准备布局
        </button>
        <button
          className="button"
          data-layout-end
          onClick={() => {
            capture.current?.release();
            setRecording(null);
          }}
        >
          结束布局检查
        </button>
      </div>
      <div className="fixture-layout">
        <div>
          <div
            key={playerEpoch}
            id={site === 'youtube' ? 'movie_player' : undefined}
            className={`fixture-player ${site === 'bilibili' ? 'bpx-player-container' : ''}`}
            data-testid={site === 'x' ? 'videoPlayer' : undefined}
          >
            <video
              ref={video}
              src={`/fixture.mp4?source=${source}`}
              preload="auto"
              playsInline
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
              onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            />
            {controls && rail}
          </div>
          <div className="fixture-native">
            <button
              className="button"
              onClick={() => {
                if (video.current?.paused) void video.current.play();
                else video.current?.pause();
              }}
            >
              原视频播放／暂停
            </button>
            <span>
              原视频 {time.toFixed(3)} / {duration.toFixed(3)} 秒
            </span>
            <button
              className="button"
              onClick={() => {
                if (video.current) video.current.currentTime = 2;
              }}
            >
              观看位置设为 2 秒
            </button>
          </div>
          <div className="fixture-pet">
            <Pet size={56} action={target ? 'video' : ''} />
            <button className="button primary" onClick={() => (target ? close() : enter())}>
              {target ? '退出选段' : '进入选段'}
            </button>
          </div>
          <p className="fixture-note">
            A、B
            直接放在原进度条上。独立窗口复用这个视频取帧，显示画面内时间码；关闭后恢复原观看位置。实际录制仍未开放。可用上方按钮验证进度条重建、来源切换和显式备用精调。
          </p>
          <p className="fixture-note">
            录制布局检查只准备控件，不捕获标签页或保存文件；使用 ?v=owned-1 让自制 YouTube
            身份一致，reported-layout 参数重现本次播放器边界。
          </p>
          {error && <p role="alert">{error}</p>}
          <p data-testid="recording-layout-result">{layoutResult}</p>
        </div>
        <aside className="fixture-proof">
          <h2>联调读数</h2>
          <pre data-testid="diagnostics">
            {JSON.stringify(
              target && snapshot
                ? {
                    structure: site,
                    connection: snapshot.connection,
                    a: snapshot.selection.a,
                    b: snapshot.selection.b,
                    requested: snapshot.requested,
                    actual: snapshot.actual,
                    loading: snapshot.loading,
                    playing: snapshot.playing,
                    cached: snapshot.cached,
                    cacheBytes: snapshot.cacheBytes,
                    cacheEntries: snapshot.cacheEntries,
                    message: snapshot.message,
                  }
                : { structure: site, mode: 'closed' },
              null,
              2,
            )}
          </pre>
        </aside>
      </div>
      {target && (
        <VideoMode
          target={target}
          theme={theme}
          prefs={DEFAULT_PREFERENCES}
          onClose={close}
          onError={setError}
          environment={environment}
          onState={setSnapshot}
          onCaptureHooks={(hooks) => {
            capture.current = hooks;
          }}
          recording={recording}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('lab')!).render(<Lab />);

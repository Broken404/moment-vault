import {
  initialSelection,
  timeAtPointer,
  type Endpoint,
  type Selection,
  type TimeDomain,
} from '@shared/range';
import {
  FrameCache,
  LatestPreview,
  copyFrame,
  seekFrame,
  watchLease,
  type Frame,
  type Watching,
} from './preview';
import {
  findRail,
  findVideoTargets,
  keepControls,
  railRect,
  sourceKey,
  videoDomain,
  type RailRect,
  type VideoTarget,
} from './sites';

export interface SelectionState {
  selection: Selection;
  domain: TimeDomain;
  active: Endpoint;
  connection: 'connecting' | 'connected' | 'unavailable' | 'changed';
  rail: RailRect | null;
  connectionMessage: string;
  message: string;
  loading: boolean;
  playing: boolean;
  requested: number;
  actual: number | null;
  hasFrame: boolean;
  cached: boolean;
  cacheBytes: number;
  cacheEntries: number;
}
const selections = new Map<string, Selection>();
const frameKey = (time: number) => time.toFixed(3);
export interface VideoEnvironment {
  url: () => string;
  targets: () => VideoTarget[];
}

export class VideoSession {
  state: SelectionState;
  private closed = false;
  private captureLocked = false;
  private cache = new FrameCache();
  private queue!: LatestPreview<{ frame: Frame; cached: boolean }>;
  private lease!: ReturnType<typeof watchLease>;
  private original!: Watching;
  private visible?: HTMLCanvasElement;
  private nativeCleanup = () => {};
  private mediaCleanup = () => {};
  private resize = new ResizeObserver(() => this.schedule());
  private changes = new MutationObserver(() => this.schedule());
  private documentChanges = new MutationObserver(() => {
    if (
      !this.target.player.isConnected ||
      !this.target.video.isConnected ||
      !this.sameSource() ||
      !this.host.shadowRoot?.querySelector('[popover]')?.matches(':popover-open')
    )
      this.schedule();
  });
  private layoutFrame = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private signature = '';
  private playbackGeneration = 0;
  private playbackFrame?: number;
  private lastCaption = 0;

  constructor(
    public target: VideoTarget,
    private host: HTMLElement,
    private changed: (value: SelectionState) => void,
    private environment: VideoEnvironment = {
      url: () => location.href,
      targets: () => findVideoTargets(),
    },
  ) {
    const domain = videoDomain(target.video);
    const saved = selections.get(target.key);
    const selection =
      saved && saved.a >= domain.start && saved.b <= domain.end && saved.a < saved.b
        ? saved
        : initialSelection(target.video.currentTime, domain);
    this.state = {
      selection,
      domain,
      active: 'a',
      rail: null,
      connection: 'connecting',
      connectionMessage: '正在连接原进度条…',
      message: '',
      loading: true,
      playing: false,
      requested: selection.a,
      actual: null,
      hasFrame: false,
      cached: false,
      cacheBytes: 0,
      cacheEntries: 0,
    };
    this.attach(target);
    this.documentChanges.observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('scroll', this.schedule, true);
    addEventListener('resize', this.schedule);
    document.addEventListener('visibilitychange', this.visibility);
    document.addEventListener('loadedmetadata', this.schedule, true);
    try {
      this.refresh();
      void this.request(selection.a);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private sameSource(target = this.target) {
    return (
      target.video.isConnected &&
      !target.player.matches('.ad-showing, .ytp-live') &&
      sourceKey(target.video, target.site, this.environment.url()) === target.key
    );
  }
  private frameSignature() {
    const v = this.target.video;
    return `${v.currentSrc}:${v.videoWidth}:${v.videoHeight}`;
  }
  private attach(target: VideoTarget, inherited?: Watching) {
    this.target = target;
    target.player.append(this.host);
    if (inherited) {
      const layer = this.host.shadowRoot?.querySelector<HTMLElement>('[popover]');
      if (layer && !layer.matches(':popover-open')) layer.showPopover();
    }
    this.nativeCleanup = keepControls(target);
    const sourceValid = () => this.sameSource(target);
    this.lease = watchLease(target.video, target.key, sourceValid, inherited);
    this.original = this.lease.original;
    this.signature = this.frameSignature();
    this.queue = new LatestPreview(
      async (time, signal) => {
        const cached = this.cache.get(frameKey(time));
        if (cached) return { frame: cached, cached: true };
        const signature = this.frameSignature();
        const frame = await seekFrame(
          target.video,
          time,
          signal,
          () => !this.closed && sourceValid() && this.frameSignature() === signature,
        );
        return { frame, cached: false };
      },
      ({ frame, cached }) => {
        if (!cached) this.cache.set(frameKey(frame.target), frame);
        this.paint(frame.canvas);
        this.state = {
          ...this.state,
          loading: false,
          actual: frame.actual,
          hasFrame: true,
          cached,
          message: '',
        };
        this.publish();
      },
      (message) => {
        this.state.loading = false;
        this.state.message = message;
        this.publish();
      },
      ({ frame, cached }) => {
        if (!cached) frame.canvas.width = frame.canvas.height = 0;
      },
    );
    const metadata = () => {
      if (!sourceValid()) {
        this.schedule();
        return;
      }
      if (this.frameSignature() !== this.signature) {
        this.queue.cancel();
        this.cache.clear();
        this.signature = this.frameSignature();
        this.state.loading = true;
        this.state.message = '画面已更新，正在重新定位…';
        void this.request(this.state.selection[this.state.active]);
      }
      this.schedule();
    };
    const paused = () => {
      if (this.state.playing) this.stopPreview();
    };
    const ended = () => {
      if (this.state.playing && target.video.currentTime >= this.state.selection.b)
        this.finishPreview();
    };
    target.video.addEventListener('loadedmetadata', metadata);
    target.video.addEventListener('resize', metadata);
    target.video.addEventListener('pause', paused);
    target.video.addEventListener('timeupdate', ended);
    target.player.addEventListener('pointerenter', this.reconnect);
    this.mediaCleanup = () => {
      target.video.removeEventListener('loadedmetadata', metadata);
      target.video.removeEventListener('resize', metadata);
      target.video.removeEventListener('pause', paused);
      target.video.removeEventListener('timeupdate', ended);
      target.player.removeEventListener('pointerenter', this.reconnect);
    };
    this.resize.observe(target.player);
    this.resize.observe(target.video);
    this.changes.observe(target.player, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
  private publish() {
    if (this.closed) return;
    this.cache.pin([frameKey(this.state.selection.a), frameKey(this.state.selection.b)]);
    this.state = {
      ...this.state,
      selection: { ...this.state.selection },
      cacheBytes: this.cache.bytes,
      cacheEntries: this.cache.size,
    };
    this.changed(this.state);
  }
  readonly schedule = () => {
    if (this.closed || this.layoutFrame) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      this.refresh();
    });
  };
  readonly reconnect = () => {
    this.attempts = 0;
    this.schedule();
  };
  private refresh() {
    if (this.closed) return;
    if (this.captureLocked) return;
    if (
      !this.target.player.isConnected ||
      !this.target.video.isConnected ||
      !this.target.player.contains(this.target.video)
    ) {
      const candidates = this.environment
        .targets()
        .filter((target) => target.key === this.target.key);
      if (candidates.length === 1) {
        const original = this.original;
        this.stopPlayback(false);
        this.target.video.pause();
        this.queue.close();
        this.cache.clear();
        this.lease.release(false);
        this.resize.disconnect();
        this.changes.disconnect();
        this.nativeCleanup();
        this.mediaCleanup();
        this.attach(candidates[0], original);
        this.attempts = 0;
        void this.request(this.state.selection[this.state.active]);
      } else {
        // Keep the close/reconnect controls available while the native player is absent.
        if (!this.host.isConnected) document.documentElement.append(this.host);
        this.openLayer();
        this.missingRail('播放器正在重建，请稍候或重新连接。');
        return;
      }
    }
    if (this.host.parentElement !== this.target.player) this.target.player.append(this.host);
    this.openLayer();
    if (!this.sameSource()) {
      this.stopPlayback(false);
      this.queue.cancel();
      this.cache.clear();
      this.state.connection = 'changed';
      this.state.rail = null;
      this.state.loading = false;
      this.state.connectionMessage = '视频来源已改变，请关闭后重新选择；不会把旧位置写入新视频。';
      this.publish();
      return;
    }
    try {
      const domain = videoDomain(this.target.video);
      if (this.state.selection.a < domain.start || this.state.selection.b > domain.end) {
        this.state.connection = 'unavailable';
        this.state.rail = null;
        this.state.connectionMessage = '可回看范围已改变，请重新进入选段。';
        this.publish();
        return;
      }
      this.state.domain = domain;
    } catch (error) {
      this.missingRail(error instanceof Error ? error.message : String(error));
      return;
    }
    const rail = findRail(this.target);
    if (rail) {
      const rect = railRect(rail);
      const before = this.state.rail;
      if (
        this.state.connection !== 'connected' ||
        !before ||
        ['left', 'top', 'width', 'height'].some(
          (k) => before[k as keyof RailRect] !== rect[k as keyof RailRect],
        )
      ) {
        this.state.connection = 'connected';
        this.state.rail = rect;
        this.state.connectionMessage = '';
        this.publish();
      }
      this.attempts = 0;
    } else this.missingRail('原进度条暂不可连接，可重试；必要时由你选择临时精调。');
  }
  private openLayer() {
    const layer = this.host.shadowRoot?.querySelector<HTMLElement>('[popover]');
    if (layer?.isConnected && !layer.matches(':popover-open')) layer.showPopover();
  }
  private missingRail(message: string) {
    this.state.rail = null;
    this.state.connection = this.attempts < 12 ? 'connecting' : 'unavailable';
    this.state.connectionMessage =
      this.state.connection === 'connecting' ? '正在连接原进度条…' : message;
    if (this.attempts++ < 12) {
      clearTimeout(this.retry);
      this.retry = setTimeout(this.schedule, 160);
    }
    this.publish();
  }
  setCanvas(canvas: HTMLCanvasElement | null) {
    this.visible = canvas ?? undefined;
    const current = this.cache.get(frameKey(this.state.requested));
    if (canvas && current) this.paint(current.canvas);
  }
  private paint(source: CanvasImageSource & { width?: number; height?: number }) {
    if (!this.visible) return;
    const width = 'videoWidth' in source ? Number(source.videoWidth) : Number(source.width);
    const height = 'videoHeight' in source ? Number(source.videoHeight) : Number(source.height);
    const scale = Math.min(1, 640 / width, 360 / height);
    const w = Math.max(1, Math.round(width * scale)),
      h = Math.max(1, Math.round(height * scale));
    if (this.visible.width !== w || this.visible.height !== h) {
      this.visible.width = w;
      this.visible.height = h;
    }
    this.visible.getContext('2d')?.drawImage(source, 0, 0, w, h);
  }
  select(endpoint: Endpoint) {
    if (this.closed || this.captureLocked || !this.sameSource()) return;
    this.stopPlayback();
    this.state.active = endpoint;
    void this.request(this.state.selection[endpoint]);
  }
  move(endpoint: Endpoint, time: number) {
    if (
      this.closed ||
      this.captureLocked ||
      this.state.connection === 'changed' ||
      !this.sameSource()
    )
      return;
    const { selection, domain } = this.state;
    const minimum = endpoint === 'a' ? domain.start : selection.a + 0.001;
    const maximum = endpoint === 'a' ? selection.b - 0.001 : domain.end;
    const value = Math.max(minimum, Math.min(maximum, Math.round(time * 1000) / 1000));
    this.stopPlayback();
    this.state.active = endpoint;
    this.state.selection = { ...selection, [endpoint]: value };
    void this.request(value);
    return value;
  }
  movePointer(endpoint: Endpoint, x: number) {
    const rail = this.state.rail;
    if (!rail || this.state.connection !== 'connected') return;
    this.move(endpoint, timeAtPointer(x, rail.left, rail.width, this.state.domain));
  }
  async request(time: number, force = false) {
    if (this.closed || !this.sameSource()) return;
    if (this.frameSignature() !== this.signature) {
      this.queue.cancel();
      this.cache.clear();
      this.signature = this.frameSignature();
    }
    // Capture/preview must seek A again, but the already confirmed B frame is still valid.
    // Keeping other frames lets capture release restore the preview without another paused seek.
    if (force) this.cache.delete(frameKey(time));
    this.state.requested = time;
    this.state.loading = true;
    this.state.message = '';
    this.state.cached = false;
    this.publish();
    return this.queue.request(time);
  }
  buffered(time: number) {
    const ranges = this.target.video.buffered;
    for (let i = 0; i < ranges.length; i++)
      if (time >= ranges.start(i) && time <= ranges.end(i)) return true;
    return false;
  }
  async preview() {
    if (this.captureLocked) return;
    if (this.state.playing) {
      this.stopPreview();
      return;
    }
    this.stopPlayback();
    const generation = ++this.playbackGeneration;
    const result = await this.request(this.state.selection.a, true);
    if (!result || this.closed || generation !== this.playbackGeneration || !this.sameSource())
      return;
    this.state.playing = true;
    this.state.loading = false;
    this.publish();
    const video = this.target.video;
    const draw: VideoFrameRequestCallback = (now, metadata) => {
      if (this.closed || generation !== this.playbackGeneration || !this.sameSource()) return;
      this.paint(video);
      if (metadata.mediaTime >= this.state.selection.b - 0.005) {
        this.finishPreview();
        return;
      }
      if (now - this.lastCaption > 100) {
        this.lastCaption = now;
        this.state.actual = metadata.mediaTime;
        this.publish();
      }
      this.playbackFrame = video.requestVideoFrameCallback(draw);
    };
    this.playbackFrame = video.requestVideoFrameCallback(draw);
    try {
      await video.play();
    } catch {
      if (this.closed || generation !== this.playbackGeneration || !this.sameSource()) return;
      this.stopPlayback();
      this.state.message = '视频未能播放，请重试。';
      this.publish();
    }
  }
  private finishPreview() {
    this.stopPlayback();
    void this.request(this.state.selection.b);
  }
  private stopPlayback(pause = true) {
    this.playbackGeneration++;
    this.state.playing = false;
    if (this.playbackFrame !== undefined)
      this.target.video.cancelVideoFrameCallback(this.playbackFrame);
    this.playbackFrame = undefined;
    if (pause && this.sameSource()) this.target.video.pause();
  }
  stopPreview() {
    if (this.closed) return;
    this.stopPlayback();
    if (this.sameSource() && this.target.video.readyState >= 2 && !this.target.video.seeking) {
      const frame = copyFrame(this.target.video);
      this.paint(frame.canvas);
      this.state.actual = frame.actual;
      this.state.requested = frame.target;
      this.state.hasFrame = true;
      this.state.cached = false;
      this.state.message = '';
      frame.canvas.width = frame.canvas.height = 0;
    } else if (this.sameSource()) {
      void this.request(this.state.selection[this.state.active]);
      return;
    }
    this.state.loading = false;
    this.publish();
  }
  private visibility = () => {
    if (document.hidden && this.state.playing) this.stopPreview();
  };
  validSource() {
    return !this.closed && this.sameSource();
  }
  async prepareCapture() {
    if (this.captureLocked || !this.validSource()) throw new Error('当前视频不可录制。');
    this.captureLocked = true;
    this.stopPlayback();
    this.queue.cancel();
    const result = await this.request(this.state.selection.a, true);
    if (!result || !this.validSource()) throw new Error('起点画面尚未就绪，未开始录制。');
    return this.target.video.currentTime;
  }
  releaseCapture() {
    if (this.closed) return;
    this.captureLocked = false;
    this.schedule();
    if (this.sameSource()) void this.request(this.state.selection[this.state.active]);
  }
  close() {
    if (this.closed) return;
    selections.set(this.target.key, { ...this.state.selection });
    if (selections.size > 20) selections.delete(selections.keys().next().value!);
    this.stopPlayback();
    this.closed = true;
    this.queue.close();
    this.cache.clear();
    cancelAnimationFrame(this.layoutFrame);
    clearTimeout(this.retry);
    this.resize.disconnect();
    this.changes.disconnect();
    this.documentChanges.disconnect();
    removeEventListener('scroll', this.schedule, true);
    removeEventListener('resize', this.schedule);
    document.removeEventListener('visibilitychange', this.visibility);
    document.removeEventListener('loadedmetadata', this.schedule, true);
    this.mediaCleanup();
    this.nativeCleanup();
    this.lease.release(true);
  }
}

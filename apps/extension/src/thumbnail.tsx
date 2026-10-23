import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { FileVideo, Image } from 'lucide-react';
import type { Bucket, Material } from '@shared/model';
import { thumbnails } from './thumbnails';

export function Thumbnail({
  scope,
  bucket,
  item,
  refresh,
}: {
  scope: string;
  bucket: Bucket;
  item: Material;
  refresh: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '160px',
    });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!visible) return;
    const controller = new AbortController();
    void thumbnails
      .load(scope, bucket, item, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setUrl(value);
        setFailed(!value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [scope, bucket, item, visible, refresh]);
  const video = item.attachments[0]?.kind === 'video';
  return (
    <span
      ref={ref}
      className={`type-thumb ${visible && !url && !failed ? 'thumb-pending' : ''}`}
      title={failed ? t('暂时无法预览，可用本地打开查看') : undefined}
      aria-hidden="true"
    >
      {url ? (
        <img
          src={url}
          alt=""
          decoding="async"
          draggable={false}
          onError={() => {
            setUrl(null);
            setFailed(true);
          }}
        />
      ) : video ? (
        <FileVideo />
      ) : (
        <Image />
      )}
      {url && video && (
        <span className="thumb-video">
          <FileVideo />
        </span>
      )}
      {item.attachments.length > 1 && (
        <span className="thumb-count">{item.attachments.length}</span>
      )}
    </span>
  );
}

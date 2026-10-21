"""Check timestamps and picture changes of a short, moving self-made fixture.

This catches the retained 0.0.4 short-capture failure. It does not interpret
legitimately static platform footage as a broken recording, or claim a fix.
"""
import argparse
import json
from pathlib import Path
import subprocess


def picture_changes(media: Path, timestamps: list[float]) -> dict:
    # Small grayscale frames keep this check independent of codec and resolution.
    # Compare against the last changed picture so slow movement can accumulate.
    pixels = 96 * 54
    decoded = subprocess.run([
        'ffmpeg', '-v', 'error', '-i', str(media), '-map', '0:v:0',
        '-vf', 'scale=96:54,format=gray', '-fps_mode', 'passthrough',
        '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], capture_output=True, check=True).stdout
    if len(decoded) != len(timestamps) * pixels:
        return {'pictureCheckOk': False, 'reason': 'decoded picture and timestamp counts differ'}
    reference = decoded[:pixels]
    last_change = timestamps[0]
    unchanged = 0
    threshold = 0.5
    for index, timestamp in enumerate(timestamps[1:], 1):
        frame = decoded[index * pixels:(index + 1) * pixels]
        difference = sum(abs(a - b) for a, b in zip(frame, reference)) / pixels
        if difference >= threshold:
            reference, last_change = frame, timestamp
        else:
            unchanged = max(unchanged, timestamp - last_change)
    return {
        'pictureCheckOk': True,
        'maximumUnchangedPictureSeconds': round(unchanged, 6),
        'pictureChangeThresholdGrayLevels': threshold,
    }


def check(media: Path, tolerance: float = 0.25) -> dict:
    result = subprocess.run([
        'ffprobe', '-v', 'error', '-show_frames', '-show_entries',
        'frame=media_type,best_effort_timestamp_time,pkt_duration_time,nb_samples,sample_rate',
        '-of', 'json', str(media),
    ], capture_output=True, text=True, encoding='utf-8', check=True)
    frames = json.loads(result.stdout)['frames']
    video = [float(f['best_effort_timestamp_time']) for f in frames
             if f['media_type'] == 'video' and 'best_effort_timestamp_time' in f]
    audio = [float(f['best_effort_timestamp_time']) for f in frames
             if f['media_type'] == 'audio' and 'best_effort_timestamp_time' in f]
    if not video:
        return {'ok': False, 'reason': 'no decoded video frames'}
    gaps = [b - a for a, b in zip(video, video[1:])]
    # Last audio timestamp is a conservative lower bound on media end, not an
    # inferred video boundary. A long audio-only tail catches the known failure.
    tail = max(0, max(audio, default=video[-1]) - video[-1])
    maximum_gap = max(gaps, default=0)
    pictures = picture_changes(media, video)
    pictures_ok = pictures['pictureCheckOk'] and pictures['maximumUnchangedPictureSeconds'] <= tolerance
    return {
        'ok': len(video) > 1 and tail <= tolerance and maximum_gap <= tolerance and pictures_ok,
        'scope': 'timestamps and picture changes of short, explicitly moving self-made fixture',
        'videoFrames': len(video), 'firstVideoTime': video[0],
        'lastVideoTime': video[-1], 'lastAudioTime': max(audio, default=None),
        'audioOnlyTailSeconds': round(tail, 6),
        'maximumVideoGapSeconds': round(maximum_gap, 6),
        'toleranceSeconds': tolerance,
        **pictures,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('media', type=Path)
    parser.add_argument('--tolerance', type=float, default=0.25)
    args = parser.parse_args()
    if args.tolerance <= 0:
        parser.error('tolerance must be positive')
    report = check(args.media, args.tolerance)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    raise SystemExit(0 if report['ok'] else 1)

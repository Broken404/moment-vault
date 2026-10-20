"""Check timestamp continuity of an explicitly moving, self-made fixture.

This catches the retained 0.0.4 short-capture failure. It does not interpret
legitimately static platform footage as a broken recording, or claim a fix.
"""
import argparse
import json
from pathlib import Path
import subprocess


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
    return {
        'ok': len(video) > 1 and tail <= tolerance and maximum_gap <= tolerance,
        'scope': 'timestamp continuity of explicitly moving self-made fixture',
        'videoFrames': len(video), 'firstVideoTime': video[0],
        'lastVideoTime': video[-1], 'lastAudioTime': max(audio, default=None),
        'audioOnlyTailSeconds': round(tail, 6),
        'maximumVideoGapSeconds': round(maximum_gap, 6),
        'toleranceSeconds': tolerance,
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

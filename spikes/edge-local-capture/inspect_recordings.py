"""Inspect actual local WebM files; never downloads platform media.

The report checks decoding, tracks, frames, audio energy and measured duration.
It does not turn source timestamps into proof of frame-accurate clipping.
"""
import argparse
import json
import math
from pathlib import Path
import re
import subprocess
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

DATA = Path(__file__).resolve().parents[2] / '.spike-data'


def command(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result


def inspect(media):
    description = (media.parent / 'description.md').read_text('utf-8')
    match = re.search(r'```json\s*\n(.*?)\n```', description, re.DOTALL)
    metadata = json.loads(match.group(1)) if match else {}
    details = json.loads(command(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', str(media)]).stdout)
    video = next((s for s in details['streams'] if s['codec_type'] == 'video'), None)
    audio = next((s for s in details['streams'] if s['codec_type'] == 'audio'), None)
    command(['ffmpeg', '-v', 'error', '-i', str(media), '-f', 'null', '-'])
    duration = float(details.get('format', {}).get('duration', 'nan'))
    duration_basis = 'container-header'
    # MediaRecorder WebM commonly has no final duration header. Inspect the
    # actual packet timestamps rather than treating that as no measured length.
    if not math.isfinite(duration):
        packets = [(float(p['pts_time']), float(p.get('duration_time', 0))) for p in details.get('packets', []) if 'pts_time' in p]
        duration = max((pts + length for pts, length in packets), default=float('nan')) - min((pts for pts, _ in packets), default=0)
        duration_basis = 'packet-timestamps'
    audio_mean = None
    if audio:
        sound = command(['ffmpeg', '-hide_banner', '-nostats', '-i', str(media), '-map', '0:a:0', '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr
        measured = re.search(r'mean_volume:\s*(-?\d+(?:\.\d+)?) dB', sound)
        audio_mean = float(measured.group(1)) if measured else None
    frames = command(['ffmpeg', '-v', 'error', '-i', str(media), '-vf', 'fps=2,scale=32:32,format=gray', '-an', '-f', 'framemd5', '-']).stdout
    unique_frames = len({line.split(',')[-1].strip() for line in frames.splitlines() if line and not line.startswith('#')})
    signal = command(['ffmpeg', '-hide_banner', '-nostats', '-i', str(media), '-vf', 'scale=32:32,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-']).stderr
    luma = [float(value) for value in re.findall(r'lavfi.signalstats.YAVG=(\d+(?:\.\d+)?)', signal)]
    actual_end = metadata.get('actualEnd')
    actual_start = metadata.get('actualStart')
    source_duration = actual_end - actual_start if actual_end is not None and actual_start is not None else None
    parsed = urlsplit(metadata.get('source', ''))
    query = parse_qs(parsed.query)
    # Keep the YouTube video identity while excluding tracking/query metadata.
    identity = urlencode({'v': query['v'][0]}) if parsed.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com') and query.get('v') else ''
    source = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, identity, ''))
    return {
        'item': media.parent.name, 'source': source, 'bytes': media.stat().st_size,
        'decodes': True, 'durationSeconds': duration if math.isfinite(duration) else None, 'durationBasis': duration_basis,
        'sourceActualRange': [actual_start, actual_end], 'selectedRange': [metadata.get('a'), metadata.get('b')],
        'sourceStartBasis': 'requested-seek',
        'stopReason': metadata.get('stopReason'),
        'durationDifferenceSeconds': duration-source_duration if math.isfinite(duration) and source_duration is not None else None,
        'video': {'codec': video['codec_name'], 'width': video['width'], 'height': video['height'], 'frames': int(video.get('nb_read_frames', 0))} if video else None,
        'audio': {'codec': audio['codec_name'], 'meanVolumeDb': audio_mean} if audio else None,
        'sampledUniqueFrames': unique_frames, 'averageLuma': sum(luma)/len(luma) if luma else None,
        'sourceMuted': metadata.get('sourceMuted'), 'sourceVolume': metadata.get('sourceVolume'),
        'captureFrame': metadata.get('captureFrame'), 'cropGeometry': metadata.get('geometry'),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=DATA / 'recording-inspection.json')
    args = parser.parse_args()
    results = []
    for root in ['draft', 'library']:
        for media in sorted((DATA / root).glob('spike-*/material.webm')):
            try:
                results.append(inspect(media))
            except (OSError, ValueError, RuntimeError) as error:
                results.append({'item': media.parent.name, 'decodes': False, 'error': str(error)})
    report = {'recordingCount': len(results), 'results': results}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not results:
        raise SystemExit(2)
    if any(not result.get('decodes') or not result.get('video') for result in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()

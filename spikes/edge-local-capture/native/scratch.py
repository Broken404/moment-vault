"""Local helper experiment: only disposable, explicitly bound scratch roots."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import uuid


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ScratchStore:
    def __init__(self, base, *, library=None):
        self.base = Path(base).resolve()
        self.draft = self.base / 'draft'
        self.library = Path(library).resolve() if library is not None else self.base / 'library'
        self._roots = {'draft': self.draft, 'library': self.library}
        self.draft.mkdir(parents=True, exist_ok=True)
        self.library.mkdir(parents=True, exist_ok=True)

    def root(self, name):
        if name not in ('draft', 'library'):
            raise ValueError('Only named scratch roots are accepted')
        configured = self._roots[name]
        root = configured.resolve(strict=True)
        if configured.is_symlink() or configured.is_junction() or root != configured or not root.is_dir():
            raise ValueError('Scratch root escaped the workspace')
        return root

    def item(self, root, name):
        if not name.startswith('spike-') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in name):
            raise ValueError('Invalid scratch item name')
        path = root / name
        if path.is_symlink() or path.is_junction() or path.resolve().parent != root.resolve():
            raise ValueError('Linked or escaped item is not allowed')
        return path

    def snapshot(self, item):
        result = {}
        for path in sorted(item.rglob('*')):
            if path.is_symlink() or path.is_junction() or not path.resolve().is_relative_to(item.resolve()):
                raise ValueError('Linked entries are not allowed')
            if path.is_file():
                result[path.relative_to(item).as_posix()] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
        return result

    def save(self, payload):
        extension = payload.get('extension', '')
        if extension not in ('webm', 'svg'):
            raise ValueError('Only test WebM or SVG material is accepted')
        media = base64.b64decode(payload['base64'], validate=True)
        if not media or len(media) > 12_000_000:
            raise ValueError('Invalid or oversized media')
        metadata = payload.get('metadata', {})
        name = 'spike-native-' + uuid.uuid4().hex
        target = self.item(self.root('draft'), name)
        target.mkdir()
        material = target / ('material.' + extension)
        material.write_bytes(media)
        expected = hashlib.sha256(media).hexdigest()
        if digest(material) != expected:
            raise IOError('Readback hash mismatch')
        description = '# Technical spike\n\nSource: %s\n\nCollected: %s\n\nNotes: %s\n\n```json\n%s\n```\n' % (
            metadata.get('source', 'unconfirmed'), metadata.get('collectedAt', ''), metadata.get('notes', ''),
            json.dumps(dict(metadata, bytes=len(media), sha256=expected), ensure_ascii=False, indent=2))
        (target / 'description.md').write_text(description, 'utf-8')
        if (target / 'description.md').read_text('utf-8') != description:
            raise IOError('Description readback mismatch')
        return {'item': name, 'bytes': len(media), 'sha256': expected, 'saveMode': 'native-scratch', 'files': self.snapshot(target), 'metadata': metadata}

    def promote(self, name):
        source = self.item(self.root('draft'), name)
        target = self.item(self.root('library'), name)
        if not source.is_dir():
            raise FileNotFoundError('Draft item is absent; it may already have been moved. No files changed')
        if target.exists():
            raise FileExistsError('Target exists; source retained')
        before = self.snapshot(source)
        if len(before) < 2:
            raise ValueError('Incomplete item')
        shutil.copytree(source, target, symlinks=False)
        if self.snapshot(target) != before or self.snapshot(source) != before:
            raise IOError('Copy verification failed; source retained')
        try:
            shutil.rmtree(source)
        except OSError as error:
            return {'status': 'copied-source-retained', 'item': name, 'error': str(error)}
        return {'status': 'moved', 'item': name, 'files': before}

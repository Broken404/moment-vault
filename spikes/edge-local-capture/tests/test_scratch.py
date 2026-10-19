"""Real filesystem checks for the helper route, with disposable test data only."""
import base64
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

SPIKE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('scratch', SPIKE / 'native' / 'scratch.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ScratchTests(unittest.TestCase):
    def setUp(self):
        self.scratch_parent = (SPIKE.parents[1] / '.spike-data').resolve()
        self.scratch_parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='file-tests-', dir=self.scratch_parent)
        self.base = Path(self.temp.name).resolve()
        self.assertEqual(self.base.parent, self.scratch_parent)
        self.store = module.ScratchStore(self.base)

    def tearDown(self):
        # Only the freshly created child of the explicitly checked scratch path.
        self.assertEqual(self.base.parent, self.scratch_parent)
        self.temp.cleanup()

    def save(self):
        return self.store.save({'extension': 'svg', 'base64': base64.b64encode(b'<svg>self-made test</svg>').decode(),
                                'metadata': {'source': 'self-made', 'collectedAt': '2026-10-19', 'notes': 'fixture'}})

    def test_save_readback_hashes_and_description(self):
        item = self.save()
        directory = self.store.draft / item['item']
        self.assertEqual((directory / 'material.svg').read_bytes(), b'<svg>self-made test</svg>')
        self.assertEqual(item['sha256'], module.digest(directory / 'material.svg'))
        self.assertIn('Source: self-made', (directory / 'description.md').read_text('utf-8'))
        self.assertEqual(set(item['files']), {'material.svg', 'description.md'})

    def test_promote_preserves_both_files_and_cleans_source(self):
        item = self.save()
        result = self.store.promote(item['item'])
        self.assertEqual(result['status'], 'moved')
        self.assertFalse((self.store.draft / item['item']).exists())
        self.assertEqual(self.store.snapshot(self.store.library / item['item']), item['files'])

    def test_existing_destination_is_never_overwritten(self):
        item = self.save()
        destination = self.store.library / item['item']
        destination.mkdir()
        (destination / 'keep.txt').write_text('existing', 'utf-8')
        with self.assertRaises(FileExistsError):
            self.store.promote(item['item'])
        self.assertTrue((self.store.draft / item['item'] / 'material.svg').exists())
        self.assertEqual((destination / 'keep.txt').read_text('utf-8'), 'existing')

    def test_retry_of_already_moved_item_reports_missing_draft(self):
        item = self.save()
        self.store.promote(item['item'])
        with self.assertRaises(FileNotFoundError):
            self.store.promote(item['item'])
        self.assertEqual(self.store.snapshot(self.store.library / item['item']), item['files'])

    def test_corrupt_copy_retains_source(self):
        item = self.save()
        copytree = shutil.copytree

        def corrupt(source, destination, **kwargs):
            copytree(source, destination, **kwargs)
            (destination / 'material.svg').write_bytes(b'corrupted')

        with patch.object(module.shutil, 'copytree', side_effect=corrupt):
            with self.assertRaises(IOError):
                self.store.promote(item['item'])
        self.assertEqual(self.store.snapshot(self.store.draft / item['item']), item['files'])

    def test_failed_source_cleanup_reports_partial_result(self):
        item = self.save()
        with patch.object(module.shutil, 'rmtree', side_effect=PermissionError('injected test failure')):
            result = self.store.promote(item['item'])
        self.assertEqual(result['status'], 'copied-source-retained')
        self.assertTrue((self.store.draft / item['item']).exists())
        self.assertEqual(self.store.snapshot(self.store.library / item['item']), item['files'])

    def test_path_traversal_and_arbitrary_root_rejected(self):
        for name in ('../outside', 'spike-../outside', 'spike-a/b', 'other'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.store.promote(name)
        with self.assertRaises(ValueError):
            self.store.root('C:/Users')

    def test_cross_volume_preserves_media_and_notes(self):
        temp_parent = Path(tempfile.gettempdir()).resolve()
        with tempfile.TemporaryDirectory(prefix='moment-vault-cross-drive-', dir=temp_parent) as folder:
            cross_base = Path(folder).resolve()
            self.assertEqual(cross_base.parent, temp_parent)
            if cross_base.drive.lower() == self.base.drive.lower():
                self.skipTest('A second test volume is unavailable')
            self.store = module.ScratchStore(self.base, library=cross_base / 'library')
            item = self.save()
            result = self.store.promote(item['item'])
            self.assertEqual(result['status'], 'moved')
            self.assertEqual(self.store.snapshot(self.store.library / item['item']), item['files'])
            self.assertFalse((self.store.draft / item['item']).exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)

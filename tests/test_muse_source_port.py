"""Pinned source text is an independent oracle for the faithful port."""
import ast
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from qwen_ui_pipeline.muse_recipe import prepare
from qwen_ui_pipeline.muse_assembly_host import assemble

ROOT = Path(__file__).resolve().parents[1]


class MuseSourcePortTests(unittest.TestCase):
    def test_preserved_source_slices_match_pinned_original_hashes(self):
        for item in json.loads((ROOT / 'procedures/muse/source-manifest.json').read_text())['sources']:
            source = (ROOT / item['destination']).read_text()
            symbol = item['symbol']
            if item['destination'].endswith('.py'):
                lines = source.splitlines(keepends=True)
                node = next(n for n in ast.parse(source).body if getattr(n, 'name', None) == symbol or isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name) and n.targets[0].id == symbol)
                text = ''.join(lines[node.lineno-1:node.end_lineno])
            elif symbol == 'InventedProductEngine':
                text = source[:source.index('\nexport default InventedProductEngine;')]
            elif symbol == 'strategyDirections':
                text = source[:source.index('\nexport function')]
            else:
                text = source[source.index('    const prompt = ['):source.index('\n  return prompt;')]
            self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), item['preservedTextSha256'], symbol)

    def test_prompt_drift_missing_reference_and_empty_assembly_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prompt = root / 'prompt.txt'; prompt.write_text('original')
            recipe = {'procedure':'image','prompt':'prompt.txt','promptSha256':hashlib.sha256(b'original').hexdigest(),'size':'2x2','references':[]}
            (root/'recipe.json').write_text(json.dumps(recipe))
            self.assertEqual(prepare(root,'recipe.json')['prompt'],'original')
            prompt.write_text('changed')
            with self.assertRaisesRegex(ValueError,'hash drift'): prepare(root,'recipe.json')
            prompt.write_text('original'); recipe['references']=['missing.png']; (root/'recipe.json').write_text(json.dumps(recipe))
            with self.assertRaises(FileNotFoundError): prepare(root,'recipe.json')
            from qwen_ui_pipeline.muse_assembly_host import SETTINGS
            (root/'packets.json').write_text('[]'); (root/'generation-plan.json').write_text('{"attempts":[]}'); (root/'layouts.json').write_text('{"fonts":{}}')
            (root/'assembly.json').write_text(json.dumps({'settings':{key:[] for key in SETTINGS},'donorHome':'.','outputHome':'new-output','layouts':'layouts.json'}))
            with self.assertRaisesRegex(ValueError,'requires packets'): assemble(root,'assembly.json')
            self.assertFalse((root/'new-output').exists())

    def test_cleanup_retains_exact_fixture_bytes_and_history_pointers(self):
        rows = json.loads((ROOT/'migration/muse-retirement.json').read_text())['files']
        self.assertEqual(len({row['path'] for row in rows}),len(rows))
        for row in rows:
            self.assertRegex(row['historyCommit'], r'^[0-9a-f]{40}$')
            self.assertFalse((ROOT/row['path']).exists(),row['path'])
            if row.get('fixturePath'):
                self.assertEqual(hashlib.sha256((ROOT/row['fixturePath']).read_bytes()).hexdigest(),row['sha256'],row['fixturePath'])

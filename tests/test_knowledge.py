import contextlib
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

from knowledge import cli


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.vault = self.base / 'vault'
        self.source = self.base / 'source'
        self.source.mkdir()
        self.output = io.StringIO()
        self.quiet = contextlib.redirect_stdout(self.output)
        self.quiet.__enter__()
        self.addCleanup(self.quiet.__exit__, None, None, None)
        cli.init(self.vault)
        self.sid = cli.add_source(self.vault, self.source, 'self')
        self.note = self.source / 'note.md'
        self.note.write_text('我希望合作尊重长期信任。', encoding='utf-8')
        cli.sync(self.vault)

    def rows(self, table):
        with sqlite3.connect(self.vault / 'state.sqlite3') as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute('SELECT * FROM ' + table)]

    def submit(self, phase, payload):
        pack = cli.pack(self.vault, phase)
        task = json.loads((pack / 'input.json').read_text())
        path = self.base / 'result.json'
        cli.write_json(path, {'job_id': task['job_id'], 'phase': phase, **payload})
        cli.import_result(self.vault, path)
        return path

    def extract(self):
        evidence = self.rows('evidence')[0]
        self.submit('extract', {'claims': [{
            'statement': '重视长期信任', 'kind': 'hypothesis',
            'conditions': '目前仅有一次表达', 'counterevidence': '尚未发现',
            'evidence': [{'id': evidence['id'], 'quote': evidence['text']}],
            'public': True, 'state': 'confirmed',
        }]})
        return self.rows('claims')[0]['id']

    def complete(self):
        cid = self.extract()
        for role in cli.ROLES[1:]:
            self.submit(role, {'assessments': [{'claim_id': cid, 'outcome': 'pass', 'reason': '已回查原文；仅视为候选假设'}]})
        return cid

    def test_duplicate_sync_and_model_cannot_confirm(self):
        before = self.rows('evidence')
        self.assertEqual(cli.sync(self.vault)['unchanged'], 1)
        self.assertEqual(self.rows('evidence'), before)
        cid = self.extract()
        self.assertEqual(self.rows('claims')[0]['state'], 'candidate')
        self.assertEqual(cli.report(self.vault, True), [])
        with self.assertRaises(ValueError):
            cli.review(self.vault, cid, 'confirm', True)

    def test_assistant_and_unclassified_are_not_personal_evidence(self):
        self.note.unlink()
        mapping = {'1': {'message': {'author': {'role': 'assistant'}, 'content': {'parts': ['AI opinion']}}},
                   '2': {'message': {'author': {'role': 'user'}, 'content': {'parts': ['My opinion']}}}}
        export = self.source / 'conversations.json'
        export.write_text(json.dumps([{'mapping': mapping}]))
        cli.sync(self.vault)
        rows = self.rows('evidence')
        assistant = next(r for r in rows if r['role'] == 'assistant')
        body = {'statement': 'invalid', 'kind': 'principle', 'conditions': '', 'counterevidence': '', 'evidence': [{'id': assistant['id'], 'quote': assistant['text']}]}
        _, db = cli.connect(self.vault)
        with self.assertRaises(ValueError):
            cli.validate_claim(db, body)
        db.close()
        self.assertTrue(all(role != 'user' for role, _, _ in cli.parse(export, 'unclassified')))

    def test_chatgpt_active_branch_only(self):
        path = self.source / 'chat.json'
        path.write_text(json.dumps({'current_node': 'b', 'mapping': {
            'a': {'parent': None, 'message': {'author': {'role': 'user'}, 'content': {'parts': ['first']}}},
            'b': {'parent': 'a', 'message': {'author': {'role': 'assistant'}, 'content': {'parts': ['active']}}},
            'c': {'parent': 'a', 'message': {'author': {'role': 'assistant'}, 'content': {'parts': ['inactive']}}},
        }}))
        self.assertEqual([t for _, _, t in cli.parse(path, 'self')], ['first', 'active'])

    def test_human_confirmation_and_explicit_public_gate(self):
        cid = self.complete()
        cli.review(self.vault, cid, 'confirm')
        self.assertEqual(cli.report(self.vault, True), [])
        cli.review(self.vault, cid, 'confirm', True)
        result = cli.report(self.vault, True)
        self.assertEqual(len(result), 1)
        self.assertEqual(set(result[0]), {'id', 'statement', 'kind'})
        self.assertNotIn('evidence', json.dumps(result))

    def test_deleted_source_purges_derivatives_and_revokes_public(self):
        cid = self.complete()
        cli.review(self.vault, cid, 'confirm', True)
        cli.report(self.vault, True)
        cli.report(self.vault)
        self.note.unlink()
        cli.sync(self.vault)
        self.assertEqual(self.rows('evidence'), [])
        self.assertEqual(self.rows('claims')[0]['state'], 'stale')
        self.assertNotIn('长期信任', self.rows('claims')[0]['body'])
        self.assertEqual(list((self.vault / 'jobs').iterdir()), [])
        self.assertEqual(list((self.vault / 'outbox').iterdir()), [])
        self.assertEqual(list((self.vault / 'reports').iterdir()), [])
        self.assertEqual(cli.report(self.vault, True), [])

    def test_source_disabled_and_original_untouched(self):
        self.extract()
        cli.disable(self.vault, self.sid)
        self.assertTrue(self.note.is_file())
        self.assertEqual(self.rows('evidence'), [])
        self.assertEqual(cli.sync(self.vault)['new_or_changed'], 0)

    def test_stale_job_and_exact_quote_rejected(self):
        pack = cli.pack(self.vault, 'extract')
        data = json.loads((pack / 'input.json').read_text())
        self.note.write_text('new opinion')
        cli.sync(self.vault)
        path = self.base / 'result.json'
        cli.write_json(path, {'job_id': data['job_id'], 'phase': 'extract', 'claims': []})
        with self.assertRaises(ValueError):
            cli.import_result(self.vault, path)
        _, db = cli.connect(self.vault)
        ref = self.rows('evidence')[0]
        with self.assertRaises(ValueError):
            cli.validate_claim(db, {'statement': 'claim', 'kind': 'principle', 'conditions': '', 'counterevidence': '', 'evidence': [{'id': ref['id'], 'quote': 'fabricated'}]})
        db.close()

    def test_unavailable_source_is_failure_not_deletion(self):
        self.source.rename(self.base / 'temporarily-unmounted')
        counts = cli.sync(self.vault)
        self.assertEqual(counts['errors'], 1)
        self.assertEqual(len(self.rows('evidence')), 1)
        self.assertEqual(self.rows('events')[-2]['kind'], 'source_unavailable')

    def test_modified_invalid_json_invalidates_previous_evidence(self):
        path = self.source / 'chat.json'
        path.write_text(json.dumps({'mapping': {'a': {'message': {'author': {'role': 'user'}, 'content': {'parts': ['test']}}}}}))
        cli.sync(self.vault)
        old = next(r['id'] for r in self.rows('documents') if r['path'] == 'chat.json')
        path.write_text('{invalid json')
        self.assertEqual(cli.sync(self.vault)['errors'], 1)
        self.assertNotIn(old, [r['document_id'] for r in self.rows('evidence')])

    def test_review_order_and_revision_block_confirmation(self):
        cid = self.extract()
        with self.assertRaises(ValueError):
            cli.pack(self.vault, 'challenge')
        self.submit('verify', {'assessments': [{'claim_id': cid, 'outcome': 'revise', 'reason': '需要更多上下文'}]})
        self.assertEqual(self.rows('claims')[0]['state'], 'needs_revision')
        with self.assertRaises(ValueError):
            cli.review(self.vault, cid, 'confirm')

    def test_git_storage_rejected_and_symlink_not_read(self):
        repo = self.base / 'public'
        repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        with self.assertRaises(ValueError):
            cli.init(repo / 'private')
        outside = self.base / 'secret.txt'
        outside.write_text('not authorized')
        (self.source / 'linked.txt').symlink_to(outside)
        cli.sync(self.vault)
        self.assertEqual(len(self.rows('documents')), 1)


    def test_revoking_public_removes_old_export(self):
        cid = self.complete()
        cli.review(self.vault, cid, 'confirm', True)
        cli.report(self.vault, True)
        cli.review(self.vault, cid, 'reject')
        self.assertFalse((self.vault / 'outbox' / 'approved-statements.json').exists())
        self.assertEqual(cli.report(self.vault, True), [])

    def test_replaced_source_root_cannot_import_outside_material(self):
        self.source.rename(self.base / 'old-source')
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'secret.txt').write_text('must not import')
        self.source.symlink_to(outside, target_is_directory=True)
        self.assertEqual(cli.sync(self.vault)['errors'], 1)
        self.assertNotIn('must not import', str(self.rows('evidence')))
        with self.assertRaises(ValueError):
            cli.report(self.vault, True)

    def test_secure_delete_removes_current_database_copy(self):
        canary = 'private-deletion-canary-4398'
        self.note.write_text(canary)
        cli.sync(self.vault)
        self.assertIn(canary.encode(), (self.vault / 'state.sqlite3').read_bytes())
        cli.disable(self.vault, self.sid)
        self.assertNotIn(canary.encode(), (self.vault / 'state.sqlite3').read_bytes())

    def test_empty_extraction_can_be_retried_with_new_attempt(self):
        path = self.submit('extract', {'claims': []})
        previous = json.loads(path.read_text())['job_id']
        pack = cli.pack(self.vault, 'extract')
        task = json.loads((pack / 'input.json').read_text())
        self.assertNotEqual(task['job_id'], previous)
        cli.write_json(path, {'job_id': task['job_id'], 'phase': 'extract', 'claims': []})
        cli.import_result(self.vault, path)


    def test_structurally_malformed_export_invalidates_old_evidence(self):
        self.note.unlink()
        path = self.source / 'chat.json'
        path.write_text(json.dumps({'mapping': {'a': {'message': {'author': {'role': 'user'}, 'content': {'parts': ['private opinion']}}}}}))
        cli.sync(self.vault)
        cid = self.complete()
        cli.review(self.vault, cid, 'confirm', True)
        cli.report(self.vault, True)
        path.write_text('{"mapping":{"a":null}}')
        with self.assertRaises(ValueError):
            cli.report(self.vault, True)
        self.assertEqual(self.rows('evidence'), [])
        self.assertEqual(self.rows('claims')[0]['state'], 'stale')
        self.assertFalse((self.vault / 'outbox' / 'approved-statements.json').exists())


    def test_reject_after_confirmation_updates_decision_history(self):
        from knowledge import decisions
        cid = self.complete()
        cli.review(self.vault,cid,'confirm',True)
        _, db = cli.connect(self.vault)
        first = next(r for r in decisions.latest(db) if cid in r['record']['related_claim_ids'])
        db.close()
        cli.review(self.vault,cid,'reject')
        _, db = cli.connect(self.vault)
        records = decisions.latest(db)
        self.assertEqual(next(r for r in records if r['decision_id']==first['decision_id'])['record']['status'], 'superseded')
        newest = next(r for r in records if cid in r['record']['related_claim_ids'] and r['record']['status']=='implemented')
        self.assertIn(first['decision_id'],newest['record']['replaces'])
        self.assertEqual(json.loads(newest['record']['decision'])['decision'],'reject')
        db.close()

    def test_failed_import_is_atomic_and_cannot_replay(self):
        self.extract()
        previous = self.rows('claims')
        pack = cli.pack(self.vault, 'extract')
        data = json.loads((pack / 'input.json').read_text())
        result = self.base / 'bad.json'
        cli.write_json(result, {'job_id': data['job_id'], 'phase': 'extract', 'claims': [{'statement': 'invalid'}]})
        with self.assertRaises(ValueError):
            cli.import_result(self.vault, result)
        self.assertEqual(self.rows('claims'), previous)
        cli.write_json(result, {'job_id': data['job_id'], 'phase': 'extract', 'claims': []})
        cli.import_result(self.vault, result)
        with self.assertRaises(ValueError):
            cli.import_result(self.vault, result)


if __name__ == '__main__':
    unittest.main()

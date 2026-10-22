from copy import deepcopy
import contextlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from knowledge import cli, decisions


def draft():
    return {'title': '示例决议', 'decision': '使用指定资料区', 'rationale': '缩小采集范围', 'scope': '本地试验', 'owner': '操作者', 'authority': 'proposal', 'effective_when': '人工确认后', 'basis': ['示例资料指针'], 'alternatives': ['不采集'], 'review_triggers': ['来源变化'], 'related_claim_ids': [], 'replaces': [], 'status': 'proposed'}


class DecisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.vault = self.root / 'vault'
        self.quiet = contextlib.redirect_stdout(io.StringIO())
        self.quiet.__enter__()
        self.addCleanup(self.quiet.__exit__, None, None, None)
        cli.init(self.vault)

    def test_record_export_and_append_revision(self):
        record = draft()
        first = decisions.store(self.vault, record, 'operator', 'new proposal')
        record.update(status='accepted', approval_reference='explicit approval example')
        second = decisions.store(self.vault, record, 'operator', 'approval captured', first['decision_id'], 1)
        self.assertEqual(second['revision'], 2)
        _, db = cli.connect(self.vault)
        self.assertEqual(len(db.execute('SELECT * FROM decision_revisions').fetchall()), 2)
        self.assertTrue(decisions.verify(db))
        db.close()
        self.assertIn('accepted', (self.vault / 'decision-archive' / 'index.md').read_text())
        self.assertTrue((self.vault / 'decision-archive' / 'history.jsonl').exists())

    def test_approval_evidence_and_revision_lease_required(self):
        record = draft()
        first = decisions.store(self.vault, record, 'operator', 'proposal')
        record['status'] = 'accepted'
        with self.assertRaises(ValueError):
            decisions.store(self.vault, record, 'operator', 'no approval', first['decision_id'], 1)
        record['approval_reference'] = 'explicit example'
        with self.assertRaises(ValueError):
            decisions.store(self.vault, record, 'operator', 'stale revision', first['decision_id'], 0)

    def test_accepted_substance_cannot_be_overwritten(self):
        record = draft()
        record.update(status='accepted', approval_reference='explicit example')
        first = decisions.store(self.vault, record, 'operator', 'accepted')
        record['decision'] = 'expanded data access'
        with self.assertRaises(ValueError):
            decisions.store(self.vault, record, 'operator', 'silent change', first['decision_id'], 1)
        record['status'] = 'proposed'
        record['replaces'] = [first['decision_id']]
        replacement = decisions.store(self.vault, record, 'operator', 'replacement proposal')
        self.assertNotEqual(replacement['decision_id'], first['decision_id'])

    def test_chain_detects_modification(self):
        decisions.store(self.vault, draft(), 'operator', 'proposal')
        _, db = cli.connect(self.vault)
        with db:
            db.execute("UPDATE decision_revisions SET hash='corrupted'")
        with self.assertRaises(ValueError): decisions.verify(db)
        db.close()

    def test_terminal_decision_cannot_be_revived(self):
        record = draft()
        record['status'] = 'rejected'
        first = decisions.store(self.vault, record, 'operator', 'rejected')
        record.update(status='accepted', approval_reference='example')
        with self.assertRaises(ValueError):
            decisions.store(self.vault, record, 'operator', 'revive', first['decision_id'], 1)

    def test_source_operations_automatically_archive_ids_only(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'note.txt').write_text('private-original-canary')
        sid = cli.add_source(self.vault, source, 'self')
        cli.sync(self.vault)
        cli.disable(self.vault, sid)
        _, db = cli.connect(self.vault)
        records = decisions.latest(db)
        self.assertEqual(len(records), 2)
        self.assertNotIn('private-original-canary', json.dumps(records))
        self.assertTrue((self.vault / 'decision-archive' / 'index.md').exists())
        db.close()


    def test_archive_directory_symlink_rejected_without_touching_git(self):
        outside = self.root / 'public-repo'
        outside.mkdir()
        subprocess.run(['git', 'init', '-q', str(outside)], check=True)
        readme = outside / 'README.md'
        readme.write_text('unrelated-public-content')
        (self.vault / 'decision-archive').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            decisions.export(self.vault)
        self.assertEqual(readme.read_text(), 'unrelated-public-content')
        self.assertFalse((outside / 'history.jsonl').exists())

    def test_export_preserves_unrelated_files_and_rejects_file_symlinks(self):
        decisions.store(self.vault, draft(), 'operator', 'proposal')
        archive = self.vault / 'decision-archive'
        readme = archive / 'README.md'
        readme.write_text('keep this personal annotation')
        decisions.export(self.vault)
        self.assertEqual(readme.read_text(), 'keep this personal annotation')
        external = self.root / 'external.md'
        external.write_text('external content')
        (archive / 'index.md').unlink()
        (archive / 'index.md').symlink_to(external)
        with self.assertRaises(ValueError):
            decisions.export(self.vault)
        self.assertEqual(external.read_text(), 'external content')

    def test_changed_human_review_supersedes_operation_and_invalidates_dependents(self):
        _, db = cli.connect(self.vault)
        with db:
            first = decisions.operational(db, 'human_review', {'claim_id':'claim-1','decision':'confirm','public':True}, 1)
            record = draft()
            record.update(status='accepted', approval_reference='example', related_claim_ids=['claim-1'])
            dependent = decisions.append(db, record, 'operator', 'accepted dependent')
            newest = decisions.operational(db, 'human_review', {'claim_id':'claim-1','decision':'reject','public':False}, 2)
        records = {item['decision_id']:item for item in decisions.latest(db)}
        self.assertEqual(records[first['decision_id']]['record']['status'], 'superseded')
        self.assertEqual(records[dependent['decision_id']]['record']['status'], 'needs_review')
        self.assertEqual(newest['record']['replaces'], [first['decision_id']])
        self.assertTrue(decisions.verify(db))
        db.close()

    def test_repeated_review_keeps_dependent_but_public_revoke_invalidates(self):
        _, db = cli.connect(self.vault)
        detail = {'claim_id':'claim-1','decision':'confirm','public':True}
        with db:
            decisions.operational(db,'human_review',detail,1)
            record = draft()
            record.update(status='accepted', approval_reference='example', related_claim_ids=['claim-1'])
            dependent = decisions.append(db,record,'operator','accepted')
            decisions.operational(db,'human_review',detail,2)
        self.assertEqual(next(r for r in decisions.latest(db) if r['decision_id']==dependent['decision_id'])['record']['status'], 'accepted')
        with db:
            decisions.operational(db,'human_review',dict(detail,public=False),3)
        self.assertEqual(next(r for r in decisions.latest(db) if r['decision_id']==dependent['decision_id'])['record']['status'], 'needs_review')
        db.close()

    def test_invalidated_claim_marks_decision_for_review(self):
        record = draft()
        record.update(status='accepted', approval_reference='example', related_claim_ids=['example-claim'])
        first = decisions.store(self.vault, record, 'operator', 'accepted')
        _, db = cli.connect(self.vault)
        with db:
            decisions.invalidate_claim(db, 'example-claim')
        latest = decisions.latest(db)
        self.assertEqual(latest[0]['record']['status'], 'needs_review')
        self.assertEqual(latest[0]['revision'], 2)
        self.assertEqual(latest[0]['decision_id'], first['decision_id'])
        db.close()


if __name__ == '__main__': unittest.main()

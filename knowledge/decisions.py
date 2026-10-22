"""Private, append-only decision records with verifiable revision history."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import uuid

from .cli import connect, encoded, private_path

STATES = {'proposed', 'accepted', 'implemented', 'rejected', 'superseded', 'revoked', 'needs_review'}
TEXT_FIELDS = ('title', 'decision', 'rationale', 'scope', 'owner', 'authority', 'effective_when')
LIST_FIELDS = ('basis', 'alternatives', 'review_triggers', 'related_claim_ids', 'replaces')


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS decision_revisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        envelope TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        UNIQUE(decision_id,revision)
    )''')


def validate(record):
    if not isinstance(record, dict) or record.get('status') not in STATES:
        raise ValueError('Decision requires valid status')
    for field in TEXT_FIELDS:
        if not isinstance(record.get(field), str) or not record[field].strip():
            raise ValueError('Decision requires nonempty text fields')
    for field in LIST_FIELDS:
        if not isinstance(record.get(field), list) or any(not isinstance(item, str) or not item.strip() for item in record[field]):
            raise ValueError('Decision requires string lists')
    if not record['basis'] or not record['review_triggers']:
        raise ValueError('Basis and review triggers are required')
    if record['status'] == 'accepted' and not record.get('approval_reference'):
        raise ValueError('Acceptance requires explicit approval reference')
    return {key: record[key] for key in (*TEXT_FIELDS, *LIST_FIELDS, 'status', 'approval_reference') if key in record}


def verify(db):
    schema(db)
    previous, revisions = '', {}
    for row in db.execute('SELECT * FROM decision_revisions ORDER BY seq'):
        envelope = json.loads(row['envelope'])
        expected = hashlib.sha256((previous + '\n' + encoded(envelope)).encode()).hexdigest()
        revision = revisions.get(row['decision_id'], 0) + 1
        if row['previous_hash'] != previous or row['hash'] != expected or row['revision'] != revision or envelope['decision_id'] != row['decision_id'] or envelope['revision'] != revision:
            raise ValueError('Decision history integrity check failed')
        previous, revisions[row['decision_id']] = row['hash'], revision
    return previous


def append(db, record, actor, reason, decision_id=None, expected_revision=None):
    schema(db)
    record = validate(record)
    if not actor.strip() or not reason.strip():
        raise ValueError('Actor and change reason required')
    previous_hash = verify(db)
    if decision_id is None:
        decision_id = 'DEC-' + datetime.now(timezone.utc).strftime('%Y%m%d') + '-' + uuid.uuid4().hex[:12]
        if expected_revision is not None:
            raise ValueError('New decision has no expected revision')
    elif any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-' for c in decision_id):
        raise ValueError('Invalid decision ID')
    previous = db.execute('SELECT * FROM decision_revisions WHERE decision_id=? ORDER BY revision DESC LIMIT 1', (decision_id,)).fetchone()
    if previous:
        if expected_revision != previous['revision']:
            raise ValueError('Revision conflict; read latest decision before changing it')
        old = json.loads(previous['envelope'])['record']
        # Once accepted/applied, amend the substance through a new linked decision.
        histories = db.execute('SELECT envelope FROM decision_revisions WHERE decision_id=?', (decision_id,)).fetchall()
        frozen = any(json.loads(r['envelope'])['record']['status'] in ('accepted', 'implemented') for r in histories)
        if frozen and any(record.get(k) != old.get(k) for k in (*TEXT_FIELDS, *LIST_FIELDS)):
            raise ValueError('Accepted substance is immutable; create a replacement proposal')
        if old['status'] in ('revoked', 'rejected', 'superseded'):
            raise ValueError('Terminal decision cannot be revived; create a new proposal')
        revision = previous['revision'] + 1
    else:
        if expected_revision is not None:
            raise ValueError('Unknown decision')
        revision = 1
    for replaced in record['replaces']:
        if replaced == decision_id or not db.execute('SELECT 1 FROM decision_revisions WHERE decision_id=?', (replaced,)).fetchone():
            raise ValueError('Replacement must reference an existing distinct decision')
    envelope = {'decision_id': decision_id, 'revision': revision, 'recorded_at': datetime.now(timezone.utc).isoformat(), 'actor': actor, 'change_reason': reason, 'record': record}
    chain_hash = hashlib.sha256((previous_hash + '\n' + encoded(envelope)).encode()).hexdigest()
    db.execute('INSERT INTO decision_revisions(decision_id,revision,envelope,previous_hash,hash) VALUES(?,?,?,?,?)', (decision_id, revision, encoded(envelope), previous_hash, chain_hash))
    return envelope


def latest(db):
    verify(db)
    return [json.loads(row['envelope']) for row in db.execute('SELECT * FROM decision_revisions WHERE seq IN (SELECT MAX(seq) FROM decision_revisions GROUP BY decision_id) ORDER BY seq')]


def invalidate_claim(db, claim_id):
    schema(db)
    for envelope in latest(db):
        record = envelope['record']
        if claim_id in record['related_claim_ids'] and record['status'] in ('accepted', 'implemented'):
            record['status'] = 'needs_review'
            append(db, record, 'source-monitor', 'Referenced claim lost its current evidence; previous decision is no longer safe to apply.', envelope['decision_id'], envelope['revision'])


def operational(db, kind, detail, event_id):
    # IDs only: do not duplicate private source passages into permanent decision history.
    titles = {'source_registered': '登记资料来源范围', 'source_disabled': '停用资料来源', 'human_review': '记录核心主张审核操作'}
    replacements = []
    if kind == 'human_review':
        prior = [item for item in latest(db) if detail['claim_id'] in item['record']['related_claim_ids'] and item['record']['status'] in ('accepted', 'implemented', 'needs_review')]
        previous_operations = [item for item in prior if item['record']['authority'] == 'operator-action' and item['record']['title'] == titles[kind]]
        changed = not previous_operations or any(item['record']['decision'] != encoded(detail) for item in previous_operations)
        for item in prior:
            old = item['record']
            if item in previous_operations:
                old['status'] = 'superseded'
                replacements.append(item['decision_id'])
            elif changed and old['status'] in ('accepted', 'implemented'):
                old['status'] = 'needs_review'
            else:
                continue
            append(db, old, 'review-monitor', 'A newer human review replaces the prior operation; dependent decisions require review when its outcome or public consent changes.', item['decision_id'], item['revision'])
    record = {
        'title': titles[kind], 'decision': encoded(detail),
        'rationale': '保存显式操作的治理记录；不独立证明操作者身份，也不替代原始用户授权。',
        'scope': '本私有资料库', 'owner': '本地操作者', 'authority': 'operator-action',
        'effective_when': '对应操作事务提交后；以最新证据及最新审核状态为准',
        'basis': ['private-events:' + str(event_id)], 'alternatives': ['不执行该操作'],
        'review_triggers': ['来源或授权变化', '相关证据失效', '操作者纠正'],
        'related_claim_ids': [detail['claim_id']] if 'claim_id' in detail else [],
        'replaces': replacements, 'status': 'implemented',
    }
    return append(db, record, 'local-operator', 'Automatic record of explicit local operation')


def write_archive(path, content):
    """Atomically replace an owned view without following file symlinks/hardlinks."""
    if path.is_symlink():
        raise ValueError('Archive file must not be a symlink')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.decision-', delete=False) as stream:
            temporary = Path(stream.name)
            temporary.chmod(0o600)
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def export(vault):
    vault, db = connect(vault)
    try:
        records = latest(db)
        directory = vault / 'decision-archive'
        if directory.is_symlink() or directory.resolve() != directory:
            raise ValueError('Archive directory must not be a symlink')
        private_path(directory)
        directory.mkdir(exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        targets = [directory / (item['decision_id'] + '.md') for item in records] + [directory / 'index.md', directory / 'history.jsonl']
        if any(path.is_symlink() for path in targets):
            raise ValueError('Archive files must not be symlinks')
        # Preserve unrelated files. Only atomically replace the generated views.
        links = ['# 决议档案索引', '', '仅用于私有治理。accepted 表示已记录确认依据，不代表密码学身份认证。', '']
        history = [json.loads(r['envelope']) for r in db.execute('SELECT envelope FROM decision_revisions ORDER BY seq')]
        for envelope in records:
            did, record = envelope['decision_id'], envelope['record']
            lines = ['# ' + did + ' · ' + record['title'], '', '状态：' + record['status'], '版本：' + str(envelope['revision']), '记录时间：' + envelope['recorded_at'], '记录者：' + envelope['actor'], '']
            for label, field in [('决议正文','decision'), ('理由与取舍','rationale'), ('适用范围','scope'), ('责任人','owner'), ('权限依据类型','authority'), ('生效条件','effective_when')]:
                lines.extend(['## ' + label, '', record[field], ''])
            for label, field in [('证据与授权依据','basis'), ('备选方案','alternatives'), ('复审触发条件','review_triggers'), ('关联主张','related_claim_ids'), ('拟替代决议','replaces')]:
                lines.extend(['## ' + label, '', *['- ' + item for item in record[field]], ''])
            lines.extend(['## 确认依据', '', record.get('approval_reference') or '未记录本人确认；实施记录不等于核心立场已获本人批准。', '', '## 追加修订历史', ''])
            lines.extend('- r' + str(item['revision']) + ' ' + item['recorded_at'] + ' ' + item['record']['status'] + ' — ' + item['change_reason'] for item in history if item['decision_id'] == did)
            path = directory / (did + '.md')
            write_archive(path, '\n'.join(lines) + '\n')
            links.append('- [' + did + '](' + did + '.md) · ' + record['status'] + ' · ' + record['title'])
        archive = directory / 'history.jsonl'
        write_archive(archive, ''.join(encoded(dict(row)) + '\n' for row in db.execute('SELECT * FROM decision_revisions ORDER BY seq')))
        index = directory / 'index.md'
        write_archive(index, '\n'.join(links) + '\n')
        return index
    finally:
        db.close()


def store(vault, record, actor, reason, decision_id=None, expected_revision=None):
    _, db = connect(vault)
    try:
        db.execute('BEGIN IMMEDIATE')
        envelope = append(db, record, actor, reason, decision_id, expected_revision)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    export(vault)
    return envelope


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    record = commands.add_parser('record')
    record.add_argument('input', help='Private decision JSON')
    record.add_argument('--actor', required=True)
    record.add_argument('--reason', required=True)
    record.add_argument('--id')
    record.add_argument('--expected-revision', type=int)
    commands.add_parser('export')
    commands.add_parser('verify')
    args = parser.parse_args()
    try:
        if args.command == 'record':
            result = store(args.vault, json.loads(Path(args.input).read_text(encoding='utf-8')), args.actor, args.reason, args.id, args.expected_revision)
            print(result['decision_id'])
        elif args.command == 'export':
            print(export(args.vault))
        else:
            _, db = connect(args.vault)
            try:
                print('Verified chain head: ' + verify(db))
            finally:
                db.close()
    except (ValueError, TypeError, KeyError, OSError, sqlite3.Error):
        parser.exit(1, 'Decision operation failed. Check private input, approval reference, revision and history integrity.\n')


if __name__ == '__main__':
    main()

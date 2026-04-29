"""
One-shot cleanup: strip the legacy `[YYYY-MM-DD] Postponed: ` auto-prefix that
an older version of the postpone handler used to prepend to bill / template
notes. The user's actual note text (e.g. "Pay with Capital One") is preserved.

Run from the project root:
    python3 scripts/strip_postpone_notes.py            # dry run, prints diff
    python3 scripts/strip_postpone_notes.py --apply    # actually update
"""
import os
import re
import sqlite3
import sys

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'nsledger_migrated.db')
PATTERN = re.compile(
    r'^\s*\[\d{2,4}[-/]\d{2}[-/]\d{2,4}\]\s*Postponed:\s*',
    re.IGNORECASE,
)


def clean(notes: str) -> str:
    if not notes:
        return notes
    return PATTERN.sub('', notes).strip()


def main():
    apply = '--apply' in sys.argv
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    changes = []

    for table in ('recurring_templates', 'bills'):
        rows = db.execute(
            f"SELECT id, name, notes FROM {table} WHERE notes LIKE '%Postponed:%'"
        ).fetchall()
        for r in rows:
            new_notes = clean(r['notes'])
            if new_notes != (r['notes'] or ''):
                changes.append((table, r['id'], r['name'], r['notes'], new_notes))

    if not changes:
        print('No matching notes found. Nothing to do.')
        return

    print(f'Found {len(changes)} rows with the legacy prefix:')
    for t, rid, name, old, new in changes:
        print(f'  [{t} #{rid}] {name}')
        print(f'      old: {old!r}')
        print(f'      new: {new!r}')

    if not apply:
        print('\nDry run only. Re-run with --apply to update the database.')
        return

    for t, rid, _, _, new in changes:
        db.execute(f'UPDATE {t} SET notes=? WHERE id=?', (new, rid))
    db.commit()
    print(f'\nUpdated {len(changes)} rows.')


if __name__ == '__main__':
    main()

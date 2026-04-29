"""
One-shot cleanup: remove duplicate recurring bill instances within the same
month. The recurring generator's dedup check used to be too narrow — if a bill
existed twice with different bill_name_id values (one NULL, one set), the
generator could spawn a fresh duplicate every run.

Strategy: for each (user_id, name, month) group with more than one row, KEEP
the oldest UNPAID instance (or the only paid one if all but one is paid), and
DELETE the rest. Bills that are paid / marked-paid / postponed are preserved
as settled history — only true duplicates among them get removed.

Run from the project root:
    python3 scripts/dedup_recurring_bills.py            # dry run
    python3 scripts/dedup_recurring_bills.py --apply    # actually delete
"""
import os
import sqlite3
import sys

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'nsledger_migrated.db')


def state_score(b):
    """Lower = preferred to keep. Paid > marked-paid > pending > postponed > reminder."""
    if b['is_paid']:        return 0
    if b['is_marked_paid']: return 1
    if b['is_postponed']:   return 3
    if b['is_reminder']:    return 4
    return 2  # plain pending


def main():
    apply = '--apply' in sys.argv
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    rows = db.execute(
        'SELECT id, user_id, name, month, amount, due_date, paid_date, '
        '       is_paid, is_marked_paid, is_postponed, is_reminder, '
        '       paycheck_id, bill_name_id, template_id '
        'FROM bills WHERE is_template=0 AND month IS NOT NULL'
    ).fetchall()

    groups = {}
    for r in rows:
        key = (r['user_id'], (r['name'] or '').strip().lower(), r['month'])
        groups.setdefault(key, []).append(r)

    to_delete = []
    skipped_paid = 0
    for key, members in groups.items():
        if len(members) <= 1:
            continue
        # Sort: most-preferred state first, then oldest id (the original).
        ranked = sorted(members, key=lambda b: (state_score(b), b['id']))
        keeper = ranked[0]
        losers = ranked[1:]
        for l in losers:
            # Conservative rule: only delete losers that are CLEARLY redundant
            # generator output — pending, never touched. Skip any loser that's
            # paid / marked-paid / postponed; those are settled records and
            # touching them would change historical totals.
            if l['is_paid'] or l['is_marked_paid'] or l['is_postponed']:
                skipped_paid += 1
                continue
            to_delete.append((keeper, l))
    if skipped_paid:
        print(f'(Skipping {skipped_paid} duplicate rows that are paid/marked-paid/postponed — '
              f'historical settled records, left alone for safety.)\n')

    if not to_delete:
        print('No duplicate bill instances found.')
        return

    print(f'Found {len(to_delete)} duplicate rows to remove:')
    for keeper, loser in to_delete:
        print(f'  user={keeper["user_id"]:>3}  {keeper["name"]:<30}  {keeper["month"]}  '
              f'KEEP id={keeper["id"]} (paid={keeper["is_paid"]}, post={keeper["is_postponed"]})  '
              f'DELETE id={loser["id"]} (paid={loser["is_paid"]}, post={loser["is_postponed"]})')

    if not apply:
        print('\nDry run only. Re-run with --apply to delete the duplicates.')
        return

    for _, loser in to_delete:
        db.execute('DELETE FROM bills WHERE id=?', (loser['id'],))
    db.commit()
    print(f'\nDeleted {len(to_delete)} duplicate rows.')


if __name__ == '__main__':
    main()

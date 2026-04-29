"""
Sanity check: for a given month, list every recurring template and whether
it has a corresponding bill instance. Mirrors the logic in app.py's
generate_recurring() so the answer matches what the generator would produce.

Usage (from project root):
    python3 scripts/check_recurring_coverage.py                # checks current month
    python3 scripts/check_recurring_coverage.py 2026-05        # checks specific month
    python3 scripts/check_recurring_coverage.py 2026-05 --user 10
"""
import os
import sqlite3
import sys
from calendar import monthrange
from datetime import date

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'nsledger_migrated.db')

FREQ_MONTHS = {
    'monthly': 1, 'bimonthly': 2, 'quarterly': 3,
    'semiannual': 6, 'annual': 12,
}


def is_due_this_month(template, target_month):
    start = template['start_date']
    if start and target_month < start[:7]:
        return False
    freq = (template['frequency'] or 'monthly')
    n = FREQ_MONTHS.get(freq, 1)
    if n == 1:
        return True
    anchor = template['start_date'] or template['created_at']
    if not anchor:
        return True
    ay, am = int(anchor[:4]), int(anchor[5:7])
    ty, tm = int(target_month[:4]), int(target_month[5:7])
    diff = (ty - ay) * 12 + (tm - am)
    return diff >= 0 and diff % n == 0


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    month = args[0] if args else date.today().strftime('%Y-%m')
    user_filter = None
    if '--user' in sys.argv:
        i = sys.argv.index('--user')
        user_filter = int(sys.argv[i + 1])

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    # All templates
    where = ''
    params = []
    if user_filter is not None:
        where = ' WHERE user_id=?'
        params.append(user_filter)
    templates = db.execute(
        f'SELECT * FROM recurring_templates{where} ORDER BY user_id, name',
        params,
    ).fetchall()

    if not templates:
        print('No recurring templates found.')
        return

    # All bills in target month
    bill_rows = db.execute(
        'SELECT id, user_id, name, amount, due_date, paycheck_id, '
        '       template_id, bill_name_id, is_paid, is_postponed, is_reminder '
        'FROM bills WHERE is_template=0 AND month=?',
        (month,)
    ).fetchall()

    # All skips for that month
    skip_rows = db.execute(
        'SELECT user_id, bill_name_id, name FROM recurring_skips WHERE month=?',
        (month,)
    ).fetchall()
    skipped = {(s['user_id'], s['bill_name_id'], s['name']) for s in skip_rows}

    print(f'\n=== Recurring coverage for {month} ===\n')

    missing = []
    skipped_list = []
    extras = []
    matched_bill_ids = set()

    for t in templates:
        if not is_due_this_month(t, month):
            continue

        # Skip detection
        was_skipped = any(
            (s[0] == t['user_id']) and
            ((t['bill_name_id'] is not None and s[1] == t['bill_name_id']) or
             (t['bill_name_id'] is None and s[1] is None and s[2] == t['name']))
            for s in skipped
        )
        if was_skipped:
            skipped_list.append(t)
            continue

        # Match by template_id, bill_name_id, or name
        match = None
        for b in bill_rows:
            if b['user_id'] != t['user_id']:
                continue
            if b['template_id'] == t['id']:
                match = b; break
            if t['bill_name_id'] is not None and b['bill_name_id'] == t['bill_name_id']:
                match = b; break
            if (b['name'] or '').strip().lower() == (t['name'] or '').strip().lower():
                match = b; break

        if match:
            matched_bill_ids.add(match['id'])
        else:
            missing.append(t)

    # Bills that exist but don't trace back to any active template
    for b in bill_rows:
        if b['id'] in matched_bill_ids:
            continue
        # Bills without a template_id and not matching any template by name are "extras"
        traces = False
        for t in templates:
            if t['user_id'] != b['user_id']:
                continue
            if (b['template_id'] == t['id'] or
                (t['bill_name_id'] is not None and b['bill_name_id'] == t['bill_name_id']) or
                (b['name'] or '').strip().lower() == (t['name'] or '').strip().lower()):
                traces = True
                break
        if not traces:
            extras.append(b)

    if missing:
        print(f'❌ Missing ({len(missing)}) — recurring templates with no bill instance in {month}:')
        for t in missing:
            freq = t['frequency'] or 'monthly'
            print(f'   • [user {t["user_id"]}] {t["name"]:<35} ${float(t["amount"]):>9.2f}  '
                  f'day {t["due_day"] or "?":>2}  {freq}')
        print()
    else:
        print('✅ Every active recurring template has a bill instance.\n')

    if skipped_list:
        print(f'ℹ️  Skipped ({len(skipped_list)}) — templates the user told us to skip this month:')
        for t in skipped_list:
            print(f'   • [user {t["user_id"]}] {t["name"]}')
        print()

    if extras:
        print(f'⚠️  Untracked bills ({len(extras)}) — present in {month} but not tied to any recurring template:')
        for b in extras:
            paid_pill = 'paid' if b['is_paid'] else 'postponed' if b['is_postponed'] else 'pending'
            print(f'   • [user {b["user_id"]}] id={b["id"]}  {b["name"]:<35} ${float(b["amount"]):>9.2f}  ({paid_pill})')
        print('   (These might be one-off entries — Spending, Transfers, manual additions — '
              'or recurring bills whose template was deleted.)')
        print()

    print(f'Templates total: {len(templates)} | Bills in {month}: {len(bill_rows)}')


if __name__ == '__main__':
    main()

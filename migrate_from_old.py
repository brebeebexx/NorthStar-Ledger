"""
migrate_from_old.py
───────────────────
Migrates data from NorthStar_Ledger_Live (data-live.db)
into the new NorthStar_Ledger (nsledger.db).

Tables migrated:
  paychecks   (household_id=1  →  user_id of matched email)
  bills       (household_id=1)
  subscriptions (household_id=1)

Run:  python3 migrate_from_old.py
"""

import sqlite3
import shutil
import os
from datetime import date, timedelta

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE       = os.path.dirname(os.path.abspath(__file__))
OLD_DB     = os.path.join(BASE, '..', 'Websites', 'NorthStar_Ledger_Live', 'data-live.db')
NEW_DB     = os.path.join(BASE, 'nsledger.db')
BACKUP_DB  = NEW_DB + '.pre_migration_backup'
USER_EMAIL = 'brebeebexx@gmail.com'
OLD_HH_ID  = 1   # household_id in the old DB

# ── Frequency mapping ─────────────────────────────────────────────────────────
def map_frequency(timeframe, every_months):
    if timeframe == 'specified_months' and every_months:
        m = int(every_months)
        return {1:'monthly', 2:'bimonthly', 3:'quarterly', 6:'semiannual', 12:'annual'}.get(m, 'monthly')
    return 'monthly'  # default

# ── Next due date helper for subscriptions ────────────────────────────────────
def next_due_date(day_due):
    """Return the next YYYY-MM-DD for a given day-of-month."""
    today = date.today()
    try:
        d = date(today.year, today.month, int(day_due))
    except ValueError:
        # day_due > days in month (e.g. 31 in Feb) → use last day
        import calendar
        last = calendar.monthrange(today.year, today.month)[1]
        d = date(today.year, today.month, last)
    if d < today:
        # Already passed this month → next month
        year  = today.year + (today.month // 12)
        month = today.month % 12 + 1
        try:
            d = date(year, month, int(day_due))
        except ValueError:
            import calendar
            last = calendar.monthrange(year, month)[1]
            d = date(year, month, last)
    return d.isoformat()

# ─────────────────────────────────────────────────────────────────────────────
def run():
    # 1. Backup new DB
    print(f'Backing up {NEW_DB} → {BACKUP_DB}')
    shutil.copy2(NEW_DB, BACKUP_DB)
    print('Backup created.\n')

    old = sqlite3.connect(OLD_DB)
    old.row_factory = sqlite3.Row
    new = sqlite3.connect(NEW_DB)
    new.row_factory = sqlite3.Row

    # 2. Find user in new DB
    user = new.execute('SELECT id FROM users WHERE email=?', (USER_EMAIL,)).fetchone()
    if not user:
        print(f'ERROR: {USER_EMAIL} not found in new DB. Register first, then re-run.')
        old.close(); new.close(); return
    new_uid = user['id']
    print(f'Migrating data for user_id={new_uid} ({USER_EMAIL})\n')

    # 3. Optional: wipe existing test data
    existing_pc = new.execute('SELECT COUNT(*) FROM paychecks WHERE user_id=?', (new_uid,)).fetchone()[0]
    existing_bills = new.execute('SELECT COUNT(*) FROM bills WHERE user_id=?', (new_uid,)).fetchone()[0]
    existing_subs  = new.execute('SELECT COUNT(*) FROM subscriptions WHERE user_id=?', (new_uid,)).fetchone()[0]
    print(f'Existing data in new DB: {existing_pc} paychecks, {existing_bills} bills, {existing_subs} subscriptions')
    if existing_pc or existing_bills or existing_subs:
        ans = input('Clear existing data before migrating? (yes/no): ').strip().lower()
        if ans == 'yes':
            new.execute('DELETE FROM bills WHERE user_id=?', (new_uid,))
            new.execute('DELETE FROM paychecks WHERE user_id=?', (new_uid,))
            new.execute('DELETE FROM subscriptions WHERE user_id=?', (new_uid,))
            new.execute('DELETE FROM bill_names WHERE user_id=?', (new_uid,))
            new.execute('DELETE FROM balance_adjustments WHERE user_id=?', (new_uid,))
            new.commit()
            print('Existing data cleared.\n')
        else:
            print('Keeping existing data. Old data will be appended.\n')

    # 4. Migrate paychecks (household_id=1)
    old_pcs = old.execute(
        'SELECT * FROM paychecks WHERE household_id=? ORDER BY pay_date ASC', (OLD_HH_ID,)
    ).fetchall()

    pc_id_map = {}   # old paycheck id → new paycheck id
    pc_count = 0
    for p in old_pcs:
        notes = p['owner'] if p['owner'] else None   # 'Bre' / 'Tre' → notes field
        new.execute(
            'INSERT INTO paychecks (user_id, date, amount, notes) VALUES (?,?,?,?)',
            (new_uid, p['pay_date'], p['amount'], notes)
        )
        new_id = new.execute('SELECT last_insert_rowid()').fetchone()[0]
        pc_id_map[p['id']] = new_id
        pc_count += 1
    new.commit()
    print(f'✓ Migrated {pc_count} paychecks')

    # 5. Migrate bills (household_id=1, not deleted)
    old_bills = old.execute(
        'SELECT * FROM bills WHERE household_id=? AND deleted_at IS NULL ORDER BY due_date ASC',
        (OLD_HH_ID,)
    ).fetchall()

    # Build bill_names cache
    bill_name_cache = {}
    def get_bill_name_id(name):
        key = name.lower().strip()
        if key not in bill_name_cache:
            existing = new.execute(
                'SELECT id FROM bill_names WHERE user_id=? AND LOWER(name)=?', (new_uid, key)
            ).fetchone()
            if existing:
                bill_name_cache[key] = existing['id']
            else:
                new.execute('INSERT INTO bill_names (user_id, name, category) VALUES (?,?,?)',
                            (new_uid, name.strip(), 'bill'))
                bill_name_cache[key] = new.execute('SELECT last_insert_rowid()').fetchone()[0]
        return bill_name_cache[key]

    bill_count = 0
    for b in old_bills:
        # Map paycheck_bucket → new paycheck id
        new_pc_id = pc_id_map.get(b['paycheck_bucket']) if b['paycheck_bucket'] else None

        # Map frequency
        freq = map_frequency(b['recurring_timeframe'], b['recurring_every_months'])

        # Derive billing month from due_date
        month = b['due_date'][:7] if b['due_date'] else None

        bill_name_id = get_bill_name_id(b['name'])

        new.execute('''INSERT INTO bills
            (user_id, paycheck_id, bill_name_id, name, amount, due_date,
             planned_pay_date, is_paid, is_postponed, is_recurring, autopay,
             category, month, notes, paid_date, frequency)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (new_uid,
             new_pc_id,
             bill_name_id,
             b['name'],
             b['amount'],
             b['due_date'],
             b['planned_pay_date'],
             1 if b['paid'] else 0,
             0,                          # is_postponed — reset on migration
             1 if b['recurring'] else 0,
             1 if b['autopay'] else 0,
             b['category'] or 'bill',
             month,
             b['note'],
             b['paid_date'],
             freq)
        )
        bill_count += 1
    new.commit()
    print(f'✓ Migrated {bill_count} bills')

    # 6. Migrate subscriptions
    old_subs = old.execute(
        'SELECT * FROM subscriptions WHERE household_id=? AND deleted_at IS NULL',
        (OLD_HH_ID,)
    ).fetchall()

    sub_count = 0
    seen_sub_names = set()
    for s in old_subs:
        name = s['name'].strip()
        # Deduplicate by name (old DB had duplicates)
        if name.lower() in seen_sub_names:
            continue
        seen_sub_names.add(name.lower())

        ndd = next_due_date(s['day_due']) if s['day_due'] else None
        # Frequency
        every = s['recurring_every_months'] or 1
        unit = 'month'

        new.execute(
            'INSERT INTO subscriptions (user_id, name, amount, interval_count, interval_unit, next_due_date) VALUES (?,?,?,?,?,?)',
            (new_uid, name, s['payment'], every, unit, ndd)
        )
        sub_count += 1
    new.commit()
    print(f'✓ Migrated {sub_count} subscriptions (duplicates skipped)')

    old.close()
    new.close()

    print(f'''
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Migration complete!
  Paychecks:     {pc_count}
  Bills:         {bill_count}
  Subscriptions: {sub_count}

A backup of your original new DB was saved to:
  {BACKUP_DB}

Restart Flask and refresh the app.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━''')

if __name__ == '__main__':
    run()

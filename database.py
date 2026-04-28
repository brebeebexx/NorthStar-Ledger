import sqlite3
import os

DATABASE = os.path.join(os.path.dirname(__file__), 'nsledger_migrated.db')


def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    c = conn.cursor()

    # ── Users ────────────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        email         TEXT    UNIQUE NOT NULL,
        password_hash TEXT    NOT NULL,
        security_q1   TEXT    NOT NULL,
        security_a1   TEXT    NOT NULL,
        security_q2   TEXT    NOT NULL,
        security_a2   TEXT    NOT NULL,
        is_admin      INTEGER DEFAULT 0,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login    TIMESTAMP
    )''')

    # ── Paychecks ─────────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS paychecks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        date       TEXT    NOT NULL,
        amount     REAL    NOT NULL,
        notes      TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )''')

    # ── Bill names (shared name pool per user for linking & dropdown) ─────────
    c.execute('''CREATE TABLE IF NOT EXISTS bill_names (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id  INTEGER NOT NULL,
        name     TEXT    NOT NULL,
        category TEXT    DEFAULT 'bill',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, name)
    )''')

    # ── Bills ─────────────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS bills (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL,
        paycheck_id      INTEGER,
        bill_name_id     INTEGER,
        name             TEXT    NOT NULL,
        amount           REAL    NOT NULL,
        due_date         TEXT,
        planned_pay_date TEXT,
        is_paid          INTEGER DEFAULT 0,
        is_postponed     INTEGER DEFAULT 0,
        is_recurring     INTEGER DEFAULT 0,
        autopay          INTEGER DEFAULT 0,
        category         TEXT    DEFAULT 'bill',
        savings_goal_id  INTEGER,
        month            TEXT,
        notes            TEXT,
        paid_date        TEXT,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
        FOREIGN KEY (paycheck_id)     REFERENCES paychecks(id)     ON DELETE SET NULL,
        FOREIGN KEY (bill_name_id)    REFERENCES bill_names(id)    ON DELETE SET NULL,
        FOREIGN KEY (savings_goal_id) REFERENCES savings_goals(id) ON DELETE SET NULL
    )''')

    # ── Savings goals ─────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS savings_goals (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL,
        name           TEXT    NOT NULL,
        target_amount  REAL    NOT NULL,
        current_amount REAL    DEFAULT 0,
        target_date    TEXT,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )''')

    # ── Debt accounts ─────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS debt_accounts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,
        name            TEXT    NOT NULL,
        balance         REAL    DEFAULT 0,
        credit_limit    REAL,
        apr             REAL    DEFAULT 0,
        is_promo        INTEGER DEFAULT 0,
        promo_rate      REAL,
        promo_end_date  TEXT,
        account_type    TEXT    DEFAULT 'credit_card',
        monthly_payment REAL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )''')

    # ── Subscriptions ─────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS subscriptions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL,
        name           TEXT    NOT NULL,
        amount         REAL    NOT NULL,
        interval_count INTEGER DEFAULT 1,
        interval_unit  TEXT    DEFAULT 'month',
        next_due_date  TEXT,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )''')

    # ── Balance adjustments (reconcile to bank) ───────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS balance_adjustments (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL,
        paycheck_id       INTEGER NOT NULL,
        bank_balance      REAL    NOT NULL,
        adjustment_amount REAL    NOT NULL,
        adjustment_date   TEXT    NOT NULL,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE,
        FOREIGN KEY (paycheck_id) REFERENCES paychecks(id) ON DELETE CASCADE
    )''')

    # ── Deposits (positive entries inside a paycheck bucket) ─────────────────
    #    Used for "I transferred $X from savings to the bills account" — money
    #    going IN that isn't a paycheck. Adds to running balance, but does NOT
    #    count as income in any income totals.
    c.execute('''CREATE TABLE IF NOT EXISTS deposits (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        paycheck_id  INTEGER NOT NULL,
        amount       REAL    NOT NULL,
        deposit_date TEXT,
        notes        TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE,
        FOREIGN KEY (paycheck_id) REFERENCES paychecks(id) ON DELETE CASCADE
    )''')

    # ── Transactions (discretionary spending log) ────────────────────────────
    #    Tracks one-off purchases that aren't scheduled bills — Target runs,
    #    gas, dining out, etc. Lets you answer "where did this money go" for
    #    the spending the bills planner doesn't cover.
    c.execute('''CREATE TABLE IF NOT EXISTS transactions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        date       TEXT    NOT NULL,
        amount     REAL    NOT NULL,
        merchant   TEXT,
        category   TEXT,
        notes      TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )''')
    c.execute('''CREATE INDEX IF NOT EXISTS idx_transactions_user_date
                 ON transactions(user_id, date)''')

    # ── Help messages ─────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS help_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        subject    TEXT,
        message    TEXT    NOT NULL,
        status     TEXT    DEFAULT 'unread',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )''')

    # ── Admin: maintenance log ────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS maintenance_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        category    TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT,
        status      TEXT DEFAULT 'open',
        stage       TEXT DEFAULT 'testing',
        version     TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # ── Sticky notes ─────────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS sticky_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        title      TEXT,
        content    TEXT    NOT NULL,
        color      TEXT    DEFAULT 'yellow',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )''')

    # ── Admin: versions ───────────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS versions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        version_number TEXT NOT NULL,
        release_date   TEXT,
        notes          TEXT,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # ── Admin: iOS releases ───────────────────────────────────────────────────
    c.execute('''CREATE TABLE IF NOT EXISTS ios_releases (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        version      TEXT NOT NULL,
        release_date TEXT,
        notes        TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL,
        month          TEXT    NOT NULL,
        total_debt     REAL    DEFAULT 0,
        total_savings  REAL    DEFAULT 0,
        net_worth      REAL    DEFAULT 0,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, month)
    )''')

    # ── Recurring skips (months the user explicitly removed a recurring bill) ─
    #    Blocks generate_recurring from re-creating an instance the user deleted
    #    via "Remove from this month only". bill_name_id OR name must be set
    #    depending on whether the recurring bill is template-backed or legacy.
    c.execute('''CREATE TABLE IF NOT EXISTS recurring_skips (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        bill_name_id INTEGER,
        name         TEXT,
        month        TEXT NOT NULL,  -- 'YYYY-MM'
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id)      REFERENCES users(id)      ON DELETE CASCADE,
        FOREIGN KEY (bill_name_id) REFERENCES bill_names(id) ON DELETE CASCADE
    )''')
    c.execute('''CREATE INDEX IF NOT EXISTS idx_recurring_skips_lookup
                 ON recurring_skips(user_id, month, bill_name_id, name)''')

    # ── Recurring templates (canonical definitions, separate from instances) ──
    c.execute('''CREATE TABLE IF NOT EXISTS recurring_templates (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        amount       REAL    NOT NULL DEFAULT 0,
        due_day      INTEGER,
        frequency    TEXT    DEFAULT 'monthly',
        autopay      INTEGER DEFAULT 0,
        category     TEXT    DEFAULT 'bill',
        bill_name_id INTEGER,
        notes        TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id)      REFERENCES users(id)      ON DELETE CASCADE,
        FOREIGN KEY (bill_name_id) REFERENCES bill_names(id) ON DELETE SET NULL
    )''')

    # ── Migrations: add columns added after initial schema ────────────────────
    for col, definition in [
        ('autopay',   'INTEGER DEFAULT 0'),
        ('paid_date', 'TEXT'),
        ('frequency', "TEXT DEFAULT 'monthly'"),
        ('is_template', 'INTEGER DEFAULT 0'),
    ]:
        try:
            c.execute(f'ALTER TABLE bills ADD COLUMN {col} {definition}')
        except Exception:
            pass  # column already exists

    # Link bill instances back to their recurring_template
    try:
        c.execute('ALTER TABLE bills ADD COLUMN template_id INTEGER REFERENCES recurring_templates(id) ON DELETE SET NULL')
    except Exception:
        pass

    # Link subscription-generated bill instances back to their subscription
    try:
        c.execute('ALTER TABLE bills ADD COLUMN subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL')
    except Exception:
        pass

    # Paid (submitted) but not yet cleared from bank — intermediate state before Deducted
    try:
        c.execute('ALTER TABLE bills ADD COLUMN is_marked_paid INTEGER DEFAULT 0')
    except Exception:
        pass

    # Reminder mode: bill exists for visual check-in only (e.g. paid-off credit
    # card you still want to monitor monthly). When set, the bill doesn't
    # subtract from running balance; UI shows it as a "Review" task.
    try:
        c.execute('ALTER TABLE bills ADD COLUMN is_reminder INTEGER DEFAULT 0')
    except Exception:
        pass
    try:
        c.execute('ALTER TABLE recurring_templates ADD COLUMN is_reminder INTEGER DEFAULT 0')
    except Exception:
        pass

    # Deposit completion: a deposit can be planned (pending) or actually done
    # (complete). When complete, the row is shaded differently and sorted by
    # the day it was actually executed instead of the originally-planned date.
    try:
        c.execute('ALTER TABLE deposits ADD COLUMN is_complete INTEGER DEFAULT 0')
    except Exception:
        pass
    try:
        c.execute('ALTER TABLE deposits ADD COLUMN completed_date TEXT')
    except Exception:
        pass

    # Start date for recurring templates — bills won't generate before this month
    try:
        c.execute('ALTER TABLE recurring_templates ADD COLUMN start_date TEXT')
    except Exception:
        pass

    # Add deleted_at to users for soft deletes
    try:
        c.execute('ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP')
    except Exception:
        pass

    # Paychecks: income type (paycheck vs bonus/extra)
    try:
        c.execute("ALTER TABLE paychecks ADD COLUMN income_type TEXT DEFAULT 'paycheck'")
    except Exception:
        pass

    # Debt account extra fields
    for col, defn in [
        ('status',           "TEXT DEFAULT 'balance'"),
        ('promo_start_date', 'TEXT'),
        ('end_date',         'TEXT'),
        ('notes',            'TEXT'),
    ]:
        try:
            c.execute(f'ALTER TABLE debt_accounts ADD COLUMN {col} {defn}')
        except Exception:
            pass

    # ── Cleanup: remove duplicate recurring_templates, keep lowest id per (user_id, name) ──
    c.execute('''
        DELETE FROM recurring_templates
        WHERE id NOT IN (
            SELECT MIN(id) FROM recurring_templates GROUP BY user_id, name
        )
    ''')

    # ── (DISABLED) Auto-migration: populate recurring_templates from is_recurring=1 bills
    #
    # This used to run on every Flask startup and re-create a template for any
    # bill (including paid history rows) that still had is_recurring=1. That
    # silently undid "Stop recurring entirely" — the user would stop a bill,
    # restart Flask, and the template would come right back because old paid
    # history still had is_recurring=1 set.
    #
    # The migration was a one-time onboarding step. It's no longer needed:
    # templates are created explicitly by user actions (Add Bill with the
    # recurring toggle, or via /api/recurring-templates POST). Leaving the
    # block disabled preserves history bills' is_recurring flag without
    # using it as a regeneration source.
    pass  # auto-template-from-bills migration intentionally removed

    # ── Cleanup: fix bills where month doesn't match due_date's year-month ──────
    # Idempotent — safe to run on every startup.
    c.execute('''
        UPDATE bills
        SET month = substr(due_date, 1, 7)
        WHERE due_date IS NOT NULL
          AND length(due_date) >= 7
          AND month IS NOT NULL
          AND month != substr(due_date, 1, 7)
    ''')

    conn.commit()
    conn.close()
    print("Database initialised.")


if __name__ == '__main__':
    init_db()

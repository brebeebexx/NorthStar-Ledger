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

    # ── Migrations: add columns added after initial schema ────────────────────
    for col, definition in [
        ('autopay',   'INTEGER DEFAULT 0'),
        ('paid_date', 'TEXT'),
        ('frequency', "TEXT DEFAULT 'monthly'"),
    ]:
        try:
            c.execute(f'ALTER TABLE bills ADD COLUMN {col} {definition}')
        except Exception:
            pass  # column already exists

    # Add deleted_at to users for soft deletes
    try:
        c.execute('ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP')
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

    conn.commit()
    conn.close()
    print("Database initialised.")


if __name__ == '__main__':
    init_db()

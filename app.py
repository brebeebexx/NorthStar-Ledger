import os, sqlite3, calendar, secrets, json, shutil, io, time
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
from flask import Flask, render_template, request, redirect, session, url_for, Response, jsonify
from werkzeug.security import generate_password_hash, check_password_hash

APP_SECRET = os.getenv("APP_SECRET", "dev-secret-change-me")
SHARED_PASSCODE = os.getenv("SHARED_PASSCODE", "1234")
APP_NAME = os.getenv("APP_NAME", "NorthStar Ledger")
SIGNUP_MODE = os.getenv("SIGNUP_MODE", "open").strip().lower()  # open|allowlist|closed
ALLOWLIST_EMAILS = {e.strip().lower() for e in os.getenv("ALLOWLIST_EMAILS", "").split(",") if e.strip()}
ENABLE_SHARED_PASSCODE_LOGIN = os.getenv("ENABLE_SHARED_PASSCODE_LOGIN", "false").strip().lower() in ("1", "true", "yes", "on")
DB = os.getenv("DB_PATH", "data.db")
APP_PORT = int(os.getenv("APP_PORT", "5055"))
APP_HOST = os.getenv("APP_HOST", "127.0.0.1")
APP_TZ = os.getenv("APP_TZ", "America/New_York")

SECURITY_QUESTIONS = [
    "What was the name of your first pet?",
    "What city were you born in?",
    "What was your childhood nickname?",
    "What was the first concert you attended?",
    "What is your mother's maiden name?",
    "What was the make of your first car?",
    "What was the name of your elementary school?",
    "What is your favorite teacher's last name?",
    "What street did you grow up on?",
    "What was your first job title?",
]

THEMES = {
    "slate": {
        "pink": "#6b7280", "pink_dark": "#374151", "line": "#d1d5db",
        "tint_soft": "#f3f4f6", "tint_mid": "#e5e7eb", "panel_bg": "#f9fafb",
    },
    "pink": {
        "pink": "#ff4fa3", "pink_dark": "#d63384", "line": "#ffd1e8",
        "tint_soft": "#ffe3f1", "tint_mid": "#efbfdc", "panel_bg": "#f6d7e8",
    },
    "blue": {
        "pink": "#7dbdff", "pink_dark": "#3b82c4", "line": "#d7ebff",
        "tint_soft": "#eaf5ff", "tint_mid": "#cde6ff", "panel_bg": "#dff0ff",
    },
    "purple": {
        "pink": "#b085ff", "pink_dark": "#7c4dcb", "line": "#e9ddff",
        "tint_soft": "#f2ebff", "tint_mid": "#dccbff", "panel_bg": "#e9dcff",
    },
    "red": {
        "pink": "#ff6f73", "pink_dark": "#c93d42", "line": "#ffdada",
        "tint_soft": "#ffeded", "tint_mid": "#ffd0d1", "panel_bg": "#ffe3e3",
    },
}

app = Flask(__name__)
app.secret_key = APP_SECRET
cookie_secure_default = False if APP_HOST in ("127.0.0.1", "localhost") else True
cookie_secure = os.getenv("SESSION_COOKIE_SECURE", "true" if cookie_secure_default else "false").strip().lower() in ("1", "true", "yes", "on")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=cookie_secure,
    PERMANENT_SESSION_LIFETIME=60*60*12,
)


def fmt_date(value):
    if not value:
        return ""
    s = str(value)
    for src, dst in (("%Y-%m-%d", "%m-%d-%Y"), ("%Y-%m", "%m-%Y")):
        try:
            return datetime.strptime(s, src).strftime(dst)
        except Exception:
            pass
    return s


def is_postponed_note(note_value):
    txt = (note_value or "")
    return "postponed" in txt.lower()


def fmt_money(value, decimals=2):
    try:
        n = float(value or 0)
    except Exception:
        n = 0.0
    return f"{n:,.{int(decimals)}f}"


@app.context_processor
def inject_formatters():
    return {
        "fmt_money": fmt_money,
    }


def fmt_month_label(value):
    if not value:
        return ""
    s = str(value)
    try:
        return datetime.strptime(s, "%Y-%m").strftime("%B %Y")
    except Exception:
        return s


def get_csrf_token():
    tok = session.get("csrf_token")
    if not tok:
        tok = secrets.token_urlsafe(24)
        session["csrf_token"] = tok
    return tok


@app.context_processor
def inject_helpers():
    return {"fmt_date": fmt_date, "fmt_month_label": fmt_month_label, "csrf_token": get_csrf_token(), "app_name": APP_NAME, "security_questions": SECURITY_QUESTIONS}


@app.before_request
def csrf_protect():
    if request.method != "POST":
        return

    # Mobile JSON API and Notes JSON API use session auth + JSON bodies (no form _csrf field).
    if request.path.startswith('/api/mobile/') or request.path.startswith('/api/notes'):
        return

    ep = (request.endpoint or "")
    exempt = {"login", "signup", "forgot_password", "reset_password", "reset_password_security"}
    if ep in exempt:
        return
    sent = request.form.get("_csrf", "")
    if not sent or sent != session.get("csrf_token"):
        return ("Invalid or missing CSRF token.", 400)

    # Role-based write protection for app POST routes.
    if ep and authed():
        owner_only = {"household_invite"}
        c = conn()
        role = member_role(c)
        c.close()
        if ep in owner_only and role != "owner":
            return ("Forbidden: owner role required", 403)
        if role not in ("owner", "editor"):
            return ("Forbidden: editor or owner role required", 403)


def conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def ensure_column(c, table, col, ddl):
    cols = [r[1] for r in c.execute(f"pragma table_info({table})").fetchall()]
    if col not in cols:
        c.execute(f"alter table {table} add column {ddl}")


def init_db():
    c = conn()
    c.executescript(
        """
        create table if not exists bills(
          id integer primary key,
          name text not null,
          due_date text not null,
          amount real not null,
          paid integer default 0
        );
        create table if not exists paychecks(
          id integer primary key,
          owner text not null,
          pay_date text not null,
          amount real not null
        );
        create table if not exists ledger(
          id integer primary key,
          tx_date text not null,
          label text not null,
          amount real not null,
          note text
        );
        create table if not exists trips(
          id integer primary key,
          name text not null,
          due_month text not null,
          target real not null,
          saved real not null default 0
        );
        create table if not exists promotions(
          id integer primary key,
          card_name text not null,
          promo_name text not null,
          start_date text,
          end_date text not null,
          balance real not null default 0,
          note text
        );
        create table if not exists subscriptions(
          id integer primary key,
          name text not null,
          day_due integer not null,
          payment real not null default 0
        );
        create table if not exists credit_accounts(
          id integer primary key,
          card_name text not null,
          interest_rate real not null default 0,
          credit_limit real not null default 0,
          household_id integer,
          deleted_at text,
          deleted_by integer
        );
        create table if not exists loans(
          id integer primary key,
          loan_name text not null,
          interest_rate real not null default 0,
          loan_amount real not null default 0,
          paid_off integer default 0,
          household_id integer,
          deleted_at text,
          deleted_by integer
        );
        create table if not exists settings(
          key text primary key,
          value text not null
        );
        create table if not exists users(
          id integer primary key,
          email text not null unique,
          password_hash text not null,
          created_at text not null,
          last_login_at text
        );
        create table if not exists households(
          id integer primary key,
          name text not null,
          created_by_user_id integer,
          created_at text not null
        );
        create table if not exists household_members(
          id integer primary key,
          household_id integer not null,
          user_id integer not null,
          role text not null default 'owner',
          invited_by integer,
          joined_at text not null,
          unique(household_id, user_id)
        );
        create table if not exists login_attempts(
          id integer primary key,
          ip text not null,
          ts integer not null
        );
        create table if not exists password_resets(
          id integer primary key,
          email text not null,
          token text not null unique,
          expires_at text not null,
          used integer default 0,
          created_at text not null
        );
        create table if not exists household_invites(
          id integer primary key,
          household_id integer not null,
          email text not null,
          role text not null default 'viewer',
          token text not null unique,
          expires_at text not null,
          accepted_at text,
          created_by_user_id integer,
          created_at text not null
        );
        create table if not exists audit_log(
          id integer primary key,
          household_id integer not null,
          user_id integer,
          entity text not null,
          entity_id text,
          action text not null,
          before_json text,
          after_json text,
          created_at text not null
        );
        create table if not exists paycheck_rules(
          id integer primary key,
          owner text not null,
          amount real not null,
          cadence text not null default 'biweekly',
          next_date text not null,
          active integer default 1
        );
        create table if not exists categories(
          id integer primary key,
          name text not null unique
        );
        create table if not exists household_categories(
          id integer primary key,
          household_id integer not null,
          name text not null,
          unique(household_id, name)
        );
        create table if not exists dashboard_notes(
          id integer primary key,
          household_id integer not null unique,
          note_text text,
          updated_at text
        );
        create table if not exists household_notes(
          id integer primary key,
          household_id integer not null,
          text text not null,
          color text not null default '#FFF9C4',
          created_at text not null
        );
        """
    )
    ensure_column(c, "bills", "category", "category text default 'bill'")
    ensure_column(c, "bills", "recurring", "recurring integer default 1")
    ensure_column(c, "bills", "autopay", "autopay integer default 0")
    ensure_column(c, "bills", "paycheck_bucket", "paycheck_bucket integer")
    ensure_column(c, "bills", "paid_date", "paid_date text")
    ensure_column(c, "bills", "planned_pay_date", "planned_pay_date text")
    ensure_column(c, "bills", "household_id", "household_id integer")
    ensure_column(c, "bills", "deleted_at", "deleted_at text")
    ensure_column(c, "bills", "deleted_by", "deleted_by integer")
    ensure_column(c, "bills", "recurring_timeframe", "recurring_timeframe text default 'monthly'")
    ensure_column(c, "bills", "recurring_every_months", "recurring_every_months integer")
    ensure_column(c, "bills", "recurring_end_date", "recurring_end_date text")
    ensure_column(c, "bills", "note", "note text")
    ensure_column(c, "bills", "snap_balance", "snap_balance real")
    ensure_column(c, "paychecks", "income_type", "income_type text default 'paycheck'")
    ensure_column(c, "paychecks", "household_id", "household_id integer")
    ensure_column(c, "ledger", "household_id", "household_id integer")
    ensure_column(c, "trips", "household_id", "household_id integer")
    ensure_column(c, "trips", "deleted_at", "deleted_at text")
    ensure_column(c, "trips", "deleted_by", "deleted_by integer")
    ensure_column(c, "promotions", "completed", "completed integer default 0")
    ensure_column(c, "promotions", "household_id", "household_id integer")
    ensure_column(c, "promotions", "deleted_at", "deleted_at text")
    ensure_column(c, "promotions", "deleted_by", "deleted_by integer")
    ensure_column(c, "credit_accounts", "paid_off", "paid_off integer default 0")
    ensure_column(c, "credit_accounts", "household_id", "household_id integer")
    ensure_column(c, "credit_accounts", "deleted_at", "deleted_at text")
    ensure_column(c, "credit_accounts", "deleted_by", "deleted_by integer")
    ensure_column(c, "loans", "paid_off", "paid_off integer default 0")
    ensure_column(c, "loans", "household_id", "household_id integer")
    ensure_column(c, "loans", "deleted_at", "deleted_at text")
    ensure_column(c, "loans", "deleted_by", "deleted_by integer")
    ensure_column(c, "loans", "note", "note text")
    ensure_column(c, "loans", "end_date", "end_date text")
    ensure_column(c, "paycheck_rules", "household_id", "household_id integer")
    ensure_column(c, "paycheck_rules", "day_of_month", "day_of_month integer")
    ensure_column(c, "paycheck_rules", "timeframe", "timeframe text default 'monthly'")
    ensure_column(c, "paycheck_rules", "months_mask", "months_mask text")
    ensure_column(c, "subscriptions", "household_id", "household_id integer")
    ensure_column(c, "subscriptions", "deleted_at", "deleted_at text")
    ensure_column(c, "subscriptions", "deleted_by", "deleted_by integer")
    ensure_column(c, "subscriptions", "recurring", "recurring integer default 1")
    ensure_column(c, "subscriptions", "recurring_timeframe", "recurring_timeframe text default 'monthly'")
    ensure_column(c, "subscriptions", "recurring_every_months", "recurring_every_months integer")
    ensure_column(c, "subscriptions", "yearly_month", "yearly_month integer")
    ensure_column(c, "subscriptions", "start_month", "start_month text")
    ensure_column(c, "users", "tour_seen", "tour_seen integer default 0")
    ensure_column(c, "users", "security_q1", "security_q1 text")
    ensure_column(c, "users", "security_a1_hash", "security_a1_hash text")
    ensure_column(c, "users", "security_q2", "security_q2 text")
    ensure_column(c, "users", "security_a2_hash", "security_a2_hash text")
    ensure_column(c, "users", "is_admin", "is_admin integer default 0")

    c.executescript("""
        create table if not exists update_log (
            id integer primary key,
            version text not null,
            title text not null,
            body text,
            created_at text not null
        );
        create table if not exists site_banner (
            id integer primary key,
            enabled integer not null default 0,
            text text not null default '',
            start_date text,
            end_date text,
            updated_at text not null
        );
        create table if not exists feedback (
            id integer primary key,
            user_id integer,
            household_id integer,
            subject text not null default '',
            message text not null,
            feedback_type text not null default 'feedback',
            is_read integer not null default 0,
            created_at text not null
        );
    """)
    ensure_column(c, "site_banner", "start_date", "start_date text")
    ensure_column(c, "feedback", "feedback_type", "feedback_type text not null default 'feedback'")
    ensure_column(c, "site_banner", "end_date", "end_date text")
    c.executescript("""
        create table if not exists banner_history (
            id integer primary key,
            text text not null,
            start_date text,
            end_date text,
            saved_at text not null
        );
    """)
    c.execute("insert or ignore into site_banner(id,enabled,text,updated_at) values(1,0,'',?)",
              (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),))

    # defaults
    c.execute("insert or ignore into settings(key,value) values('starting_balance','0')")
    c.execute("insert or ignore into settings(key,value) values('min_buffer','150')")
    c.execute("insert or ignore into settings(key,value) values('accent_theme','blue')")
    c.execute("insert or ignore into categories(name) values('bill')")
    c.execute("insert or ignore into categories(name) values('debt')")
    c.execute("insert or ignore into categories(name) values('trip')")
    c.execute("insert or ignore into categories(name) values('savings')")
    c.execute("insert or ignore into categories(name) values('expense')")

    # Phase 1 bootstrap: create default household and attach existing records.
    c.execute(
        "insert or ignore into households(id,name,created_by_user_id,created_at) values(1,'Default Household',null,?)",
        (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),),
    )
    c.execute("update bills set household_id=1 where household_id is null")
    c.execute("update paychecks set household_id=1 where household_id is null")
    c.execute("update ledger set household_id=1 where household_id is null")
    c.execute("update trips set household_id=1 where household_id is null")
    c.execute("update promotions set household_id=1 where household_id is null")
    c.execute("update credit_accounts set household_id=1 where household_id is null")
    c.execute("update loans set household_id=1 where household_id is null")
    c.execute("update paycheck_rules set household_id=1 where household_id is null")
    c.execute("update subscriptions set household_id=1 where household_id is null")

    c.execute("insert or ignore into household_categories(household_id,name) values(1,'bill')")
    c.execute("insert or ignore into household_categories(household_id,name) values(1,'debt')")
    c.execute("insert or ignore into household_categories(household_id,name) values(1,'trip')")
    c.execute("insert or ignore into household_categories(household_id,name) values(1,'savings')")
    c.execute("insert or ignore into household_categories(household_id,name) values(1,'expense')")
    c.execute("insert or ignore into settings(key,value) values(?,?)", (setting_key(1, 'starting_balance'), '0'))
    c.execute("insert or ignore into settings(key,value) values(?,?)", (setting_key(1, 'min_buffer'), '150'))
    c.execute("insert or ignore into settings(key,value) values(?,?)", (setting_key(1, 'accent_theme'), 'blue'))

    # Migrate any existing single dashboard note into household_notes (one-time)
    migrated = c.execute("select value from settings where key='notes_migrated_v1'").fetchone()
    if not migrated:
        old_notes = c.execute("select household_id, note_text, updated_at from dashboard_notes where note_text is not null and note_text != ''").fetchall()
        for row in old_notes:
            c.execute(
                "insert into household_notes(household_id, text, color, created_at) values(?,?,?,?)",
                (row['household_id'], row['note_text'], '#FFF9C4', row['updated_at'] or datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
            )
        c.execute("insert into settings(key,value) values('notes_migrated_v1','1') on conflict(key) do nothing")

    c.commit()
    c.close()


def setting_key(household_id, key):
    return f"h{int(household_id)}:{key}"


def get_setting(c, key, default="0", household_id=1):
    scoped = setting_key(household_id, key)
    r = c.execute("select value from settings where key=?", (scoped,)).fetchone()
    if r:
        return r["value"]
    r2 = c.execute("select value from settings where key=?", (key,)).fetchone()
    return r2["value"] if r2 else default


def authed():
    return session.get("ok") is True

def is_admin_user(c=None):
    uid = current_user_id()
    if not uid:
        return False
    close = False
    if c is None:
        c = conn(); close = True
    row = c.execute("select is_admin from users where id=?", (uid,)).fetchone()
    if close: c.close()
    return bool(row and row["is_admin"])


def api_error(message, status=400):
    return jsonify({"ok": False, "error": message}), status


def active_household_id():
    try:
        return int(session.get("household_id", 1) or 1)
    except Exception:
        return 1


def current_user_id():
    try:
        return int(session.get("user_id", 0) or 0)
    except Exception:
        return 0


def member_role(c, household_id=None, user_id=None):
    household_id = household_id or active_household_id()
    user_id = user_id or current_user_id()
    if not user_id:
        return "owner"
    row = c.execute("select role from household_members where household_id=? and user_id=? order by id limit 1", (household_id, user_id)).fetchone()
    return row["role"] if row else "viewer"


def require_owner_or_editor():
    if not authed():
        return redirect(url_for("login"))
    c = conn()
    role = member_role(c)
    c.close()
    if role not in ("owner", "editor"):
        return ("Forbidden: editor or owner role required", 403)
    return None


def require_owner():
    if not authed():
        return redirect(url_for("login"))
    c = conn()
    role = member_role(c)
    c.close()
    if role != "owner":
        return ("Forbidden: owner role required", 403)
    return None


def audit_event(c, entity, action, entity_id=None, before=None, after=None):
    c.execute(
        "insert into audit_log(household_id,user_id,entity,entity_id,action,before_json,after_json,created_at) values(?,?,?,?,?,?,?,?)",
        (
            active_household_id(),
            current_user_id() or None,
            entity,
            str(entity_id) if entity_id is not None else None,
            action,
            json.dumps(before, default=str) if before is not None else None,
            json.dumps(after, default=str) if after is not None else None,
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        ),
    )


def redirect_dashboard_from_form(form):
    month = normalize_month(form.get("month", datetime.now().strftime("%Y-%m")))
    view = form.get("view", "paycheck")
    page = form.get("page", "dashboard")
    params = {
        "month": month,
        "view": view,
        "page": page,
        "r": int(datetime.now().timestamp() * 1000),
    }
    if str(form.get("settings", "")).lower() in ("1", "true", "on", "yes"):
        params["settings"] = "1"
    settings_tab = (form.get("settings_tab", "") or "").strip()
    if settings_tab:
        params["settings_tab"] = settings_tab
    target = url_for("dashboard", **params)
    anchor = (form.get("anchor", "") or "").strip().lstrip("#")
    if anchor:
        target = f"{target}#{anchor}"
    return redirect(target)


def local_now():
    try:
        return datetime.now(ZoneInfo(APP_TZ))
    except Exception:
        return datetime.now()


def normalize_month(value):
    try:
        return datetime.strptime(value, "%Y-%m").strftime("%Y-%m")
    except Exception:
        return local_now().strftime("%Y-%m")


def month_prev_next(ym):
    dt = datetime.strptime(ym + "-01", "%Y-%m-%d")
    if dt.month == 1:
        prev_m = f"{dt.year-1}-12"
    else:
        prev_m = f"{dt.year}-{dt.month-1:02d}"
    if dt.month == 12:
        next_m = f"{dt.year+1}-01"
    else:
        next_m = f"{dt.year}-{dt.month+1:02d}"
    return prev_m, next_m


def add_days(date_str, days):
    d = datetime.strptime(date_str, "%Y-%m-%d")
    from datetime import timedelta
    return (d + timedelta(days=days)).strftime("%Y-%m-%d")


def _days_in_month(year, month):
    import calendar
    return calendar.monthrange(year, month)[1]


def _date_for_month_day(ym, day_of_month):
    y, m = [int(x) for x in ym.split('-')]
    day = max(1, min(int(day_of_month or 1), _days_in_month(y, m)))
    return f"{y:04d}-{m:02d}-{day:02d}"


def _next_month(ym):
    _, nxt = month_prev_next(ym)
    return nxt


def apply_paycheck_rules_for_month(c, household_id, target_month):
    start = target_month + '-01'
    _, next_month = month_prev_next(target_month)
    end = next_month + '-01'
    target_year = int(target_month.split('-')[0])
    target_mon = int(target_month.split('-')[1])

    rules = c.execute('select * from paycheck_rules where household_id=? and active=1', (household_id,)).fetchall()
    for r in rules:
        timeframe = (r['timeframe'] or 'monthly').strip().lower()
        if timeframe not in ('monthly', 'yearly', 'specified_months'):
            timeframe = 'monthly'

        allowed = True
        if timeframe == 'yearly':
            base = (r['next_date'] or '')[:7]
            try:
                base_mon = int(base.split('-')[1])
            except Exception:
                base_mon = target_mon
            allowed = (target_mon == base_mon)
        elif timeframe == 'specified_months':
            mask = (r['months_mask'] or '').strip()
            selected = set()
            for part in mask.split(','):
                part = part.strip()
                if part.isdigit():
                    m = int(part)
                    if 1 <= m <= 12:
                        selected.add(m)
            allowed = (target_mon in selected) if selected else False

        if not allowed:
            continue

        cadence = (r['cadence'] or '').strip().lower()
        if cadence == 'specified_day':
            dom = int(r['day_of_month'] or 1)
            pay_date = _date_for_month_day(target_month, dom)
            exists = c.execute('select 1 from paychecks where household_id=? and owner=? and pay_date=? and amount=?', (household_id, r['owner'], pay_date, r['amount'])).fetchone()
            if not exists:
                c.execute('insert into paychecks(owner,pay_date,amount,income_type,household_id) values(?,?,?,?,?)', (r['owner'], pay_date, r['amount'], 'paycheck', household_id))
            c.execute('update paycheck_rules set next_date=? where id=? and household_id=?', (_date_for_month_day(_next_month(target_month), dom), r['id'], household_id))
            continue

        d = r['next_date']
        step = 14 if cadence == 'biweekly' else (7 if cadence == 'weekly' else 30)
        guard = 0
        while d < end and guard < 30:
            if d >= start:
                exists = c.execute('select 1 from paychecks where household_id=? and owner=? and pay_date=? and amount=?', (household_id, r['owner'], d, r['amount'])).fetchone()
                if not exists:
                    c.execute('insert into paychecks(owner,pay_date,amount,income_type,household_id) values(?,?,?,?,?)', (r['owner'], d, r['amount'], 'paycheck', household_id))
            d = add_days(d, step)
            guard += 1
        c.execute('update paycheck_rules set next_date=? where id=? and household_id=?', (d, r['id'], household_id))


def get_month_starting_balance(c, month, household_id=1):
    def _compute(m, depth=0):
        if depth > 24:
            return float(get_setting(c, "starting_balance", "0", household_id) or 0)

        specific_key = setting_key(household_id, f"starting_balance:{m}")
        r = c.execute("select value from settings where key=?", (specific_key,)).fetchone()
        if r is not None:
            try:
                return float(r["value"])
            except Exception:
                pass

        prev_month, _ = month_prev_next(m)
        prev_start = _compute(prev_month, depth + 1)
        prev_income = c.execute(
            "select coalesce(sum(amount),0) s from paychecks where household_id=? and substr(pay_date,1,7)=?",
            (household_id, prev_month),
        ).fetchone()["s"]
        prev_bills = c.execute(
            "select coalesce(sum(amount),0) s from bills where household_id=? and deleted_at is null and substr(due_date,1,7)=? and lower(coalesce(note,'')) not like '%postponed%' and coalesce(category,'bill') != 'adjustment'",
            (household_id, prev_month),
        ).fetchone()["s"]
        return float(prev_start) + float(prev_income) - float(prev_bills)

    return _compute(month)


def projected_checkbook(c, month, household_id=1, carryover_bill_ids=None, start_delta=0.0):
    carryover_bill_ids = set(carryover_bill_ids or [])
    starting = get_month_starting_balance(c, month, household_id) + float(start_delta or 0)
    min_buffer = float(get_setting(c, "min_buffer", "150", household_id) or 150)
    events = [("0000-00-00", "Starting Balance", starting)]

    for p in c.execute("select pay_date, owner, amount from paychecks where household_id=? and substr(pay_date,1,7)=? order by pay_date, id", (household_id, month)).fetchall():
        events.append((p["pay_date"], f"Paycheck ({p['owner']})", float(p["amount"])))

    unpaid = c.execute("select id, due_date, planned_pay_date, name, amount, note from bills where household_id=? and deleted_at is null and paid=0 and substr(due_date,1,7)=? and lower(coalesce(note,'')) not like '%postponed%' order by due_date, id", (household_id, month)).fetchall()
    for b in unpaid:
        if int(b["id"]) in carryover_bill_ids:
            continue
        event_date = (b["planned_pay_date"] or b["due_date"])
        events.append((event_date, b["name"], -abs(float(b["amount"]))))



    events.sort(key=lambda x: x[0])
    running = 0.0
    timeline = []
    first_negative = None
    first_below_buffer = None
    for d, label, amt in events:
        running += amt
        timeline.append((d, label, amt, running))
        is_real_event = not (d == "0000-00-00" or label == "Starting Balance")
        if is_real_event and first_negative is None and running < 0:
            first_negative = (d, label, running)
        if is_real_event and first_below_buffer is None and running < min_buffer:
            first_below_buffer = (d, label, running)

    return {
        "starting": starting,
        "min_buffer": min_buffer,
        "timeline": timeline,
        "first_negative": first_negative,
        "first_below_buffer": first_below_buffer,
    }


def assign_paycheck_bucket(bills, paychecks):
    buckets = {}
    pdays = []
    for i, p in enumerate(paychecks, start=1):
        try:
            pday = int(p["pay_date"].split("-")[-1])
        except Exception:
            pday = 99
        pdays.append((i, pday, p["pay_date"]))

    for b in bills:
        manual_bucket = b["paycheck_bucket"]
        if manual_bucket is not None and len(pdays) > 0:
            idx = max(1, min(int(manual_bucket), len(pdays)))
            p = pdays[idx-1]
            buckets[b["id"]] = (idx, p[1], p[2])
            continue
        bill_date = b.get("planned_pay_date") or b["due_date"]
        try:
            due_day = int(str(bill_date).split("-")[-1])
        except Exception:
            due_day = 99
        if not pdays:
            buckets[b["id"]] = (0, 0, "")
            continue

        if due_day < pdays[0][1]:
            buckets[b["id"]] = (0, 0, "")
            continue

        chosen = pdays[0]
        for p in pdays:
            if p[1] <= due_day:
                chosen = p
            else:
                break
        buckets[b["id"]] = chosen
    return buckets


def build_paycheck_plan(bills_for_month, paychecks, starting_balance, buckets):
    groups = {0: []}
    for i in range(1, len(paychecks) + 1):
        groups[i] = []

    for b in bills_for_month:
        idx = buckets.get(b["id"], (0, None, None))[0]
        groups.setdefault(idx, []).append(b)

    for idx in groups:
        groups[idx].sort(key=lambda x: (
            (x.get("planned_pay_date") or x.get("due_date") or ""),
            1 if x.get("is_adjustment") else (2 if x.get("is_postponed") else 0),
            x.get("id") or 0
        ))

    carry = starting_balance
    out = []
    type_counts = {"paycheck": 0, "other": 0}

    for i in sorted(groups.keys()):
        if i == 0:
            paycheck_amt = 0.0
            available = carry
            running = available
            items = []
            for b in groups.get(i, []):
                amt = float(b["amount"])
                is_paid = bool(b["paid"])
                is_postponed = bool(b.get("is_postponed"))
                is_prior_month_carry = bool(b.get("is_prior_month_carry"))
                is_adjustment = bool(b.get("is_adjustment"))
                if is_adjustment:
                    snap = b["snap_balance"] if b["snap_balance"] is not None else None
                    if snap is not None:
                        running = float(snap)
                    else:
                        running += amt
                    items.append({"bill": b, "amount": amt, "can_pay": True, "is_paid": True,
                                  "is_postponed": False, "is_prior_month_carry": False,
                                  "is_adjustment": True, "running_after": running})
                else:
                    effective_amt = 0.0 if (is_postponed or is_prior_month_carry) else amt
                    can_pay = True if (is_paid or is_postponed or is_prior_month_carry) else (running - effective_amt) >= 0
                    running -= effective_amt
                    items.append({"bill": b, "amount": amt, "can_pay": can_pay, "is_paid": is_paid,
                                  "is_postponed": is_postponed, "is_prior_month_carry": is_prior_month_carry,
                                  "is_adjustment": False, "running_after": running})

            out.append({
                "index": 0, "type_index": 0, "paycheck_id": 0, "date": "",
                "owner": "Last Month Pay", "income_type": "last_month",
                "label_base": "Last Month Pay", "display_label": "Last Month Pay",
                "paycheck_amount": paycheck_amt, "starting_available": available,
                "items": items, "ending_balance": running, "goes_negative": running < 0,
            })
            carry = running
            continue

        p = paychecks[i-1]
        paycheck_amt = float(p["amount"])
        available = carry + paycheck_amt
        items = []
        running = available
        income_type = (p["income_type"] if "income_type" in p.keys() else "paycheck") or "paycheck"
        if income_type not in type_counts:
            type_counts[income_type] = 0
        type_counts[income_type] += 1
        type_index = type_counts[income_type]
        label_base = "Income" if income_type == "other" else "Paycheck"

        unpaid_remaining = 0.0
        for b in groups.get(i, []):
            amt = float(b["amount"])
            is_paid = bool(b["paid"])
            is_postponed = bool(b.get("is_postponed"))
            is_prior_month_carry = bool(b.get("is_prior_month_carry"))
            is_adjustment = bool(b.get("is_adjustment"))
            if is_adjustment:
                snap = b["snap_balance"] if b["snap_balance"] is not None else None
                if snap is not None:
                    running = float(snap)
                else:
                    running -= amt
                items.append({"bill": b, "amount": amt, "can_pay": True, "is_paid": False,
                              "is_postponed": False, "is_prior_month_carry": False,
                              "is_adjustment": True, "running_after": running})
            else:
                effective_amt = 0.0 if (is_postponed or is_prior_month_carry) else amt
                can_pay = True if (is_paid or is_postponed or is_prior_month_carry) else (running - effective_amt) >= 0
                running -= effective_amt
                if not is_paid and not is_postponed and not is_prior_month_carry:
                    unpaid_remaining += amt
                items.append({"bill": b, "amount": amt, "can_pay": can_pay, "is_paid": is_paid,
                              "is_postponed": is_postponed, "is_prior_month_carry": is_prior_month_carry,
                              "is_adjustment": False, "running_after": running})

        out.append({
            "index": i, "type_index": type_index, "paycheck_id": p["id"],
            "date": p["pay_date"], "owner": p["owner"], "income_type": income_type,
            "label_base": label_base, "display_label": f"{label_base} {type_index}",
            "paycheck_amount": paycheck_amt, "starting_available": available,
            "unpaid_remaining": unpaid_remaining,
            "items": items, "ending_balance": running, "goes_negative": running < 0,
        })
        carry = running
    return out


def auto_apply_recurring_for_month(c, month, household_id=1):
    seed_key = f"auto_seeded:{household_id}:{month}"
    seeded = c.execute("select value from settings where key=?", (seed_key,)).fetchone()
    if seeded is not None and str(seeded["value"]).strip() == "1":
        return

    prev_month, next_month = month_prev_next(month)

    rows = c.execute(
        "select name, due_date, amount, category, recurring, recurring_timeframe, recurring_every_months, recurring_end_date, autopay from bills where household_id=? and deleted_at is null and substr(due_date,1,7)=? and recurring=1",
        (household_id, prev_month),
    ).fetchall()
    for r in rows:
        end_ym = str(r["recurring_end_date"] or "")[:7]
        if len(end_ym) == 7 and month > end_ym:
            continue

        day = r["due_date"].split("-")[-1]
        new_due = f"{month}-{day}"
        exists = c.execute(
            "select 1 from bills where household_id=? and name=? and due_date=? and amount=? and category=?",
            (household_id, r["name"], new_due, r["amount"], r["category"]),
        ).fetchone()
        if not exists:
            c.execute(
                "insert into bills(name,due_date,amount,paid,category,recurring,recurring_timeframe,recurring_every_months,recurring_end_date,autopay,household_id) values(?,?,?,?,?,?,?,?,?,?,?)",
                (r["name"], new_due, r["amount"], 0, r["category"], 1, (r["recurring_timeframe"] or 'monthly'), r["recurring_every_months"], r["recurring_end_date"], r["autopay"], household_id),
            )

    apply_paycheck_rules_for_month(c, household_id, month)

    c.execute("insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (seed_key, "1"))


def client_ip():
    xff = (request.headers.get("X-Forwarded-For", "") or "").split(",")[0].strip()
    return xff or (request.remote_addr or "unknown")


def login_rate_limited(c, ip, window_seconds=900, max_attempts=10):
    now = int(datetime.now().timestamp())
    floor = now - int(window_seconds)
    c.execute("delete from login_attempts where ts < ?", (floor,))
    n = c.execute("select count(*) c from login_attempts where ip=? and ts>=?", (ip, floor)).fetchone()["c"]
    return int(n) >= int(max_attempts)


def record_login_failure(c, ip):
    c.execute("insert into login_attempts(ip,ts) values(?,?)", (ip, int(datetime.now().timestamp())))


def clear_login_failures(c, ip):
    c.execute("delete from login_attempts where ip=?", (ip,))


# ── NOTES API ──────────────────────────────────────────────────────────────

@app.get('/api/notes')
def api_notes_get():
    if not authed(): return api_error('Unauthorized', 401)
    c = conn()
    household_id = active_household_id()
    rows = c.execute(
        "select id, text, color, created_at from household_notes where household_id=? order by id desc",
        (household_id,)
    ).fetchall()
    c.close()
    notes = []
    for r in rows:
        # Convert stored timestamp string to JS milliseconds
        try:
            ts = int(datetime.strptime(r['created_at'], '%Y-%m-%d %H:%M:%S').timestamp() * 1000)
        except Exception:
            ts = 0
        notes.append({'id': int(r['id']), 'text': r['text'], 'color': r['color'], 'created_at': ts})
    return jsonify({'ok': True, 'notes': notes})


@app.post('/api/notes/add')
def api_notes_add():
    if not authed(): return api_error('Unauthorized', 401)
    data = request.get_json(silent=True) or {}
    text = (data.get('text', '') or '').strip()
    color = (data.get('color', '#FFF9C4') or '#FFF9C4').strip()
    if not text:
        return api_error('Text is required', 400)
    c = conn()
    household_id = active_household_id()
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    c.execute(
        "insert into household_notes(household_id, text, color, created_at) values(?,?,?,?)",
        (household_id, text, color, now)
    )
    note_id = c.execute("select last_insert_rowid() as id").fetchone()['id']
    c.commit(); c.close()
    ts = int(time.time() * 1000)
    return jsonify({'ok': True, 'note': {'id': int(note_id), 'text': text, 'color': color, 'created_at': ts}})


@app.post('/api/notes/update/<int:note_id>')
def api_notes_update(note_id):
    if not authed(): return api_error('Unauthorized', 401)
    data = request.get_json(silent=True) or {}
    text = (data.get('text', '') or '').strip()
    color = (data.get('color', '#FFF9C4') or '#FFF9C4').strip()
    c = conn()
    household_id = active_household_id()
    c.execute(
        "update household_notes set text=?, color=? where id=? and household_id=?",
        (text, color, note_id, household_id)
    )
    c.commit(); c.close()
    return jsonify({'ok': True})


@app.post('/api/notes/delete/<int:note_id>')
def api_notes_delete(note_id):
    if not authed(): return api_error('Unauthorized', 401)
    c = conn()
    household_id = active_household_id()
    c.execute("delete from household_notes where id=? and household_id=?", (note_id, household_id))
    c.commit(); c.close()
    return jsonify({'ok': True})


# ── AUTH ────────────────────────────────────────────────────────────────────

@app.route("/signup", methods=["GET", "POST"])
def signup():
    error = ""
    if SIGNUP_MODE == "closed":
        return redirect(url_for("login"))
    if request.method == "POST":
        email = (request.form.get("email", "") or "").strip().lower()
        password = request.form.get("password", "") or ""
        q1 = (request.form.get("security_q1", "") or "").strip()
        a1 = (request.form.get("security_a1", "") or "").strip().lower()
        q2 = (request.form.get("security_q2", "") or "").strip()
        a2 = (request.form.get("security_a2", "") or "").strip().lower()
        household_name = (request.form.get("household_name", "") or "").strip() or "My Household"
        if SIGNUP_MODE == "allowlist" and email not in ALLOWLIST_EMAILS:
            error = "Signup is limited right now. Ask owner for invite access."
        elif not email or len(password) < 8:
            error = "Use a valid email and password (8+ chars)."
        elif not q1 or not a1 or not q2 or not a2:
            error = "Please complete both security questions and answers."
        elif q1 not in SECURITY_QUESTIONS or q2 not in SECURITY_QUESTIONS:
            error = "Please choose security questions from the provided list."
        elif q1 == q2:
            error = "Please choose two different security questions."
        else:
            c = conn()
            exists = c.execute("select id from users where email=?", (email,)).fetchone()
            if exists:
                error = "That email is already registered. Please log in."
            else:
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                c.execute("insert into users(email,password_hash,created_at,security_q1,security_a1_hash,security_q2,security_a2_hash) values(?,?,?,?,?,?,?)", (email, generate_password_hash(password, method='pbkdf2:sha256'), now, q1, generate_password_hash(a1, method='pbkdf2:sha256'), q2, generate_password_hash(a2, method='pbkdf2:sha256')))
                user_id = c.execute("select id from users where email=?", (email,)).fetchone()["id"]
                c.execute("insert into households(name,created_by_user_id,created_at) values(?,?,?)", (household_name, user_id, now))
                household_id = c.execute("select id from households where created_by_user_id=? order by id desc limit 1", (user_id,)).fetchone()["id"]
                c.execute("insert into household_members(household_id,user_id,role,joined_at) values(?,?,?,?)", (household_id, user_id, "owner", now))
                c.execute("insert or ignore into household_categories(household_id,name) values(?,?)", (household_id, "bill"))
                c.execute("insert or ignore into household_categories(household_id,name) values(?,?)", (household_id, "debt"))
                c.execute("insert or ignore into household_categories(household_id,name) values(?,?)", (household_id, "trip"))
                c.execute("insert or ignore into settings(key,value) values(?,?)", (setting_key(household_id, 'starting_balance'), '0'))
                c.execute("insert or ignore into settings(key,value) values(?,?)", (setting_key(household_id, 'min_buffer'), '150'))
                c.execute("insert or ignore into settings(key,value) values(?,?)", (setting_key(household_id, 'accent_theme'), 'blue'))
                c.commit(); c.close()
                session["ok"] = True
                session["user_id"] = user_id
                session["household_id"] = household_id
                session["show_tour"] = True
                return redirect_dashboard_from_form(request.form)
            c.close()
    return render_template("signup.html", app_name=APP_NAME, error=error)


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        mode = request.form.get("mode", "passcode")
        ip = client_ip()
        c = conn()
        if login_rate_limited(c, ip):
            c.close()
            return render_template("login.html", app_name=APP_NAME, error="Too many attempts. Try again in 15 minutes.")
        if mode == "password":
            email = (request.form.get("email", "") or "").strip().lower()
            password = request.form.get("password", "") or ""
            user = c.execute("select * from users where email=?", (email,)).fetchone()
            if user and check_password_hash(user["password_hash"], password):
                member = c.execute("select household_id from household_members where user_id=? order by id asc limit 1", (user["id"],)).fetchone()
                session["ok"] = True
                session["user_id"] = int(user["id"])
                session["household_id"] = int(member["household_id"]) if member else 1
                first_tour = int(user["tour_seen"] or 0) == 0
                session["show_tour"] = True if first_tour else False
                c.execute("update users set last_login_at=?, tour_seen=? where id=?", (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), 1, user["id"]))
                clear_login_failures(c, ip)
                c.commit(); c.close()
                return redirect_dashboard_from_form(request.form)
            record_login_failure(c, ip)
            c.commit(); c.close()
            error = "Invalid email or password."
        else:
            if ENABLE_SHARED_PASSCODE_LOGIN and request.form.get("passcode") == SHARED_PASSCODE:
                session["ok"] = True
                session["household_id"] = 1
                clear_login_failures(c, ip)
                c.commit(); c.close()
                return redirect_dashboard_from_form(request.form)
            record_login_failure(c, ip)
            c.commit(); c.close()
            error = "Shared passcode login is disabled. Use your account login."
    return render_template("login.html", app_name=APP_NAME, error=error)


@app.route("/forgot-password", methods=["GET", "POST"])
def forgot_password():
    error = ""
    stage = "email"
    email = ""
    q1 = ""
    q2 = ""
    if request.method == "POST":
        stage = request.form.get("stage", "email")
        c = conn()
        if stage == "email":
            email = (request.form.get("email", "") or "").strip().lower()
            user = c.execute("select email, security_q1, security_q2 from users where lower(email)=lower(?)", (email,)).fetchone()
            if not user:
                error = "No account found for that email."
            else:
                q1 = user["security_q1"] or ""
                q2 = user["security_q2"] or ""
                stage = "questions"
        else:
            email = (request.form.get("email", "") or "").strip().lower()
            a1 = (request.form.get("security_a1", "") or "").strip().lower()
            a2 = (request.form.get("security_a2", "") or "").strip().lower()
            user = c.execute("select * from users where lower(email)=lower(?)", (email,)).fetchone()
            if not user:
                error = "No account found for that email."
                stage = "email"
            elif not check_password_hash(user["security_a1_hash"] or "x", a1) or not check_password_hash(user["security_a2_hash"] or "x", a2):
                error = "Security answers did not match."
                q1 = user["security_q1"] or ""
                q2 = user["security_q2"] or ""
                stage = "questions"
            else:
                session["pw_reset_email"] = email
                c.close()
                return redirect(url_for("reset_password_security"))
        c.close()
    return render_template("forgot_password.html", error=error, stage=stage, email=email, q1=q1, q2=q2)


@app.route("/reset-password", methods=["GET", "POST"])
def reset_password_security():
    email = (session.get("pw_reset_email", "") or "").strip().lower()
    if not email:
        return redirect(url_for("forgot_password"))
    error = ""
    if request.method == "POST":
        pw = request.form.get("password", "") or ""
        if len(pw) < 8:
            error = "Password must be at least 8 characters."
        else:
            c = conn()
            c.execute("update users set password_hash=? where lower(email)=lower(?)", (generate_password_hash(pw, method='pbkdf2:sha256'), email))
            c.commit(); c.close()
            session.pop("pw_reset_email", None)
            return redirect(url_for("login"))
    return render_template("reset_password.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.post('/api/mobile/login')
def api_mobile_login():
    data = request.get_json(silent=True) or {}
    email = (data.get('email', '') or '').strip().lower()
    password = data.get('password', '') or ''
    if not email or not password:
        return api_error('Email and password are required.', 400)

    ip = client_ip()
    c = conn()
    if login_rate_limited(c, ip):
        c.close()
        return api_error('Too many attempts. Try again in 15 minutes.', 429)

    user = c.execute('select * from users where email=?', (email,)).fetchone()
    if not user or not check_password_hash(user['password_hash'], password):
        record_login_failure(c, ip)
        c.commit(); c.close()
        return api_error('Invalid email or password.', 401)

    member = c.execute('select household_id from household_members where user_id=? order by id asc limit 1', (user['id'],)).fetchone()
    session['ok'] = True
    session['user_id'] = int(user['id'])
    session['household_id'] = int(member['household_id']) if member else 1
    c.execute('update users set last_login_at=?, tour_seen=? where id=?', (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), 1, user['id']))
    clear_login_failures(c, ip)
    c.commit(); c.close()

    return jsonify({
        'ok': True,
        'user': {'id': int(user['id']), 'email': user['email']},
        'household_id': int(session['household_id']),
    })


@app.post('/api/mobile/logout')
def api_mobile_logout():
    session.clear()
    return jsonify({'ok': True})


@app.get('/api/mobile/dashboard')
def api_mobile_dashboard():
    if not authed():
        return api_error('Unauthorized', 401)

    month = normalize_month(request.args.get('month', datetime.now().strftime('%Y-%m')))
    c = conn()
    household_id = active_household_id()

    paychecks_sum = c.execute("select coalesce(sum(amount),0) s from paychecks where household_id=? and substr(pay_date,1,7)=?", (household_id, month)).fetchone()['s']
    expenses_sum = c.execute("select coalesce(sum(amount),0) s from bills where household_id=? and deleted_at is null and substr(due_date,1,7)=?", (household_id, month)).fetchone()['s']
    upcoming = c.execute("select id,name,amount,due_date,planned_pay_date,paid,category,note from bills where household_id=? and deleted_at is null and substr(due_date,1,7)=? order by due_date,id limit 30", (household_id, month)).fetchall()
    recent_ledger = c.execute("select id,tx_date,label,amount,note from ledger where household_id=? and substr(tx_date,1,7)=? order by tx_date desc,id desc limit 50", (household_id, month)).fetchall()
    trips = c.execute("select id,name,due_month,target,saved from trips where household_id=? and deleted_at is null order by due_month,id", (household_id,)).fetchall()
    promotions = c.execute("select id,card_name,promo_name,start_date,end_date,balance,completed,note from promotions where household_id=? and deleted_at is null order by end_date,id", (household_id,)).fetchall()
    subscriptions = c.execute("select id,name,day_due,payment,recurring,recurring_timeframe,recurring_every_months,yearly_month,start_month from subscriptions where household_id=? and deleted_at is null order by day_due,name,id", (household_id,)).fetchall()
    theme = get_setting(c, 'accent_theme', 'blue', household_id)
    c.close()

    return jsonify({
        'ok': True, 'month': month, 'theme': theme,
        'totalIncome': float(paychecks_sum or 0),
        'totalExpenses': float(expenses_sum or 0),
        'remaining': float(paychecks_sum or 0) - float(expenses_sum or 0),
        'upcomingBills': [{'id': int(r['id']), 'name': r['name'], 'amount': float(r['amount'] or 0), 'dueDate': (r['planned_pay_date'] or r['due_date']), 'paid': int(r['paid'] or 0), 'category': r['category']} for r in upcoming],
        'ledger': [{'id': int(r['id']), 'txDate': r['tx_date'], 'label': r['label'], 'amount': float(r['amount'] or 0), 'note': r['note'] or ''} for r in recent_ledger],
        'trips': [{'id': int(r['id']), 'name': r['name'], 'dueMonth': r['due_month'], 'target': float(r['target'] or 0), 'saved': float(r['saved'] or 0)} for r in trips],
        'promotions': [{'id': int(r['id']), 'cardName': r['card_name'], 'promoName': r['promo_name'], 'startDate': r['start_date'] or '', 'endDate': r['end_date'], 'balance': float(r['balance'] or 0), 'completed': int(r['completed'] or 0), 'note': r['note'] or ''} for r in promotions],
        'subscriptions': [{'id': int(r['id']), 'name': r['name'], 'dayDue': int(r['day_due'] or 1), 'payment': float(r['payment'] or 0), 'recurring': int(r['recurring'] or 0), 'recurringTimeframe': r['recurring_timeframe'] or 'monthly', 'recurringEveryMonths': r['recurring_every_months'], 'yearlyMonth': r['yearly_month']} for r in subscriptions],
    })


@app.get('/api/mobile/settings/theme')
def api_mobile_theme_get():
    if not authed(): return api_error('Unauthorized', 401)
    c = conn()
    household_id = active_household_id()
    theme = get_setting(c, 'accent_theme', 'blue', household_id)
    c.close()
    return jsonify({'ok': True, 'theme': theme, 'availableThemes': list(THEMES.keys())})


@app.post('/api/mobile/settings/theme')
def api_mobile_theme_set():
    if not authed(): return api_error('Unauthorized', 401)
    data = request.get_json(silent=True) or {}
    theme = (data.get('theme', '') or '').strip().lower()
    if theme not in THEMES: return api_error('Invalid theme', 400)
    c = conn()
    household_id = active_household_id()
    c.execute("insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (setting_key(household_id, 'accent_theme'), theme))
    c.commit(); c.close()
    return jsonify({'ok': True, 'theme': theme})


@app.post('/api/mobile/bills/<int:item_id>/paid')
def api_mobile_bill_paid(item_id):
    if not authed(): return api_error('Unauthorized', 401)
    c = conn()
    household_id = active_household_id()
    row = c.execute("select * from bills where id=? and household_id=? and deleted_at is null", (item_id, household_id)).fetchone()
    if row is None: c.close(); return api_error('Bill not found', 404)
    if int(row['paid'] or 0) == 0:
        paid_on = local_now().strftime('%Y-%m-%d')
        c.execute("update bills set paid=1, paid_date=?, planned_pay_date=? where id=? and household_id=?", (paid_on, paid_on, item_id, household_id))
        c.execute("insert into ledger(tx_date,label,amount,note,household_id) values(?,?,?,?,?)", (paid_on, row['name'], -abs(float(row['amount'] or 0)), 'marked paid (mobile)', household_id))
    c.commit(); c.close()
    return jsonify({'ok': True, 'billId': item_id, 'paid': 1})


@app.post('/api/mobile/bills/<int:item_id>/postpone')
def api_mobile_bill_postpone(item_id):
    if not authed(): return api_error('Unauthorized', 401)
    data = request.get_json(silent=True) or {}
    try: postpone_days = int(data.get('days', 7) or 7)
    except Exception: postpone_days = 7
    postpone_days = max(1, min(postpone_days, 31))
    c = conn()
    household_id = active_household_id()
    row = c.execute("select * from bills where id=? and household_id=? and deleted_at is null", (item_id, household_id)).fetchone()
    if row is None: c.close(); return api_error('Bill not found', 404)
    current_target = (row['planned_pay_date'] if 'planned_pay_date' in row.keys() else '') or row['due_date']
    try: base = datetime.strptime(current_target, '%Y-%m-%d')
    except Exception: base = local_now()
    new_date = (base + timedelta(days=postpone_days)).strftime('%Y-%m-%d')
    existing_note = (row['note'] if 'note' in row.keys() else '') or ''
    stamp = local_now().strftime('%m-%d-%Y')
    tagged = f"[{stamp}] Postponed (mobile) by {postpone_days} days"
    new_note = (existing_note + "\n" + tagged).strip() if existing_note else tagged
    c.execute("update bills set planned_pay_date=?, note=?, paycheck_bucket=NULL where id=? and household_id=?", (new_date, new_note, item_id, household_id))
    c.execute("insert into ledger(tx_date,label,amount,note,household_id) values(?,?,?,?,?)", (local_now().strftime('%Y-%m-%d'), row['name'], 0, f'postponed (mobile) to {new_date}', household_id))
    c.commit(); c.close()
    return jsonify({'ok': True, 'billId': item_id, 'postponedTo': new_date})


@app.route("/")
def dashboard():
    if not authed():
        return redirect(url_for("login"))
    month = normalize_month(request.args.get("month", datetime.now().strftime("%Y-%m")))
    view = request.args.get("view", "paycheck")
    if view not in ("checklist", "paycheck"):
        view = "checklist"
    page = request.args.get("page", "dashboard")
    if page not in ("dashboard", "entries", "planner", "trips", "promotions", "subscriptions", "calendar", "checkbook", "settings", "admin"):
        page = "dashboard"
    prev_month, next_month = month_prev_next(month)

    c = conn()
    household_id = active_household_id()
    c.commit()

    user_is_admin = is_admin_user(c)
    if page == "admin" and not user_is_admin:
        page = "dashboard" 

    bills_raw = c.execute("select * from bills where household_id=? and deleted_at is null and substr(due_date,1,7)=? order by due_date, id", (household_id, month)).fetchall()
    bills = []
    for r in bills_raw:
        d = dict(r)
        d["planned_pay_date"] = d.get("planned_pay_date") or d.get("due_date")
        d["is_postponed"] = is_postponed_note(d.get("note"))
        bills.append(d)
    unpaid_bills_all = [b for b in bills if not b["paid"]]
    unpaid_bills_all.sort(key=lambda b: (1 if b.get("is_postponed") else 0, (b.get("planned_pay_date") or b.get("due_date") or ""), b.get("id") or 0))
    unpaid_bills = [b for b in unpaid_bills_all if not b.get("is_postponed")]
    paychecks = c.execute("select * from paychecks where household_id=? and substr(pay_date,1,7)=? order by pay_date, id", (household_id, month)).fetchall()
    paycheck_rules = c.execute("select * from paycheck_rules where household_id=? and active=1 order by owner, id", (household_id,)).fetchall()
    categories = c.execute("select * from household_categories where household_id=? order by name", (household_id,)).fetchall()
    trips = c.execute("select * from trips where household_id=? and deleted_at is null order by due_month", (household_id,)).fetchall()
    promotions = c.execute("select * from promotions where household_id=? and deleted_at is null and coalesce(completed,0)=0 order by end_date, id", (household_id,)).fetchall()
    completed_promotions = c.execute("select * from promotions where household_id=? and deleted_at is null and coalesce(completed,0)=1 order by end_date desc, id desc", (household_id,)).fetchall()
    subscriptions = c.execute("select * from subscriptions where household_id=? and deleted_at is null order by day_due, name, id", (household_id,)).fetchall()
    recurring_subscriptions = c.execute("select * from subscriptions where household_id=? and deleted_at is null and coalesce(recurring,1)=1 order by day_due, name, id", (household_id,)).fetchall()
    credit_accounts = c.execute("select * from credit_accounts where household_id=? and deleted_at is null order by paid_off asc, card_name, id", (household_id,)).fetchall()
    loans = c.execute("select * from loans where household_id=? and deleted_at is null order by paid_off asc, case when end_date is null or end_date='' then 1 else 0 end asc, end_date asc, loan_name, id", (household_id,)).fetchall()
    paid_credit_accounts = [r for r in credit_accounts if int(r['paid_off'] or 0) == 1]
    paid_loans = [r for r in loans if int(r['paid_off'] or 0) == 1]
    recurring_bills = c.execute("select * from bills where household_id=? and deleted_at is null and recurring=1 order by due_date, id", (household_id,)).fetchall()
    ledger = c.execute("select * from ledger where household_id=? and substr(tx_date,1,7)=? order by tx_date, id", (household_id, month)).fetchall()
    paid_recent = c.execute("select * from ledger where household_id=? and substr(tx_date,1,7)=? and amount < 0 order by id desc limit 20", (household_id, month)).fetchall()
    dashboard_note_row = c.execute("select note_text from dashboard_notes where household_id=?", (household_id,)).fetchone()
    dashboard_note_text = (dashboard_note_row["note_text"] if dashboard_note_row else "") or ""

    planner_items = []
    for b in bills:
        d = dict(b)
        d["is_adjustment"] = (d.get("category") == "adjustment")
        planner_items.append(d)
    for t in ledger:
        if (t["note"] or "") == "trip contribution" and float(t["amount"] or 0) < 0:
            planner_items.append({
                "id": 1000000 + int(t["id"]), "name": t["label"], "due_date": t["tx_date"],
                "amount": abs(float(t["amount"])), "paid": 1, "category": "trip",
                "recurring": 0, "autopay": 0, "paycheck_bucket": None,
                "planned_pay_date": t["tx_date"], "is_adjustment": False,
            })

    bills_due = sum(r["amount"] for r in unpaid_bills)
    planned_bills_total = sum(r["amount"] for r in bills)
    income = sum(r["amount"] for r in paychecks)

    first_pay_day = None
    if paychecks:
        try:
            first_pay_day = min(int(str(p["pay_date"]).split("-")[-1]) for p in paychecks)
        except Exception:
            first_pay_day = None

    prior_month_carry_bill_ids = set()
    prior_month_carry_total = 0.0
    if first_pay_day is not None:
        for b in planner_items:
            if int(b.get("id") or 0) >= 1000000:
                continue
            try:
                d = int(str((b.get("planned_pay_date") or b.get("due_date") or "")).split("-")[-1])
            except Exception:
                continue
            if d < first_pay_day and not b.get("is_postponed"):
                b["is_prior_month_carry"] = True
                prior_month_carry_bill_ids.add(int(b["id"]))
                prior_month_carry_total += abs(float(b.get("amount") or 0))
            else:
                b["is_prior_month_carry"] = False

    buckets = assign_paycheck_bucket(planner_items, paychecks)
    projection = projected_checkbook(c, month, household_id, carryover_bill_ids=prior_month_carry_bill_ids, start_delta=-prior_month_carry_total)
    paycheck_plan = build_paycheck_plan(planner_items, paychecks, projection["starting"], buckets)
    month_start = projection["starting"]

    next_month_carry_bills = []
    next_month_carry_total = 0.0
    next_month_paychecks = c.execute("select pay_date from paychecks where household_id=? and substr(pay_date,1,7)=? order by pay_date, id", (household_id, next_month)).fetchall()
    next_first_pay_day = None
    if next_month_paychecks:
        try:
            next_first_pay_day = min(int(str(p["pay_date"]).split("-")[-1]) for p in next_month_paychecks)
        except Exception:
            next_first_pay_day = None

    if next_first_pay_day is not None:
        next_month_bills = c.execute("select * from bills where household_id=? and deleted_at is null and paid=0 and substr(due_date,1,7)=? and lower(coalesce(note,'')) not like '%postponed%' order by due_date, id", (household_id, next_month)).fetchall()
        for rb in next_month_bills:
            b = dict(rb)
            due_source = b.get("planned_pay_date") or b.get("due_date") or ""
            try:
                d = int(str(due_source).split("-")[-1])
            except Exception:
                continue
            if d < next_first_pay_day:
                next_month_carry_bills.append(b)
                next_month_carry_total += abs(float(b.get("amount") or 0))

    next_month_carry_bills.sort(key=lambda b: (b.get("planned_pay_date") or b.get("due_date") or "", b.get("id") or 0))
    this_month_end_balance = paycheck_plan[-1]["ending_balance"] if paycheck_plan else projection["starting"]
    carry_after_balance = float(this_month_end_balance) - float(next_month_carry_total)

    # Build running balance: starting + paychecks + ledger entries
    # Paychecks are not in the ledger, so we merge them in for the running total
    paycheck_events = [(p["pay_date"], p["owner"], float(p["amount"] or 0)) for p in paychecks]
    ledger_events = [(t["tx_date"], t["id"], t["label"], float(t["amount"] or 0), t["note"]) for t in ledger]

    # Merge paychecks + ledger sorted by date, paychecks first on same date
    all_events = []
    for (ev_date, owner, amt) in paycheck_events:
        all_events.append((ev_date, 0, 'paycheck', f"Paycheck ({owner})", amt, ""))
    for (ev_date, eid, label, amt, note) in ledger_events:
        all_events.append((ev_date, 1, 'ledger', label, amt, note or ""))
    all_events.sort(key=lambda x: (x[0], x[1]))

    # Build ledger_running for history display (only ledger rows, but balance accounts for paychecks)
    balance = month_start
    ledger_running = [(-1, month + '-01', 'Starting Balance', month_start, 'auto', month_start)]
    ledger_idx = 0
    ledger_list = list(ledger)
    for (ev_date, sort_type, etype, label, amt, note) in all_events:
        balance += amt
        if etype == 'ledger':
            t = ledger_list[ledger_idx]
            ledger_running.append((t["id"], t["tx_date"], t["label"], t["amount"], t["note"], balance))
            ledger_idx += 1

    remaining_unpaid_total = sum(float(r["amount"]) for r in unpaid_bills)
    current_risk_balance = balance - remaining_unpaid_total

    theme_name = get_setting(c, "accent_theme", "blue", household_id)
    theme = THEMES.get(theme_name, THEMES["slate"])
    household_row = c.execute("select name from households where id=?", (household_id,)).fetchone()
    household_name = household_row["name"] if household_row else f"Household {household_id}"
    show_tour = bool(session.pop("show_tour", False))

    # Banner (shown to all users)
    banner_row = c.execute("select enabled, text, start_date, end_date from site_banner where id=1").fetchone()
    banner_enabled = False
    banner_text = ""
    banner_start_date = ""
    banner_end_date = ""
    if banner_row and banner_row["enabled"]:
        today_s = datetime.now().strftime("%Y-%m-%d")
        start_ok = not banner_row["start_date"] or banner_row["start_date"] <= today_s
        end_ok = not banner_row["end_date"] or banner_row["end_date"] >= today_s
        banner_enabled = start_ok and end_ok
        banner_text = (banner_row["text"] or "")
        banner_start_date = banner_row["start_date"] or ""
        banner_end_date = banner_row["end_date"] or ""

    # Admin data
    admin_users = []
    admin_update_log = []
    admin_feedback = []
    banner_history = []
    if user_is_admin:
        admin_users = c.execute(
            "select u.id, u.email, u.created_at, u.last_login_at, u.is_admin, "
            "hm.role, h.name as household_name "
            "from users u "
            "left join household_members hm on hm.user_id=u.id "
            "left join households h on h.id=hm.household_id "
            "order by u.last_login_at desc nulls last"
        ).fetchall()
        admin_update_log = c.execute(
            "select * from update_log order by id desc"
        ).fetchall()

        # Extra stats for admin dashboard tab
        admin_stats = {
            "total_users": c.execute("select count(*) n from users").fetchone()["n"],
            "total_households": c.execute("select count(*) n from households").fetchone()["n"],
            "logins_today": c.execute("select count(*) n from users where substr(last_login_at,1,10)=?", (datetime.now().strftime("%Y-%m-%d"),)).fetchone()["n"],
            "unread_feedback": c.execute("select count(*) n from feedback where is_read=0").fetchone()["n"],
            "newest_user": c.execute("select email, created_at from users order by id desc limit 1").fetchone(),
            "latest_version": c.execute("select version, title, created_at from update_log order by id desc limit 1").fetchone(),
            "banner_enabled": banner_enabled,
        }
        banner_history = c.execute(
            "select * from banner_history order by id desc limit 20"
        ).fetchall()
        admin_feedback = c.execute(
            "select f.id, f.subject, f.message, f.created_at, f.is_read, f.feedback_type, u.email "
            "from feedback f left join users u on u.id=f.user_id "
            "order by f.is_read asc, f.id desc"
        ).fetchall()

    today = datetime.now().date()
    due_now_bills = []
    past_due_bills = []
    for b in unpaid_bills_all:
        if b.get("is_postponed"):
            continue
        due_dt = None
        try:
            due_dt = datetime.strptime(b["due_date"], "%Y-%m-%d").date()
        except Exception:
            pass
        if not due_dt:
            continue
        row = dict(b)
        row["days_past_due"] = (today - due_dt).days if due_dt < today else 0
        if due_dt == today:
            due_now_bills.append(row)
        elif due_dt < today:
            past_due_bills.append(row)

    promotions_ending_soon = []
    for p in promotions:
        if int(p["completed"] or 0) == 1:
            continue
        end_dt = None
        try:
            end_dt = datetime.strptime(p["end_date"], "%Y-%m-%d").date()
        except Exception:
            pass
        if not end_dt:
            continue
        days_left = (end_dt - today).days
        if days_left <= 60:
            row = dict(p)
            row["days_left"] = days_left
            row["status"] = "expired" if days_left < 0 else ("urgent" if days_left <= 14 else ("warning" if days_left <= 30 else "watch"))
            promotions_ending_soon.append(row)

    savings_paid_row = c.execute("select coalesce(sum(amount),0) s from bills where household_id=? and deleted_at is null and lower(coalesce(category,''))='savings' and paid=1 and substr(coalesce(paid_date,due_date),1,7)=?", (household_id, month)).fetchone()
    savings_planned_row = c.execute("select coalesce(sum(amount),0) s from bills where household_id=? and deleted_at is null and lower(coalesce(category,''))='savings' and substr(due_date,1,7)=?", (household_id, month)).fetchone()
    savings_paid_month = float((savings_paid_row["s"] if savings_paid_row else 0) or 0)
    savings_planned_month = float((savings_planned_row["s"] if savings_planned_row else 0) or 0)

    savings_goal_monthly = []
    for t in trips:
        try:
            target = float(t["target"] or 0)
            saved = float(t["saved"] or 0)
        except Exception:
            continue
        remaining = max(target - saved, 0.0)
        due_key = str((t["due_month"] if "due_month" in t.keys() else "") or "")[:7]
        months_left = 1
        try:
            cy, cm = [int(x) for x in month.split("-")]
            dy, dm = [int(x) for x in due_key.split("-")]
            diff = (dy - cy) * 12 + (dm - cm)
            months_left = 1 if diff < 0 else (diff + 1)
        except Exception:
            months_left = 1
        monthly_needed = (remaining / months_left) if months_left > 0 else remaining
        row = dict(t)
        row["remaining"] = remaining
        row["months_left"] = months_left
        row["monthly_needed"] = monthly_needed
        savings_goal_monthly.append(row)

    year, mon = map(int, month.split("-"))
    month_last_day = f"{year:04d}-{mon:02d}-{calendar.monthrange(year, mon)[1]:02d}"
    today_dt = date.today()
    is_current_month = (today_dt.year == year and today_dt.month == mon)
    today_day = today_dt.day if is_current_month else 0
    cal = calendar.Calendar(firstweekday=6)
    calendar_weeks = cal.monthdayscalendar(year, mon)
    events_by_date = {}

    def add_event(date_key, ev_type, title, amount=None, meta=None):
        if not date_key or not str(date_key).startswith(month + "-"):
            return
        row = {"type": ev_type, "title": title, "amount": amount}
        if meta:
            row.update(meta)
        events_by_date.setdefault(date_key, []).append(row)

    for b in bills:
        add_event(b["planned_pay_date"] or b["due_date"], "bill", b["name"], float(b["amount"]), {"id": int(b["id"]), "due_date": b["due_date"], "planned_pay_date": b["planned_pay_date"] or b["due_date"], "autopay": 1 if b["autopay"] else 0, "paycheck_bucket": b["paycheck_bucket"] if b["paycheck_bucket"] is not None else "", "paid": 1 if b["paid"] else 0, "paid_date": b["paid_date"] or ""})
    for p in paychecks:
        add_event(p["pay_date"], "paycheck", p["owner"], float(p["amount"]), {"id": int(p["id"]), "pay_date": p["pay_date"], "income_type": (p["income_type"] if "income_type" in p.keys() else "paycheck") or "paycheck"})
    for t in trips:
        add_event(t["due_month"], "trip", t["name"], float(t["target"]), {"id": int(t["id"]), "name": t["name"], "due_month": t["due_month"], "target": float(t["target"]), "saved": float(t["saved"])})
    for p in promotions:
        if int(p["completed"] or 0) == 1:
            continue
        add_event(p["end_date"], "promotion", f"{p['card_name']} - {p['promo_name']}", float(p["balance"]), {"id": int(p["id"]), "card_name": p["card_name"], "promo_name": p["promo_name"], "start_date": p["start_date"] or "", "end_date": p["end_date"], "balance": float(p["balance"]), "note": p["note"] or ""})

    for s in subscriptions:
        if int(s["recurring"] or 0) != 1:
            continue
        timeframe = (s["recurring_timeframe"] or "monthly").strip().lower()
        show = False
        if timeframe == "yearly":
            ym = int(s["yearly_month"] or 0)
            if ym == 0:
                # No month set — fall back to showing on the subscription's due month
                # Use day_due to determine: show every year on the same month
                # Default to January if completely unset
                ym = 1
            show = (ym == mon)
        elif timeframe == "specified_months":
            try: interval = int(s["recurring_every_months"] or 1)
            except Exception: interval = 1
            if interval < 1: interval = 1
            # Use start_month as anchor (YYYY-MM format), fall back to current month
            anchor_ym = (s["start_month"] or "").strip() or month
            try:
                ay, am = [int(x) for x in anchor_ym.split('-')]
            except Exception:
                ay, am = year, mon
            diff = (year - ay) * 12 + (mon - am)
            show = diff >= 0 and diff % interval == 0
        else:
            show = True

        if not show:
            continue
        day_due = max(1, min(int(s["day_due"] or 1), calendar.monthrange(year, mon)[1]))
        dkey = f"{year:04d}-{mon:02d}-{day_due:02d}"
        add_event(dkey, "subscription", s["name"], float(s["payment"] or 0), {"id": int(s["id"]), "name": s["name"], "day_due": int(s["day_due"] or 1), "payment": float(s["payment"] or 0), "recurring": int(s["recurring"] or 0), "recurring_timeframe": timeframe, "recurring_every_months": s["recurring_every_months"] or "", "yearly_month": s["yearly_month"] or ""})

    bill_name_suggestions = [r[0] for r in c.execute(
        "select distinct name from bills where household_id=? and deleted_at is null and coalesce(category,'bill') not in ('adjustment','savings') order by name collate nocase",
        (household_id,)).fetchall()]
    # For autofill: latest settings per bill name (recurring, autopay)
    bill_name_meta = {}
    for r in c.execute(
        "select name, recurring, autopay from bills where household_id=? and deleted_at is null and coalesce(category,'bill') not in ('adjustment','savings') order by recurring desc, id desc",
        (household_id,)).fetchall():
        if r[0] not in bill_name_meta:
            bill_name_meta[r[0]] = {"recurring": bool(r[1]), "autopay": bool(r[2])}

    c.close()
    return render_template(
        "dashboard.html",
        bills=bills, unpaid_bills=unpaid_bills, unpaid_bills_all=unpaid_bills_all,
        paychecks=paychecks, trips=trips, promotions=promotions, subscriptions=subscriptions,
        recurring_subscriptions=recurring_subscriptions, promotions_ending_soon=promotions_ending_soon,
        completed_promotions=completed_promotions, due_now_bills=due_now_bills, past_due_bills=past_due_bills,
        credit_accounts=credit_accounts, loans=loans, paid_credit_accounts=paid_credit_accounts,
        paid_loans=paid_loans, calendar_weeks=calendar_weeks, events_by_date=events_by_date,
        today_day=today_day, ledger=ledger, paid_recent=paid_recent, ledger_running=ledger_running,
        bills_due=bills_due, planned_bills_total=planned_bills_total, income=income, balance=balance,
        buckets=buckets, projection=projection, paycheck_plan=paycheck_plan, month_start=month_start,
        remaining_unpaid_total=remaining_unpaid_total, current_risk_balance=current_risk_balance,
        next_month_carry_bills=next_month_carry_bills, next_month_carry_total=next_month_carry_total,
        carry_after_balance=carry_after_balance, month=month, month_last_day=month_last_day,
        prev_month=prev_month, next_month=next_month, view=view, page=page,
        paycheck_rules=paycheck_rules, recurring_bills=recurring_bills, categories=categories,
        theme=theme, theme_name=theme_name, household_name=household_name,
        dashboard_note_text=dashboard_note_text, savings_paid_month=savings_paid_month,
        savings_planned_month=savings_planned_month, savings_goal_monthly=savings_goal_monthly,
        show_tour=show_tour, today_str=today.strftime('%Y-%m-%d'),
        user_is_admin=user_is_admin, banner_enabled=banner_enabled, banner_text=banner_text, banner_start_date=banner_start_date, banner_end_date=banner_end_date,
        admin_users=admin_users, admin_update_log=admin_update_log, admin_stats=admin_stats if user_is_admin else {}, admin_feedback=admin_feedback if user_is_admin else [], banner_history=banner_history if user_is_admin else [],
        bill_name_suggestions=bill_name_suggestions,
        bill_name_meta=bill_name_meta,
    )


@app.post("/entries/add")
def entries_add():
    if not authed(): return redirect(url_for("login"))
    c = conn()
    household_id = active_household_id()

    entry_type = request.form.get("entry_type", "income")
    if entry_type == "income":
        income_kind = request.form.get("income_kind", "paycheck")
        if income_kind not in ("paycheck", "other"): income_kind = "paycheck"
        owner_label = (request.form.get("owner", "") or "").strip()
        if income_kind == "other" and not owner_label: owner_label = "Other Income"
        c.execute("insert into paychecks(owner,pay_date,amount,income_type,household_id) values(?,?,?,?,?)", (owner_label, request.form.get("pay_date", ""), float(request.form.get("income_amount", 0) or 0), income_kind, household_id))
        c.commit(); c.close()
        return redirect_dashboard_from_form(request.form)

    if entry_type == "trip_contribution":
        try: trip_id = int(request.form.get("contrib_trip_id", "0") or 0); amount = abs(float(request.form.get("contrib_amount", 0) or 0))
        except Exception: trip_id, amount = 0, 0
        if trip_id > 0 and amount > 0:
            tr = c.execute("select * from trips where id=? and household_id=? and deleted_at is null", (trip_id, household_id)).fetchone()
            if tr is not None:
                c.execute("update trips set saved = saved + ? where id=? and household_id=?", (amount, trip_id, household_id))
                c.execute("insert into ledger(tx_date,label,amount,note,household_id) values(?,?,?,?,?)", (request.form.get("contrib_date", datetime.now().strftime("%Y-%m-%d")), f"Trip Contribution - {tr['name']}", -amount, "trip contribution", household_id))
        c.commit(); c.close()
        return redirect_dashboard_from_form(request.form)

    name = request.form.get("name", "")
    amount_raw = request.form.get("bill_amount", request.form.get("amount", 0))
    try: amount = float(str(amount_raw or 0).replace(',', '').strip() or 0)
    except Exception: amount = 0.0
    category = request.form.get("category", "bill")
    trip_id_raw = request.form.get("trip_id", "")
    if category == "trip" and str(trip_id_raw).strip():
        try:
            trip_id = int(trip_id_raw)
            tr = c.execute("select * from trips where id=? and household_id=? and deleted_at is null", (trip_id, household_id)).fetchone()
            if tr is not None:
                if not name.strip(): name = f"Trip Expense - {tr['name']}"
                c.execute("update trips set saved = case when saved - ? < 0 then 0 else saved - ? end where id=? and household_id=?", (amount, amount, trip_id, household_id))
        except Exception: pass

    due_date_val = request.form["due_date"]
    planned_pay_date_val = (request.form.get("planned_pay_date", "") or "").strip() or due_date_val
    recurring_flag = 1 if request.form.get("recurring") == "on" else 0
    if recurring_flag == 1:
        dupe = c.execute("select id from bills where household_id=? and deleted_at is null and recurring=1 and lower(name)=lower(?)", (household_id, name)).fetchone()
        if dupe: recurring_flag = 0
    recurring_timeframe = (request.form.get("recurring_timeframe", "monthly") or "monthly").strip().lower()
    if recurring_timeframe not in ("monthly", "yearly", "specified_months"): recurring_timeframe = "monthly"
    try:
        recurring_every_months = int((request.form.get("recurring_every_months", "") or "").strip())
        if recurring_every_months < 1: recurring_every_months = None
    except Exception: recurring_every_months = None
    recurring_end_date = (request.form.get("recurring_end_date", "") or "").strip()
    try:
        if recurring_end_date: _ = datetime.strptime(recurring_end_date, "%Y-%m-%d")
        else: recurring_end_date = None
    except Exception: recurring_end_date = None

    c.execute("insert into bills(name,due_date,planned_pay_date,amount,paid,category,recurring,recurring_timeframe,recurring_every_months,recurring_end_date,autopay,household_id) values(?,?,?,?,?,?,?,?,?,?,?,?)", (name, due_date_val, planned_pay_date_val, amount, 0, category, recurring_flag, recurring_timeframe, recurring_every_months if recurring_timeframe == "specified_months" else None, recurring_end_date, 1 if request.form.get("autopay") == "on" else 0, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/bills/update/<int:item_id>")
def bills_update(item_id):
    if not authed(): return redirect(url_for("login"))
    month = normalize_month(request.form.get("month", datetime.now().strftime("%Y-%m")))
    c = conn()
    household_id = active_household_id()
    row = c.execute("select * from bills where id=? and household_id=? and deleted_at is null", (item_id, household_id)).fetchone()
    if row is not None:
        new_due = request.form.get("due_date", row["due_date"])
        try: _ = datetime.strptime(new_due, "%Y-%m-%d")
        except Exception: new_due = row["due_date"]
        try: new_amt = float(request.form.get("amount", row["amount"]))
        except Exception: new_amt = float(row["amount"])
        new_name = request.form.get("name", row["name"]).strip() or row["name"]
        planned_raw = (request.form.get("planned_pay_date", "") or "").strip()
        row_planned = row["planned_pay_date"] if "planned_pay_date" in row.keys() else ""
        new_planned = planned_raw or row_planned or new_due
        new_recurring = 1 if request.form.get("recurring") == "on" else 0
        if new_recurring == 1 and int(row["recurring"] or 0) == 0:
            # Only block if a DIFFERENT bill already has this name as recurring
            dupe = c.execute("select id from bills where household_id=? and deleted_at is null and recurring=1 and lower(name)=lower(?) and id!=?", (household_id, new_name, item_id)).fetchone()
            if dupe: new_recurring = 0
        recurring_timeframe = (request.form.get("recurring_timeframe", "monthly") or "monthly").strip().lower()
        if recurring_timeframe not in ("monthly", "yearly", "specified_months"): recurring_timeframe = "monthly"
        try:
            recurring_every_months = int((request.form.get("recurring_every_months", "") or "").strip())
            if recurring_every_months < 1: recurring_every_months = None
        except Exception: recurring_every_months = None
        recurring_end_date = (request.form.get("recurring_end_date", "") or "").strip()
        try:
            if recurring_end_date: _ = datetime.strptime(recurring_end_date, "%Y-%m-%d")
            else: recurring_end_date = None
        except Exception: recurring_end_date = (row["recurring_end_date"] if "recurring_end_date" in row.keys() else None)
        new_autopay = 1 if request.form.get("autopay") == "on" else 0
        new_paid = 1 if request.form.get("paid") == "on" else 0
        paid_date_raw = (request.form.get("paid_date", "") or "").strip()
        was_paid = int(row["paid"] or 0)
        if new_paid: new_paid_date = paid_date_raw or (row["paid_date"] if "paid_date" in row.keys() else "") or local_now().strftime("%Y-%m-%d")
        else: new_paid_date = None
        pb_raw = request.form.get("paycheck_bucket", "")
        try: new_pb = int(pb_raw) if str(pb_raw).strip() else None
        except Exception: new_pb = None
        prev_planned = (row["planned_pay_date"] if "planned_pay_date" in row.keys() else "") or row["due_date"]
        if new_planned != prev_planned: new_pb = None
        c.execute("update bills set name=?, due_date=?, planned_pay_date=?, amount=?, recurring=?, recurring_timeframe=?, recurring_every_months=?, recurring_end_date=?, autopay=?, paid=?, paid_date=?, paycheck_bucket=? where id=? and household_id=?", (new_name, new_due, new_planned, new_amt, new_recurring, recurring_timeframe, recurring_every_months, recurring_end_date, new_autopay, new_paid, new_paid_date, new_pb, item_id, household_id))
        # Sync ledger: if marked unpaid, remove the "marked paid" ledger entry
        if was_paid == 1 and new_paid == 0:
            c.execute("delete from ledger where household_id=? and label=? and note in ('marked paid','marked paid (mobile)') and abs(amount - ?) < 0.01", (household_id, row["name"], float(row["amount"])))
        # If marking paid and wasn't paid before, add ledger entry
        elif was_paid == 0 and new_paid == 1:
            paid_on = new_paid_date or local_now().strftime("%Y-%m-%d")
            exists = c.execute("select 1 from ledger where household_id=? and label=? and note='marked paid' and tx_date=?", (household_id, row["name"], paid_on)).fetchone()
            if not exists:
                c.execute("insert into ledger(tx_date,label,amount,note,household_id) values(?,?,?,?,?)", (paid_on, row["name"], -abs(float(row["amount"])), "marked paid", household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/bills/postpone/<int:item_id>')
def bills_postpone(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn()
    household_id = active_household_id()
    row = c.execute("select * from bills where id=? and household_id=? and deleted_at is null", (item_id, household_id)).fetchone()
    if row is not None:
        remove_postpone = (request.form.get('remove_postpone', '') or '').strip() == '1'
        postpone_note = (request.form.get('postpone_note', '') or '').strip()
        postpone_date = (request.form.get('postpone_date', '') or '').strip()
        existing_note = (row['note'] if 'note' in row.keys() else '') or ''
        if remove_postpone:
            cleaned_lines = [ln for ln in existing_note.splitlines() if 'postponed' not in ln.lower()]
            cleaned_note = "\n".join(cleaned_lines).strip()
            current_planned = (row['planned_pay_date'] if 'planned_pay_date' in row.keys() else '') or row['due_date']
            c.execute("update bills set planned_pay_date=?, note=? where id=? and household_id=?", (current_planned, cleaned_note, item_id, household_id))
        else:
            new_planned = (row['planned_pay_date'] if 'planned_pay_date' in row.keys() else '') or row['due_date']
            if postpone_date:
                try: _ = datetime.strptime(postpone_date, "%Y-%m-%d"); new_planned = postpone_date
                except Exception: pass
            stamp = local_now().strftime('%m-%d-%Y')
            tagged = f"[{stamp}] Postponed" + (f": {postpone_note}" if postpone_note else "")
            new_note = (existing_note + "\n" + tagged).strip() if existing_note else tagged
            c.execute("update bills set planned_pay_date=?, note=?, paycheck_bucket=NULL where id=? and household_id=?", (new_planned, new_note, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.route('/bills/delete/<int:item_id>', methods=['POST','GET'])
def bills_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn()
    household_id = active_household_id()
    c.execute('update bills set deleted_at=?, deleted_by=? where id=? and household_id=?', (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), current_user_id() or None, item_id, household_id))
    c.commit(); c.close()
    if request.method == 'GET':
        month = normalize_month(request.args.get('month', datetime.now().strftime('%Y-%m')))
        view = request.args.get('view', 'paycheck'); page = request.args.get('page', 'entries')
        return redirect(url_for('dashboard', month=month, view=view, page=page, r=int(datetime.now().timestamp() * 1000)))
    return redirect_dashboard_from_form(request.form)


@app.post('/bills/unset-recurring/<int:item_id>')
def bills_unset_recurring(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn()
    household_id = active_household_id()
    c.execute('update bills set recurring=0 where id=? and household_id=?', (item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/bills/toggle/<int:item_id>")
def bills_toggle(item_id):
    if not authed(): return redirect(url_for("login"))
    c = conn()
    household_id = active_household_id()
    row = c.execute("select * from bills where id=? and household_id=? and deleted_at is null", (item_id, household_id)).fetchone()
    if row is not None:
        if row["paid"] == 0:
            # Mark paid — add ledger entry
            paid_on = local_now().strftime("%Y-%m-%d")
            c.execute("update bills set paid = 1, paid_date=? where id=? and household_id=?", (paid_on, item_id, household_id))
            c.execute("insert into ledger(tx_date,label,amount,note,household_id) values(?,?,?,?,?)", (paid_on, row["name"], -abs(float(row["amount"])), "marked paid", household_id))
        else:
            # Mark unpaid — remove the matching ledger entry
            c.execute("update bills set paid = 0, paid_date=NULL where id=? and household_id=?", (item_id, household_id))
            c.execute("delete from ledger where household_id=? and label=? and note in ('marked paid','marked paid (mobile)') and abs(amount - ?) < 0.01", (household_id, row["name"], float(row["amount"])))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.get("/bills/toggle/<int:item_id>")
def bills_toggle_get_fallback(item_id):
    if not authed(): return redirect(url_for("login"))
    month = normalize_month(request.args.get("month", datetime.now().strftime("%Y-%m")))
    view = request.args.get("view", "paycheck"); page = request.args.get("page", "entries")
    return redirect(url_for("dashboard", month=month, view=view, page=page, r=int(datetime.now().timestamp() * 1000)))


@app.post("/bills/move/<int:item_id>")
def bills_move(item_id):
    if not authed(): return redirect(url_for("login"))
    c = conn(); household_id = active_household_id()
    bucket_raw = request.form.get("paycheck_bucket", "").strip()
    new_bucket = int(bucket_raw) if bucket_raw.isdigit() else None
    c.execute("update bills set paycheck_bucket=? where id=? and household_id=? and deleted_at is null",
              (new_bucket, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/paychecks/add")
def paychecks_add():
    if not authed(): return redirect(url_for("login"))
    c = conn(); household_id = active_household_id()
    c.execute("insert into paychecks(owner,pay_date,amount,income_type,household_id) values(?,?,?,?,?)", (request.form["owner"], request.form["pay_date"], float(request.form["amount"]), "paycheck", household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/paychecks/update/<int:item_id>')
def paychecks_update(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select * from paychecks where id=? and household_id=?', (item_id, household_id)).fetchone()
    if row is None: c.close(); return redirect_dashboard_from_form(request.form)
    owner = request.form.get('owner', row['owner']); pay_date = request.form.get('pay_date', row['pay_date'])
    amount = float(request.form.get('amount', row['amount']) or row['amount'])
    income_type = request.form.get('income_type', row['income_type'] if 'income_type' in row.keys() else 'paycheck')
    if income_type not in ('paycheck', 'other'): income_type = 'paycheck'
    if income_type == 'other': owner = 'Income'
    c.execute('update paychecks set owner=?, pay_date=?, amount=?, income_type=? where id=? and household_id=?', (owner, pay_date, amount, income_type, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/paychecks/delete/<int:item_id>')
def paychecks_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    c.execute('delete from paychecks where id=? and household_id=?', (item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/paycheck-rules/add')
def paycheck_rules_add():
    if not authed(): return redirect(url_for('login'))
    month = normalize_month(request.form.get('month', datetime.now().strftime('%Y-%m')))
    c = conn(); household_id = active_household_id()
    amount_raw = (request.form.get('amount', 0) or 0)
    try: amount = float(str(amount_raw).replace(',', '').strip() or 0)
    except Exception: amount = 0
    cadence = (request.form.get('cadence', 'biweekly') or 'biweekly').strip().lower()
    if cadence not in ('weekly', 'biweekly', 'monthly', 'specified_day'): cadence = 'biweekly'
    day_raw = (request.form.get('day_of_month', '') or '').strip()
    try: day_of_month = int(day_raw) if day_raw else None
    except Exception: day_of_month = None
    if cadence == 'specified_day' and (day_of_month is None or day_of_month < 1 or day_of_month > 31): day_of_month = 1
    timeframe = (request.form.get('timeframe', 'monthly') or 'monthly').strip().lower()
    if timeframe not in ('monthly', 'yearly', 'specified_months'): timeframe = 'monthly'
    months_mask = (request.form.get('months_mask', '') or '').strip()
    next_date = (request.form.get('next_date', '') or '').strip()
    if cadence == 'specified_day': next_date = _date_for_month_day(month, day_of_month)
    c.execute('insert into paycheck_rules(owner,amount,cadence,next_date,active,household_id,day_of_month,timeframe,months_mask) values(?,?,?,?,1,?,?,?,?)', (request.form.get('owner',''), amount, cadence, next_date, household_id, day_of_month, timeframe, months_mask))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/paycheck-rules/delete/<int:item_id>')
def paycheck_rules_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select owner, amount from paycheck_rules where id=? and household_id=?', (item_id, household_id)).fetchone()
    if row is not None:
        c.execute('delete from paychecks where household_id=? and income_type=? and owner=? and amount=?', (household_id, 'paycheck', row['owner'], float(row['amount'] or 0)))
    c.execute('delete from paycheck_rules where id=? and household_id=?', (item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/paycheck-rules/bulk-update')
def paycheck_rules_bulk_update():
    if not authed(): return redirect(url_for('login'))
    month = normalize_month(request.form.get('month', datetime.now().strftime('%Y-%m')))
    c = conn(); household_id = active_household_id()
    ids = request.form.getlist('rule_id'); owners = request.form.getlist('owner')
    amounts = request.form.getlist('amount'); cadences = request.form.getlist('cadence')
    next_dates = request.form.getlist('next_date'); days_of_month = request.form.getlist('day_of_month')
    timeframes = request.form.getlist('timeframe'); months_masks = request.form.getlist('months_mask')
    rows = list(zip(ids, owners, amounts, cadences, next_dates, days_of_month, timeframes, months_masks))
    for rid, owner, amount_raw, cadence, next_date, day_raw, timeframe, months_mask in rows:
        try: item_id = int(rid)
        except Exception: continue
        old = c.execute('select owner, amount from paycheck_rules where id=? and household_id=? and active=1', (item_id, household_id)).fetchone()
        if old is None: continue
        cadence = (cadence or 'biweekly').strip().lower()
        if cadence not in ('weekly', 'biweekly', 'monthly', 'specified_day'): cadence = 'biweekly'
        owner = (owner or '').strip()
        try: amount = float(str(amount_raw or 0).replace(',', '').strip() or 0)
        except Exception: amount = 0
        try: day_of_month = int((day_raw or '').strip()) if (day_raw or '').strip() else None
        except Exception: day_of_month = None
        if cadence == 'specified_day' and (day_of_month is None or day_of_month < 1 or day_of_month > 31): day_of_month = 1
        timeframe = (timeframe or 'monthly').strip().lower()
        if timeframe not in ('monthly', 'yearly', 'specified_months'): timeframe = 'monthly'
        months_mask = (months_mask or '').strip()
        next_date = (next_date or '').strip()
        if cadence == 'specified_day': next_date = _date_for_month_day(month, day_of_month)
        if not owner or not next_date: continue
        c.execute('update paycheck_rules set owner=?, amount=?, cadence=?, next_date=?, day_of_month=?, timeframe=?, months_mask=? where id=? and household_id=? and active=1', (owner, amount, cadence, next_date, day_of_month, timeframe, months_mask, item_id, household_id))
        c.execute('delete from paychecks where household_id=? and income_type=? and owner=? and amount=?', (household_id, 'paycheck', old['owner'], float(old['amount'] or 0)))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/categories/add')
def categories_add():
    if not authed(): return redirect(url_for('login'))
    household_id = active_household_id()
    name = (request.form.get('name', '') or '').strip().lower()
    if name:
        c = conn()
        c.execute('insert or ignore into household_categories(household_id,name) values(?,?)', (household_id, name))
        c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/categories/delete/<int:item_id>')
def categories_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    household_id = active_household_id()
    c = conn()
    row = c.execute('select * from household_categories where id=? and household_id=?', (item_id, household_id)).fetchone()
    if row is not None and row['name'] not in ('bill','debt','trip'):
        c.execute('delete from household_categories where id=? and household_id=?', (item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/paycheck-rules/generate')
def paycheck_rules_generate():
    if not authed(): return redirect(url_for('login'))
    month = normalize_month(request.form.get('month', datetime.now().strftime('%Y-%m')))
    c = conn(); household_id = active_household_id()
    apply_paycheck_rules_for_month(c, household_id, month)
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/ledger/add")
def ledger_add():
    if not authed(): return redirect(url_for("login"))
    c = conn(); household_id = active_household_id()
    c.execute("insert into ledger(tx_date,label,amount,note,household_id) values(?,?,?,?,?)", (request.form["tx_date"], request.form["label"], float(request.form["amount"]), request.form.get("note",""), household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/ledger/update/<int:item_id>')
def ledger_update(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select * from ledger where id=? and household_id=?', (item_id, household_id)).fetchone()
    if row is not None:
        tx_date = request.form.get('tx_date', row['tx_date'])
        label = (request.form.get('label', row['label']) or row['label']).strip()
        note = request.form.get('note', row['note'] or '')
        try: amount = float(request.form.get('amount', row['amount']))
        except Exception: amount = float(row['amount'])
        c.execute('update ledger set tx_date=?, label=?, amount=?, note=? where id=? and household_id=?', (tx_date, label, amount, note, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/ledger/delete/<int:item_id>')
def ledger_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select * from ledger where id=? and household_id=?', (item_id, household_id)).fetchone()
    if row is not None:
        if (row['note'] or '') == 'trip contribution' and float(row['amount'] or 0) < 0:
            label = row['label'] or ''; prefix = 'Trip Contribution - '
            if label.startswith(prefix):
                trip_name = label[len(prefix):].strip()
                if trip_name:
                    c.execute('update trips set saved = case when saved - ? < 0 then 0 else saved - ? end where name=?', (abs(float(row['amount'])), abs(float(row['amount'])), trip_name))
        c.execute('delete from ledger where id=? and household_id=?', (item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/trips/add")
def trips_add():
    if not authed(): return redirect(url_for("login"))
    c = conn(); household_id = active_household_id()
    due_val = request.form["due_month"]
    if len(due_val) == 7: due_val = f"{due_val}-01"
    c.execute("insert into trips(name,due_month,target,saved,household_id) values(?,?,?,?,?)", (request.form["name"], due_val, float(request.form["target"]), float(request.form.get("saved",0)), household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/trips/update/<int:item_id>')
def trips_update(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select * from trips where id=? and household_id=? and deleted_at is null', (item_id, household_id)).fetchone()
    if row is not None:
        name = (request.form.get('name', row['name']) or row['name']).strip()
        due_month = request.form.get('due_month', row['due_month'])
        if len(str(due_month)) == 7: due_month = f"{due_month}-01"
        try: target = float(request.form.get('target', row['target']))
        except Exception: target = float(row['target'])
        try: saved = float(request.form.get('saved', row['saved']))
        except Exception: saved = float(row['saved'])
        c.execute('update trips set name=?, due_month=?, target=?, saved=? where id=? and household_id=?', (name, due_month, target, saved, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/trips/delete/<int:item_id>')
def trips_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    c.execute('update trips set deleted_at=?, deleted_by=? where id=? and household_id=?', (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), current_user_id() or None, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/trips/contribute/<int:item_id>')
def trips_contribute(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select * from trips where id=? and household_id=? and deleted_at is null', (item_id, household_id)).fetchone()
    if row is not None:
        try: amt = abs(float(request.form.get('amount', 0) or 0))
        except Exception: amt = 0
        if amt > 0:
            c.execute('update trips set saved = saved + ? where id=? and household_id=?', (amt, item_id, household_id))
            c.execute('insert into ledger(tx_date,label,amount,note,household_id) values(?,?,?,?,?)', (request.form.get('paid_date', datetime.now().strftime('%Y-%m-%d')), f"Trip Contribution - {row['name']}", -amt, 'trip contribution', household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/promotions/add')
def promotions_add():
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    card_name = (request.form.get('card_name', '') or '').strip()
    promo_name = (request.form.get('promo_name', '') or '').strip()
    start_date = (request.form.get('start_date', '') or '').strip()
    end_date = (request.form.get('end_date', '') or '').strip()
    note = (request.form.get('note', '') or '').strip()
    try: balance = float(request.form.get('balance', 0) or 0)
    except Exception: balance = 0
    if card_name and promo_name and end_date:
        c.execute('insert into promotions(card_name,promo_name,start_date,end_date,balance,note,household_id) values(?,?,?,?,?,?,?)', (card_name, promo_name, start_date, end_date, balance, note, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/promotions/update/<int:item_id>')
def promotions_update(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select * from promotions where id=? and household_id=? and deleted_at is null', (item_id, household_id)).fetchone()
    if row is not None:
        card_name = (request.form.get('card_name', row['card_name']) or row['card_name']).strip()
        promo_name = (request.form.get('promo_name', row['promo_name']) or row['promo_name']).strip()
        start_date = (request.form.get('start_date', row['start_date'] or '') or '').strip()
        end_date = (request.form.get('end_date', row['end_date']) or row['end_date']).strip()
        note = (request.form.get('note', row['note'] or '') or '').strip()
        try: balance = float(request.form.get('balance', row['balance']) or row['balance'])
        except Exception: balance = float(row['balance'])
        c.execute('update promotions set card_name=?, promo_name=?, start_date=?, end_date=?, balance=?, note=? where id=? and household_id=?', (card_name, promo_name, start_date, end_date, balance, note, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/promotions/delete/<int:item_id>')
def promotions_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    c.execute('update promotions set deleted_at=?, deleted_by=? where id=? and household_id=?', (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), current_user_id() or None, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/promotions/complete/<int:item_id>')
def promotions_complete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    c.execute('update promotions set completed=1 where id=? and household_id=?', (item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/promotions/reopen/<int:item_id>')
def promotions_reopen(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    c.execute('update promotions set completed=0 where id=? and household_id=?', (item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/subscriptions/add')
def subscriptions_add():
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    name = (request.form.get('name', '') or '').strip()
    try: day_due = int(request.form.get('day_due', 1) or 1)
    except Exception: day_due = 1
    day_due = max(1, min(31, day_due))
    try: payment = float(request.form.get('payment', 0) or 0)
    except Exception: payment = 0
    recurring = 1 if request.form.get('recurring') == 'on' else 0
    timeframe = (request.form.get('recurring_timeframe', 'monthly') or 'monthly').strip().lower()
    if timeframe not in ('monthly','yearly','specified_months'): timeframe = 'monthly'
    try:
        every = int((request.form.get('recurring_every_months', '') or '').strip())
        if every < 1: every = None
    except Exception: every = None
    try:
        yearly_month = int((request.form.get('yearly_month', '') or '').strip())
        if yearly_month < 1 or yearly_month > 12: yearly_month = None
    except Exception: yearly_month = None
    if name:
        start_date_raw = (request.form.get('start_month', '') or '').strip()
        # Accept full date (YYYY-MM-DD) or YYYY-MM — store as YYYY-MM
        if start_date_raw:
            try:
                if len(start_date_raw) == 10:  # full date
                    start_month = start_date_raw[:7]
                else:
                    start_month = start_date_raw[:7]
            except Exception:
                start_month = datetime.now().strftime('%Y-%m')
        else:
            start_month = datetime.now().strftime('%Y-%m')
        c.execute('insert into subscriptions(name,day_due,payment,household_id,recurring,recurring_timeframe,recurring_every_months,yearly_month,start_month) values(?,?,?,?,?,?,?,?,?)', (name, day_due, payment, household_id, recurring, timeframe, (every if timeframe=='specified_months' else None), (yearly_month if timeframe=='yearly' else None), (start_month if timeframe=='specified_months' else None)))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/subscriptions/update/<int:item_id>')
def subscriptions_update(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    name = (request.form.get('name', '') or '').strip()
    try: day_due = int(request.form.get('day_due', 1) or 1)
    except Exception: day_due = 1
    day_due = max(1, min(31, day_due))
    try: payment = float(request.form.get('payment', 0) or 0)
    except Exception: payment = 0
    recurring = 1 if request.form.get('recurring') == 'on' else 0
    timeframe = (request.form.get('recurring_timeframe', 'monthly') or 'monthly').strip().lower()
    if timeframe not in ('monthly','yearly','specified_months'): timeframe = 'monthly'
    try:
        every = int((request.form.get('recurring_every_months', '') or '').strip())
        if every < 1: every = None
    except Exception: every = None
    try:
        yearly_month = int((request.form.get('yearly_month', '') or '').strip())
        if yearly_month < 1 or yearly_month > 12: yearly_month = None
    except Exception: yearly_month = None
    if name:
        start_date_raw = (request.form.get('start_month', '') or '').strip()
        start_month = start_date_raw[:7] if start_date_raw else None
        c.execute('update subscriptions set name=?, day_due=?, payment=?, recurring=?, recurring_timeframe=?, recurring_every_months=?, yearly_month=?, start_month=? where id=? and household_id=? and deleted_at is null', (name, day_due, payment, recurring, timeframe, (every if timeframe=='specified_months' else None), (yearly_month if timeframe=='yearly' else None), (start_month if timeframe=='specified_months' else None), item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/subscriptions/delete/<int:item_id>')
def subscriptions_delete(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    c.execute('update subscriptions set deleted_at=?, deleted_by=? where id=? and household_id=?', (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), current_user_id() or None, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/credit/add')
def credit_add():
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    card_name = (request.form.get('card_name', '') or '').strip()
    try: interest_rate = float(request.form.get('interest_rate', 0) or 0)
    except Exception: interest_rate = 0
    try: credit_limit = float(request.form.get('credit_limit', 0) or 0)
    except Exception: credit_limit = 0
    if card_name:
        c.execute('insert into credit_accounts(card_name,interest_rate,credit_limit,household_id) values(?,?,?,?)', (card_name, interest_rate, credit_limit, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/credit/toggle-paid/<int:item_id>')
def credit_toggle_paid(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select paid_off from credit_accounts where id=? and household_id=? and deleted_at is null', (item_id, household_id)).fetchone()
    if row is not None:
        new_val = 0 if int(row['paid_off'] or 0) == 1 else 1
        c.execute('update credit_accounts set paid_off=? where id=? and household_id=?', (new_val, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/credit/update/<int:item_id>')
def credit_update(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    card_name = (request.form.get('card_name', '') or '').strip()
    try: interest_rate = float(request.form.get('interest_rate', 0) or 0)
    except Exception: interest_rate = 0
    try: credit_limit = float(request.form.get('credit_limit', 0) or 0)
    except Exception: credit_limit = 0
    paid_off = 1 if request.form.get('paid_off') == 'on' else 0
    if card_name:
        c.execute('update credit_accounts set card_name=?, interest_rate=?, credit_limit=?, paid_off=? where id=? and household_id=? and deleted_at is null', (card_name, interest_rate, credit_limit, paid_off, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/loans/add')
def loans_add():
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    loan_name = (request.form.get('loan_name', '') or '').strip()
    try: interest_rate = float(request.form.get('interest_rate', 0) or 0)
    except Exception: interest_rate = 0
    try: loan_amount = float(request.form.get('loan_amount', 0) or 0)
    except Exception: loan_amount = 0
    loan_note = (request.form.get('note', '') or '').strip()[:24]
    end_date = (request.form.get('end_date', '') or '').strip()
    try:
        if end_date: _ = datetime.strptime(end_date, '%Y-%m-%d')
        else: end_date = None
    except Exception: end_date = None
    if loan_name:
        c.execute('insert into loans(loan_name,interest_rate,loan_amount,note,end_date,household_id) values(?,?,?,?,?,?)', (loan_name, interest_rate, loan_amount, loan_note, end_date, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/loans/toggle-paid/<int:item_id>')
def loans_toggle_paid(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    row = c.execute('select paid_off from loans where id=? and household_id=? and deleted_at is null', (item_id, household_id)).fetchone()
    if row is not None:
        new_val = 0 if int(row['paid_off'] or 0) == 1 else 1
        c.execute('update loans set paid_off=? where id=? and household_id=?', (new_val, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/loans/update/<int:item_id>')
def loans_update(item_id):
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    loan_name = (request.form.get('loan_name', '') or '').strip()
    try: interest_rate = float(request.form.get('interest_rate', 0) or 0)
    except Exception: interest_rate = 0
    try: loan_amount = float(request.form.get('loan_amount', 0) or 0)
    except Exception: loan_amount = 0
    loan_note = (request.form.get('note', '') or '').strip()[:24]
    end_date = (request.form.get('end_date', '') or '').strip()
    try:
        if end_date: _ = datetime.strptime(end_date, '%Y-%m-%d')
        else: end_date = None
    except Exception: end_date = None
    if loan_name:
        c.execute('update loans set loan_name=?, interest_rate=?, loan_amount=?, note=?, end_date=? where id=? and household_id=? and deleted_at is null', (loan_name, interest_rate, loan_amount, loan_note, end_date, item_id, household_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post('/household/invite')
def household_invite():
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    role = (request.form.get('role', 'viewer') or 'viewer').strip().lower()
    if role not in ('viewer', 'editor'): role = 'viewer'
    email = (request.form.get('email', '') or '').strip().lower()
    if not email: c.close(); return redirect_dashboard_from_form(request.form)
    token = secrets.token_urlsafe(24)
    exp = (datetime.now() + timedelta(days=7)).strftime('%Y-%m-%d %H:%M:%S')
    c.execute('insert into household_invites(household_id,email,role,token,expires_at,created_by_user_id,created_at) values(?,?,?,?,?,?,?)', (household_id, email, role, token, exp, current_user_id() or None, datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
    c.commit(); c.close()
    return render_template('invite_created.html', token=token)


@app.route('/household/accept/<token>', methods=['GET', 'POST'])
def household_accept(token):
    if not authed(): return redirect(url_for('login'))
    c = conn()
    inv = c.execute('select * from household_invites where token=? and accepted_at is null', (token,)).fetchone()
    if not inv: c.close(); return 'Invite is invalid or already used.', 400
    if datetime.strptime(inv['expires_at'], '%Y-%m-%d %H:%M:%S') < datetime.now(): c.close(); return 'Invite expired.', 400
    uid = current_user_id()
    user = c.execute('select * from users where id=?', (uid,)).fetchone()
    if not user: c.close(); return 'Login required.', 401
    if (user['email'] or '').strip().lower() != (inv['email'] or '').strip().lower(): c.close(); return 'Invite email does not match your account.', 403
    c.execute('insert or ignore into household_members(household_id,user_id,role,joined_at) values(?,?,?,?)', (inv['household_id'], uid, inv['role'], datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
    c.execute('update household_invites set accepted_at=? where id=?', (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), inv['id']))
    session['household_id'] = int(inv['household_id'])
    c.commit(); c.close()
    return redirect(url_for('dashboard'))


@app.get('/export/excel')
def export_excel():
    if not authed(): return redirect(url_for('login'))
    household_id = active_household_id()
    c = conn()
    try:
        from openpyxl import Workbook
    except Exception:
        c.close(); return ("Excel export dependency missing. Install openpyxl.", 500)
    wb = Workbook(); ws = wb.active; ws.title = "Summary"
    hname_row = c.execute("select name from households where id=?", (household_id,)).fetchone()
    household_name = hname_row["name"] if hname_row else f"Household {household_id}"
    ws.append(["NorthStar Ledger Export"]); ws.append(["Household", household_name]); ws.append(["Generated", datetime.now().strftime('%Y-%m-%d %H:%M:%S')])
    exports = [
        ("Bills", "select name,due_date,planned_pay_date,amount,paid,category,recurring,autopay,paid_date from bills where household_id=? and deleted_at is null order by due_date,id"),
        ("Paychecks", "select owner,pay_date,amount,income_type from paychecks where household_id=? order by pay_date,id"),
        ("Ledger", "select tx_date,label,amount,note from ledger where household_id=? order by tx_date,id"),
        ("Trips", "select name,due_month,target,saved from trips where household_id=? and deleted_at is null order by due_month,id"),
        ("Promotions", "select card_name,promo_name,start_date,end_date,balance,completed,note from promotions where household_id=? and deleted_at is null order by end_date,id"),
    ]
    for sheet_name, query in exports:
        rows = c.execute(query, (household_id,)).fetchall()
        sh = wb.create_sheet(title=sheet_name)
        if not rows: sh.append(["No data"]); continue
        headers = list(rows[0].keys()); sh.append(headers)
        for r in rows: sh.append([r[k] for k in headers])
    c.close()
    bio = io.BytesIO(); wb.save(bio); bio.seek(0)
    filename = f"northstar-export-h{household_id}-{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    resp = Response(bio.getvalue(), mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    resp.headers['Content-Disposition'] = f'attachment; filename={filename}'
    return resp


@app.post('/dashboard-note/update')
def dashboard_note_update():
    if not authed(): return redirect(url_for('login'))
    c = conn(); household_id = active_household_id()
    note_text = (request.form.get('dashboard_note_text', '') or '').strip()
    now_ts = local_now().strftime('%Y-%m-%d %H:%M:%S')
    c.execute("insert into dashboard_notes(household_id,note_text,updated_at) values(?,?,?) on conflict(household_id) do update set note_text=excluded.note_text, updated_at=excluded.updated_at", (household_id, note_text, now_ts))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/settings/update")
def settings_update():
    if not authed(): return redirect(url_for("login"))
    c = conn(); household_id = active_household_id()
    if request.form.get("min_buffer") is not None:
        c.execute("insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (setting_key(household_id, 'min_buffer'), request.form.get("min_buffer", "150")))
    theme = request.form.get("accent_theme", "blue")
    if theme not in THEMES: theme = "blue"
    c.execute("insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (setting_key(household_id, 'accent_theme'), theme))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/settings/starting-balance")
def settings_starting_balance():
    if not authed(): return redirect(url_for("login"))
    c = conn(); household_id = active_household_id()
    month = normalize_month(request.form.get("month", datetime.now().strftime("%Y-%m")))
    view = request.form.get("view", "paycheck"); page = request.form.get("page", "entries")
    target_month = normalize_month(request.form.get("starting_balance_month", month))
    amount = request.form.get("starting_balance", "0")
    month_key = setting_key(household_id, f"starting_balance:{target_month}")
    c.execute("insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (month_key, amount))
    c.commit(); c.close()
    return redirect(url_for("dashboard", month=target_month, view=view, page=page, r=int(datetime.now().timestamp() * 1000), anchor="planner"))


@app.post("/balance/adjust")
def balance_adjust():
    if not authed(): return redirect(url_for("login"))
    c = conn(); household_id = active_household_id()
    month = normalize_month(request.form.get("month", datetime.now().strftime("%Y-%m")))
    view = request.form.get("view", "paycheck")

    try:
        new_balance = float(request.form.get("new_balance", "0") or "0")
    except Exception:
        new_balance = 0.0
    note = (request.form.get("adjustment_note", "") or "").strip()

    adj_date = (request.form.get("adjustment_date", "") or "").strip()
    try:
        datetime.strptime(adj_date, "%Y-%m-%d")
    except Exception:
        adj_date = local_now().strftime("%Y-%m-%d")

    # Store the target balance directly as snap_balance — the planner will teleport running to this value
    full_note = f"Balance set to ${new_balance:,.2f}"
    if note:
        full_note += f" — {note}"
    c.execute(
        "insert into bills(name,due_date,planned_pay_date,amount,paid,paid_date,category,note,snap_balance,recurring,autopay,household_id) "
        "values(?,?,?,0,1,?,'adjustment',?,?,0,0,?)",
        ("Balance Adjustment", adj_date, adj_date, adj_date, full_note, round(new_balance, 2), household_id)
    )

    c.commit(); c.close()
    return redirect(url_for("dashboard", month=month, view=view, page="entries", r=int(datetime.now().timestamp() * 1000)))

@app.post("/rollover")
def rollover():
    if not authed(): return redirect(url_for("login"))
    tgt = normalize_month(request.form.get("month", datetime.now().strftime("%Y-%m")))
    src = request.form.get("source_month", "")
    if len(src) != 7: src, _ = month_prev_next(tgt)
    c = conn(); household_id = active_household_id()
    rows = c.execute("select id,name,due_date,amount,category,recurring,autopay,coalesce(recurring_timeframe,'monthly') as recurring_timeframe,recurring_every_months, recurring_end_date from bills where household_id=? and deleted_at is null and recurring=1", (household_id,)).fetchall()

    def _month_index(ym):
        y, m = [int(x) for x in ym.split('-')]
        return y * 12 + m

    tgt_idx = _month_index(tgt)
    for r in rows:
        base_ym = (r["due_date"] or "")[:7]
        if len(base_ym) != 7: continue
        base_idx = _month_index(base_ym)
        diff = tgt_idx - base_idx
        if diff < 0: continue
        timeframe = (r["recurring_timeframe"] or "monthly").strip().lower()
        if timeframe == "yearly": interval = 12
        elif timeframe == "specified_months":
            try: interval = int(r["recurring_every_months"] or 1)
            except Exception: interval = 1
            if interval < 1: interval = 1
        else: interval = 1
        if diff % interval != 0: continue
        end_ym = str(r["recurring_end_date"] or "")[:7]
        if len(end_ym) == 7 and end_ym < tgt: continue
        day = int((r["due_date"] or "1970-01-01").split("-")[-1])
        y, m = [int(x) for x in tgt.split('-')]
        day = max(1, min(day, calendar.monthrange(y, m)[1]))
        new_due = f"{y:04d}-{m:02d}-{day:02d}"
        exists = c.execute("select 1 from bills where household_id=? and name=? and due_date=? and amount=? and category=?", (household_id, r["name"], new_due, r["amount"], r["category"])).fetchone()
        if not exists:
            c.execute("insert into bills(name,due_date,amount,paid,category,recurring,recurring_timeframe,recurring_every_months,recurring_end_date,autopay,household_id) values(?,?,?,?,?,?,?,?,?,?,?)", (r["name"], new_due, r["amount"], 0, r["category"], r["recurring"], timeframe, (r["recurring_every_months"] if timeframe=='specified_months' else None), r["recurring_end_date"], r["autopay"], household_id))

    apply_paycheck_rules_for_month(c, household_id, tgt)
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


# ── FEEDBACK ROUTES ──────────────────────────────────────────────────────────

@app.post("/feedback/submit")
def feedback_submit():
    if not authed(): return redirect(url_for("login"))
    subject = (request.form.get("subject", "") or "").strip()[:120]
    message = (request.form.get("message", "") or "").strip()
    if not message:
        return redirect_dashboard_from_form(request.form)
    c = conn()
    household_id = active_household_id()
    uid = current_user_id() or None
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    feedback_type = (request.form.get("feedback_type", "feedback") or "feedback").strip()
    if feedback_type not in ("feedback", "review"):
        feedback_type = "feedback"
    c.execute(
        "insert into feedback(user_id,household_id,subject,message,feedback_type,is_read,created_at) values(?,?,?,?,?,0,?)",
        (uid, household_id, subject, message, feedback_type, now)
    )
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/feedback/settype/<int:item_id>")
def admin_feedback_settype(item_id):
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    feedback_type = (request.form.get("feedback_type", "") or "").strip()
    if feedback_type not in ("feedback", "review", ""):
        feedback_type = ""
    c = conn()
    # Also mark as read when categorized
    c.execute("update feedback set feedback_type=?, is_read=1 where id=?", (feedback_type or None, item_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/feedback/read/<int:item_id>")
def admin_feedback_read(item_id):
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    c = conn()
    c.execute("update feedback set is_read=1 where id=?", (item_id,))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/feedback/delete/<int:item_id>")
def admin_feedback_delete(item_id):
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    c = conn()
    c.execute("delete from feedback where id=?", (item_id,))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


# ── ADMIN ROUTES ─────────────────────────────────────────────────────────────

@app.post("/admin/banner/save")
def admin_banner_save():
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    enabled = 1 if request.form.get("banner_enabled") == "1" else 0
    text = (request.form.get("banner_text", "") or "").strip()
    start_date = (request.form.get("banner_start_date", "") or "").strip() or None
    end_date = (request.form.get("banner_end_date", "") or "").strip() or None
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c = conn()
    c.execute("update site_banner set enabled=?, text=?, start_date=?, end_date=?, updated_at=? where id=1",
              (enabled, text, start_date, end_date, now))
    # Log this banner to history if it has text and isn't a duplicate of the last entry
    if text:
        last = c.execute("select text from banner_history order by id desc limit 1").fetchone()
        if not last or last["text"] != text:
            c.execute("insert into banner_history(text,start_date,end_date,saved_at) values(?,?,?,?)",
                      (text, start_date, end_date, now))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/update-log/add")
def admin_update_log_add():
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    version = (request.form.get("version", "") or "").strip()
    title = (request.form.get("title", "") or "").strip()
    body = (request.form.get("body", "") or "").strip()
    if version and title:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        c = conn()
        c.execute("insert into update_log(version,title,body,created_at) values(?,?,?,?)",
                  (version, title, body, now))
        c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/update-log/update/<int:item_id>")
def admin_update_log_update(item_id):
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    version = (request.form.get("version", "") or "").strip()
    title = (request.form.get("title", "") or "").strip()
    body = (request.form.get("body", "") or "").strip()
    if version and title:
        c = conn()
        c.execute("update update_log set version=?, title=?, body=? where id=?",
                  (version, title, body, item_id))
        c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/update-log/delete/<int:item_id>")
def admin_update_log_delete(item_id):
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    c = conn()
    c.execute("delete from update_log where id=?", (item_id,))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/user/toggle-admin/<int:user_id>")
def admin_user_toggle_admin(user_id):
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    c = conn()
    row = c.execute("select is_admin from users where id=?", (user_id,)).fetchone()
    if row:
        new_val = 0 if int(row["is_admin"] or 0) == 1 else 1
        # Prevent removing your own admin
        if user_id != current_user_id():
            c.execute("update users set is_admin=? where id=?", (new_val, user_id))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


@app.post("/admin/user/delete/<int:user_id>")
def admin_user_delete(user_id):
    if not authed() or not is_admin_user(): return ("Forbidden", 403)
    if user_id == current_user_id(): return ("Cannot delete your own account", 400)
    c = conn()
    c.execute("delete from household_members where user_id=?", (user_id,))
    c.execute("delete from users where id=?", (user_id,))
    c.commit(); c.close()
    return redirect_dashboard_from_form(request.form)


# Ensure schema migrations run under both direct run and gunicorn import.
init_db()

if __name__ == "__main__":
    app.run(host=APP_HOST, port=APP_PORT, debug=False)
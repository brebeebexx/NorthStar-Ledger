from flask import (
    Flask, render_template, request, redirect, url_for,
    session, jsonify, g
)
from werkzeug.security import generate_password_hash, check_password_hash
from database import get_db, init_db
from datetime import datetime, date, timedelta
from calendar import monthrange
import functools
import json
import jwt as pyjwt

app = Flask(__name__)
app.secret_key = 'CHANGE-THIS-SECRET-KEY-BEFORE-DEPLOYING'
JWT_SECRET = 'NSL-JWT-SECRET-CHANGE-BEFORE-DEPLOY'
JWT_ALGO   = 'HS256'
JWT_EXPIRY_DAYS = 90


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_jwt_user_id():
    """Extract user_id from Bearer token. Returns None if invalid/missing."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    token = auth[7:]
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        return payload.get('user_id')
    except pyjwt.ExpiredSignatureError:
        return None
    except pyjwt.InvalidTokenError:
        return None


def _jwt_or_session_uid():
    """Return user_id from session or JWT, whichever is present."""
    if 'user_id' in session:
        return session['user_id']
    return _get_jwt_user_id()


def login_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        uid = _jwt_or_session_uid()
        if uid is None:
            # If this looks like an API/mobile call, return JSON error
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
        # Inject uid into session-like access for handlers that use session['user_id']
        if 'user_id' not in session:
            session['user_id'] = uid
        return f(*args, **kwargs)
    return decorated


def _make_jwt(user_id):
    payload = {
        'user_id': user_id,
        'exp': datetime.utcnow() + timedelta(days=JWT_EXPIRY_DAYS)
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def admin_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        db = get_db()
        user = db.execute('SELECT is_admin FROM users WHERE id=?', (session['user_id'],)).fetchone()
        db.close()
        if not user or not user['is_admin']:
            return redirect(url_for('app_main'))
        return f(*args, **kwargs)
    return decorated


def current_user():
    if 'user_id' not in session:
        return None
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE id=?', (session['user_id'],)).fetchone()
    db.close()
    return user


# ─────────────────────────────────────────────────────────────────────────────
# Public routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('app_main'))
    return render_template('index.html')


@app.route('/privacy')
def privacy():
    return render_template('privacy.html')


@app.route('/support')
def support():
    return render_template('support.html')


# ─────────────────────────────────────────────────────────────────────────────
# Auth routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/register', methods=['GET', 'POST'])
def register():
    if 'user_id' in session:
        return redirect(url_for('app_main'))
    error = None
    if request.method == 'POST':
        name      = request.form.get('name', '').strip()
        email     = request.form.get('email', '').strip().lower()
        password  = request.form.get('password', '')
        confirm   = request.form.get('confirm_password', '')
        sec_q1    = request.form.get('security_q1', '')
        sec_a1    = request.form.get('security_a1', '').strip().lower()
        sec_q2    = request.form.get('security_q2', '')
        sec_a2    = request.form.get('security_a2', '').strip().lower()

        if not all([name, email, password, sec_q1, sec_a1, sec_q2, sec_a2]):
            error = 'All fields are required.'
        elif password != confirm:
            error = 'Passwords do not match.'
        elif len(password) < 8:
            error = 'Password must be at least 8 characters.'
        else:
            db = get_db()
            existing = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
            if existing:
                error = 'An account with that email already exists.'
            else:
                pw_hash = generate_password_hash(password, method='pbkdf2:sha256')
                db.execute(
                    '''INSERT INTO users (name, email, password_hash,
                       security_q1, security_a1, security_q2, security_a2)
                       VALUES (?,?,?,?,?,?,?)''',
                    (name, email, pw_hash, sec_q1, sec_a1, sec_q2, sec_a2)
                )
                conn = db
                conn.commit()
                user = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
                session['user_id']   = user['id']
                session['user_name'] = name
                db.close()
                return redirect(url_for('app_main'))
            db.close()
    return render_template('register.html', error=error)


@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('app_main'))
    error = None
    if request.method == 'POST':
        email    = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        db       = get_db()
        user     = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        if not user or not check_password_hash(user['password_hash'], password):
            error = 'Invalid email or password.'
        elif user['deleted_at']:
            error = 'This account has been deleted.'
        else:
            db.execute('UPDATE users SET last_login=? WHERE id=?',
                       (datetime.utcnow(), user['id']))
            db.commit()
            session['user_id']   = user['id']
            session['user_name'] = user['name']
            session['is_admin']  = bool(user['is_admin'])
            db.close()
            return redirect(url_for('app_main'))
        db.close()
    return render_template('login.html', error=error)


@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    step  = request.args.get('step', '1')
    error = None
    data  = {}

    if request.method == 'POST':
        step = request.form.get('step', '1')

        if step == '1':
            email = request.form.get('email', '').strip().lower()
            db    = get_db()
            user  = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
            db.close()
            if not user:
                error = 'No account found with that email.'
            else:
                return render_template('forgot_password.html', step='2',
                                       email=email,
                                       q1=user['security_q1'],
                                       q2=user['security_q2'])

        elif step == '2':
            email = request.form.get('email', '').strip().lower()
            a1    = request.form.get('answer1', '').strip().lower()
            a2    = request.form.get('answer2', '').strip().lower()
            db    = get_db()
            user  = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
            db.close()
            def _check_sec(stored, provided):
                """Support both plain-text answers (new accounts) and pbkdf2 hashes (migrated accounts)."""
                if stored and stored.startswith('pbkdf2:'):
                    return check_password_hash(stored, provided)
                return stored == provided
            if not user or not _check_sec(user['security_a1'], a1) or not _check_sec(user['security_a2'], a2):
                error = 'Incorrect answers. Please try again.'
                return render_template('forgot_password.html', step='2',
                                       email=email,
                                       q1=user['security_q1'] if user else '',
                                       q2=user['security_q2'] if user else '',
                                       error=error)
            return render_template('forgot_password.html', step='3', email=email)

        elif step == '3':
            email    = request.form.get('email', '').strip().lower()
            password = request.form.get('password', '')
            confirm  = request.form.get('confirm_password', '')
            if password != confirm:
                error = 'Passwords do not match.'
                return render_template('forgot_password.html', step='3',
                                       email=email, error=error)
            if len(password) < 8:
                error = 'Password must be at least 8 characters.'
                return render_template('forgot_password.html', step='3',
                                       email=email, error=error)
            db = get_db()
            db.execute('UPDATE users SET password_hash=? WHERE email=?',
                       (generate_password_hash(password, method='pbkdf2:sha256'), email))
            db.commit()
            db.close()
            return redirect(url_for('login', reset='1'))

    return render_template('forgot_password.html', step='1', error=error)


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/api/account/delete', methods=['DELETE'])
@login_required
def delete_own_account():
    uid = session['user_id']
    db  = get_db()
    from datetime import datetime
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
    db.execute('UPDATE users SET deleted_at=? WHERE id=?', (now, uid))
    db.commit()
    db.close()
    session.clear()
    return jsonify({'success': True})


# ─────────────────────────────────────────────────────────────────────────────
# Main app
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/app')
@login_required
def app_main():
    uid = session['user_id']
    db  = get_db()

    # Load all data needed for initial render
    paychecks = [dict(r) for r in db.execute(
        'SELECT * FROM paychecks WHERE user_id=? ORDER BY date DESC', (uid,)
    ).fetchall()]

    bills = [dict(r) for r in db.execute(
        'SELECT b.*, p.date as paycheck_date FROM bills b '
        'LEFT JOIN paychecks p ON b.paycheck_id=p.id '
        'WHERE b.user_id=? ORDER BY b.planned_pay_date ASC', (uid,)
    ).fetchall()]

    savings_goals = [dict(r) for r in db.execute(
        'SELECT * FROM savings_goals WHERE user_id=? ORDER BY created_at DESC', (uid,)
    ).fetchall()]

    debt_accounts = [dict(r) for r in db.execute(
        'SELECT * FROM debt_accounts WHERE user_id=? ORDER BY created_at DESC', (uid,)
    ).fetchall()]

    subscriptions = [dict(r) for r in db.execute(
        'SELECT * FROM subscriptions WHERE user_id=? ORDER BY next_due_date IS NULL ASC, next_due_date ASC, name ASC', (uid,)
    ).fetchall()]

    bill_names = [dict(r) for r in db.execute(
        'SELECT * FROM bill_names WHERE user_id=? ORDER BY name ASC', (uid,)
    ).fetchall()]

    balance_adjustments = [dict(r) for r in db.execute(
        'SELECT * FROM balance_adjustments WHERE user_id=? ORDER BY created_at DESC', (uid,)
    ).fetchall()]

    _user_row = db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
    if _user_row is None:
        db.close()
        session.clear()
        return redirect(url_for('login'))
    user = dict(_user_row)

    sticky_notes = [dict(r) for r in db.execute(
        'SELECT * FROM sticky_notes WHERE user_id=? ORDER BY updated_at DESC', (uid,)
    ).fetchall()]

    snapshots = [dict(r) for r in db.execute(
        'SELECT * FROM snapshots WHERE user_id=? ORDER BY month ASC', (uid,)
    ).fetchall()]

    unread_count = db.execute(
        "SELECT COUNT(*) as cnt FROM help_messages WHERE user_id=? AND status='unread'", (uid,)
    ).fetchone()['cnt']

    db.close()

    today = date.today().isoformat()
    tab   = request.args.get('tab', 'dashboard')

    return render_template('app.html',
        user=user,
        paychecks=paychecks,
        bills=bills,
        savings_goals=savings_goals,
        debt_accounts=debt_accounts,
        subscriptions=subscriptions,
        bill_names=bill_names,
        balance_adjustments=balance_adjustments,
        sticky_notes=sticky_notes,
        snapshots=snapshots,
        unread_count=unread_count,
        today=today,
        active_tab=tab
    )


# ─────────────────────────────────────────────────────────────────────────────
# API – Snapshots
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/snapshots', methods=['GET', 'POST'])
@login_required
def snapshots_api():
    uid = session['user_id']
    db  = get_db()
    if request.method == 'GET':
        rows = [dict(r) for r in db.execute(
            'SELECT * FROM snapshots WHERE user_id=? ORDER BY month ASC', (uid,)
        ).fetchall()]
        db.close()
        return jsonify(rows)

    data         = request.get_json()
    month        = data.get('month')
    total_debt   = data.get('total_debt', 0)
    total_savings= data.get('total_savings', 0)
    net_worth    = total_savings - total_debt
    # Insert or replace (upsert) for the given month
    db.execute('''INSERT INTO snapshots (user_id, month, total_debt, total_savings, net_worth)
                  VALUES (?,?,?,?,?)
                  ON CONFLICT(user_id, month) DO UPDATE SET
                    total_debt=excluded.total_debt,
                    total_savings=excluded.total_savings,
                    net_worth=excluded.net_worth,
                    created_at=CURRENT_TIMESTAMP''',
               (uid, month, total_debt, total_savings, net_worth))
    db.commit()
    row = db.execute('SELECT * FROM snapshots WHERE user_id=? AND month=?', (uid, month)).fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/snapshots/<int:sid>', methods=['DELETE'])
@login_required
def delete_snapshot(sid):
    uid = session['user_id']
    db  = get_db()
    db.execute('DELETE FROM snapshots WHERE id=? AND user_id=?', (sid, uid))
    db.commit()
    db.close()
    return jsonify({'success': True})


# ─────────────────────────────────────────────────────────────────────────────
# API – Paychecks
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/paychecks', methods=['POST'])
@login_required
def add_paycheck():
    uid  = session['user_id']
    data = request.get_json()
    db   = get_db()
    db.execute('INSERT INTO paychecks (user_id, date, amount, notes, income_type) VALUES (?,?,?,?,?)',
               (uid, data['date'], data['amount'], data.get('notes', ''), data.get('income_type', 'paycheck')))
    db.commit()
    row = db.execute('SELECT * FROM paychecks WHERE user_id=? ORDER BY id DESC LIMIT 1', (uid,)).fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/paychecks/<int:pid>', methods=['PUT', 'DELETE'])
@login_required
def manage_paycheck(pid):
    uid = session['user_id']
    db  = get_db()
    # Verify ownership
    row = db.execute('SELECT * FROM paychecks WHERE id=? AND user_id=?', (pid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'DELETE':
        db.execute('DELETE FROM paychecks WHERE id=?', (pid,))
        db.commit()
        db.close()
        return jsonify({'success': True})

    data = request.get_json()
    db.execute('UPDATE paychecks SET date=?, amount=?, notes=?, income_type=? WHERE id=?',
               (data['date'], data['amount'], data.get('notes', ''), data.get('income_type', row['income_type'] or 'paycheck'), pid))
    db.commit()
    row = db.execute('SELECT * FROM paychecks WHERE id=?', (pid,)).fetchone()
    db.close()
    return jsonify(dict(row))


# ─────────────────────────────────────────────────────────────────────────────
# API – Bills
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/bills', methods=['POST'])
@login_required
def add_bill():
    uid  = session['user_id']
    data = request.get_json()
    db   = get_db()

    name     = data['name'].strip()
    category = data.get('category', 'bill')

    # Upsert bill_name
    existing_name = db.execute(
        'SELECT id FROM bill_names WHERE user_id=? AND name=?', (uid, name)
    ).fetchone()
    if existing_name:
        bill_name_id = existing_name['id']
    else:
        db.execute('INSERT INTO bill_names (user_id, name, category) VALUES (?,?,?)',
                   (uid, name, category))
        bill_name_id = db.execute(
            'SELECT id FROM bill_names WHERE user_id=? AND name=?', (uid, name)
        ).fetchone()['id']

    is_recurring = 1 if data.get('is_recurring') else 0
    # Caller may pass is_template=0 explicitly (e.g. import recurring creates instances, not templates)
    # Default: a brand-new recurring bill added manually is always the canonical template
    if 'is_template' in data:
        is_template = 1 if data['is_template'] else 0
    else:
        is_template = 1 if is_recurring else 0

    db.execute('''INSERT INTO bills
        (user_id, paycheck_id, bill_name_id, name, amount, due_date,
         planned_pay_date, is_recurring, autopay, category, savings_goal_id, month, notes, frequency, is_template)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (uid,
         data.get('paycheck_id'),
         bill_name_id,
         name,
         data['amount'],
         data.get('due_date'),
         data.get('planned_pay_date'),
         is_recurring,
         1 if data.get('autopay') else 0,
         category,
         data.get('savings_goal_id'),
         data.get('month', date.today().strftime('%Y-%m')),
         data.get('notes', ''),
         data.get('frequency', 'monthly'),
         is_template)
    )
    db.commit()

    # If it's a savings bill, update goal amount
    goal_id = data.get('savings_goal_id')
    if goal_id and category in ('savings', 'trip'):
        db.execute('UPDATE savings_goals SET current_amount = current_amount + ? WHERE id=? AND user_id=?',
                   (data['amount'], goal_id, uid))
        db.commit()

    row = db.execute('SELECT * FROM bills WHERE user_id=? ORDER BY id DESC LIMIT 1', (uid,)).fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/bills/<int:bid>/stop-recurring', methods=['POST'])
@login_required
def stop_recurring_bill(bid):
    """Stop a recurring bill: marks the template as non-recurring and deletes this instance."""
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM bills WHERE id=? AND user_id=?', (bid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    # Mark the template(s) for this bill as non-recurring — this stops future generation
    if row['bill_name_id']:
        db.execute('UPDATE bills SET is_recurring=0 WHERE user_id=? AND bill_name_id=? AND is_template=1',
                   (uid, row['bill_name_id']))
    else:
        db.execute('UPDATE bills SET is_recurring=0 WHERE user_id=? AND name=? AND is_template=1',
                   (uid, row['name']))
    # Delete only the instance (not the template itself, so history is preserved)
    if not row['is_template']:
        db.execute('DELETE FROM bills WHERE id=?', (bid,))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/bills/<int:bid>', methods=['PUT', 'DELETE'])
@login_required
def manage_bill(bid):
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM bills WHERE id=? AND user_id=?', (bid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'DELETE':
        # Protect recurring templates — use stop-recurring endpoint to change them
        if row['is_template'] and row['is_recurring']:
            db.close()
            return jsonify({'error': 'Cannot delete a recurring template directly. Use stop-recurring instead.'}), 400
        # If savings bill, subtract from goal
        if row['savings_goal_id'] and row['category'] in ('savings', 'trip'):
            db.execute('UPDATE savings_goals SET current_amount = MAX(0, current_amount - ?) WHERE id=?',
                       (row['amount'], row['savings_goal_id']))
        db.execute('DELETE FROM bills WHERE id=?', (bid,))
        db.commit()
        db.close()
        return jsonify({'success': True})

    data = request.get_json()
    db.execute('''UPDATE bills SET
        paycheck_id=?, name=?, amount=?, due_date=?, planned_pay_date=?,
        is_paid=?, is_postponed=?, is_recurring=?, autopay=?, category=?,
        savings_goal_id=?, notes=?, frequency=?, paid_date=?
        WHERE id=?''',
        (data.get('paycheck_id', row['paycheck_id']),
         data.get('name', row['name']),
         data.get('amount', row['amount']),
         data.get('due_date', row['due_date']),
         data.get('planned_pay_date', row['planned_pay_date']),
         1 if data.get('is_paid') else 0,
         1 if data.get('is_postponed') else 0,
         1 if data.get('is_recurring') else 0,
         1 if data.get('autopay') else 0,
         data.get('category', row['category']),
         data.get('savings_goal_id', row['savings_goal_id']),
         data.get('notes', row['notes']),
         data.get('frequency', row['frequency'] or 'monthly'),
         data.get('paid_date', row['paid_date']),
         bid)
    )
    db.commit()
    updated = db.execute('SELECT * FROM bills WHERE id=?', (bid,)).fetchone()
    db.close()
    return jsonify(dict(updated))


@app.route('/api/bills/<int:bid>/pay', methods=['POST'])
@login_required
def mark_bill_paid(bid):
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM bills WHERE id=? AND user_id=?', (bid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    data       = request.get_json() or {}
    # Toggle paid — record paid_date when marking paid, clear when unmarking
    new_status   = 0 if row['is_paid'] else 1
    paid_date    = date.today().isoformat() if new_status else None
    # When marking paid, allow caller to pass a paycheck_id to reassign the bill
    # When unmarking, restore original paycheck assignment (caller passes it back)
    new_paycheck = data.get('paycheck_id', row['paycheck_id'])
    db.execute('UPDATE bills SET is_paid=?, is_postponed=0, paid_date=?, paycheck_id=? WHERE id=?',
               (new_status, paid_date, new_paycheck, bid))
    db.commit()
    db.close()
    return jsonify({'is_paid': new_status, 'paid_date': paid_date, 'paycheck_id': new_paycheck})


@app.route('/api/bills/<int:bid>/paid-date', methods=['POST'])
@login_required
def update_paid_date(bid):
    uid  = session['user_id']
    db   = get_db()
    row  = db.execute('SELECT * FROM bills WHERE id=? AND user_id=?', (bid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    data         = request.get_json()
    paid_date    = data.get('paid_date')
    new_paycheck = data.get('paycheck_id', row['paycheck_id'])
    db.execute('UPDATE bills SET paid_date=?, paycheck_id=? WHERE id=?', (paid_date, new_paycheck, bid))
    db.commit()
    db.close()
    return jsonify({'paid_date': paid_date, 'paycheck_id': new_paycheck})


@app.route('/api/bills/<int:bid>/postpone', methods=['POST'])
@login_required
def postpone_bill(bid):
    uid  = session['user_id']
    data = request.get_json()
    db   = get_db()
    row  = db.execute('SELECT * FROM bills WHERE id=? AND user_id=?', (bid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    new_date = data.get('new_date', row['planned_pay_date'])
    db.execute('UPDATE bills SET is_postponed=1, is_paid=0, planned_pay_date=? WHERE id=?',
               (new_date, bid))
    db.commit()
    db.close()
    return jsonify({'success': True, 'new_date': new_date})


@app.route('/api/bills/<int:bid>/unpostpone', methods=['POST'])
@login_required
def unpostpone_bill(bid):
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM bills WHERE id=? AND user_id=?', (bid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    db.execute('UPDATE bills SET is_postponed=0 WHERE id=? AND user_id=?', (bid, uid))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/bills/generate-recurring', methods=['POST'])
@login_required
def generate_recurring():
    """Generate recurring bills for a given month if not already present."""
    uid  = session['user_id']
    data = request.get_json()
    month = data.get('month', date.today().strftime('%Y-%m'))

    db = get_db()
    # Only read canonical templates — never monthly instances
    recurring = db.execute(
        "SELECT * FROM bills WHERE user_id=? AND is_recurring=1 AND is_template=1 "
        "ORDER BY name ASC",
        (uid,)
    ).fetchall()

    # Load all paychecks for auto-assignment (sorted oldest → newest)
    paychecks = db.execute(
        "SELECT id, date FROM paychecks WHERE user_id=? ORDER BY date ASC",
        (uid,)
    ).fetchall()

    def auto_assign_paycheck(due_date_str):
        """Mirror of JS autoAssignPaycheck: most recent paycheck on or before due date."""
        if not due_date_str or not paychecks:
            return None
        best = None
        for p in paychecks:
            if p['date'] <= due_date_str:
                best = p['id']
        if best is None:
            best = paychecks[0]['id']  # all paychecks are after due date → use earliest
        return best

    def due_date_for_month(template_date_str, target_month):
        """Shift a template date into the target month, preserving the day-of-month."""
        if not template_date_str:
            return None
        try:
            day = int(template_date_str[8:10])
            ty, tm = int(target_month[:4]), int(target_month[5:7])
            day = min(day, monthrange(ty, tm)[1])  # clamp to valid days (e.g. Feb 28/29)
            return f"{ty:04d}-{tm:02d}-{day:02d}"
        except Exception:
            return None

    # Group by bill_name_id, keep latest
    seen = {}
    for b in recurring:
        key = b['bill_name_id'] or b['name']
        if key not in seen:
            seen[key] = b

    # Helper: check if a template is due in the target month given its frequency
    freq_months_map = {'monthly': 1, 'bimonthly': 2, 'quarterly': 3, 'semiannual': 6, 'annual': 12}
    def is_due_this_month(template, target_month):
        freq = (template['frequency'] or 'monthly')
        n = freq_months_map.get(freq, 1)
        if n == 1:
            return True
        anchor_date = template['due_date'] or template['planned_pay_date']
        if not anchor_date:
            return True
        anchor = anchor_date[:7]
        ay, am = int(anchor[:4]), int(anchor[5:7])
        ty, tm = int(target_month[:4]), int(target_month[5:7])
        diff = (ty - ay) * 12 + (tm - am)
        return diff >= 0 and diff % n == 0

    created = 0
    for key, template in seen.items():
        # Skip if not due this month based on frequency
        if not is_due_this_month(template, month):
            continue
        # Check if already exists for this month
        existing = db.execute(
            "SELECT id FROM bills WHERE user_id=? AND bill_name_id=? AND month=?",
            (uid, template['bill_name_id'], month)
        ).fetchone()
        if not existing:
            # Calculate due/planned date in target month and auto-assign paycheck
            template_anchor = template['due_date'] or template['planned_pay_date']
            due   = due_date_for_month(template_anchor, month)
            paycheck_id = auto_assign_paycheck(due)

            db.execute('''INSERT INTO bills
                (user_id, paycheck_id, bill_name_id, name, amount, due_date,
                 planned_pay_date, is_recurring, autopay, category, savings_goal_id,
                 month, notes, frequency, is_template)
                VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,0)''',
                (uid,
                 paycheck_id,
                 template['bill_name_id'],
                 template['name'],
                 template['amount'],
                 due,
                 due,
                 template['autopay'] or 0,
                 template['category'],
                 template['savings_goal_id'],
                 month,
                 template['notes'],
                 template['frequency'] or 'monthly')
            )
            created += 1

    db.commit()
    db.close()
    return jsonify({'created': created, 'month': month})


@app.route('/api/bill-names')
@login_required
def get_bill_names():
    uid = session['user_id']
    db  = get_db()
    names = db.execute(
        'SELECT * FROM bill_names WHERE user_id=? ORDER BY name ASC', (uid,)
    ).fetchall()
    db.close()
    return jsonify([dict(n) for n in names])


# ─────────────────────────────────────────────────────────────────────────────
# API – Reconcile
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/reconcile', methods=['POST'])
@login_required
def reconcile():
    uid  = session['user_id']
    data = request.get_json()
    pid  = data['paycheck_id']
    bank_balance = float(data['bank_balance'])
    recon_date   = data['date']

    db       = get_db()
    paycheck = db.execute('SELECT * FROM paychecks WHERE id=? AND user_id=?', (pid, uid)).fetchone()
    if not paycheck:
        db.close()
        return jsonify({'error': 'Paycheck not found'}), 404

    # Sum paid bills for this paycheck
    paid_total = db.execute(
        'SELECT COALESCE(SUM(amount),0) as total FROM bills '
        'WHERE paycheck_id=? AND user_id=? AND is_paid=1 AND is_postponed=0',
        (pid, uid)
    ).fetchone()['total']

    # Prior adjustments for this paycheck
    prior_adj = db.execute(
        'SELECT COALESCE(SUM(adjustment_amount),0) as total FROM balance_adjustments '
        'WHERE paycheck_id=? AND user_id=?',
        (pid, uid)
    ).fetchone()['total']

    expected = float(paycheck['amount']) - paid_total + prior_adj
    adjustment = bank_balance - expected

    db.execute('''INSERT INTO balance_adjustments
        (user_id, paycheck_id, bank_balance, adjustment_amount, adjustment_date)
        VALUES (?,?,?,?,?)''',
        (uid, pid, bank_balance, adjustment, recon_date)
    )
    db.commit()
    new_id = db.execute('SELECT last_insert_rowid() as id').fetchone()['id']
    db.close()
    return jsonify({'id': new_id, 'adjustment': adjustment, 'expected': expected, 'actual': bank_balance})


@app.route('/api/reconcile/<int:adj_id>', methods=['DELETE'])
@login_required
def delete_adjustment(adj_id):
    uid = session['user_id']
    db  = get_db()
    db.execute('DELETE FROM balance_adjustments WHERE id=? AND user_id=?', (adj_id, uid))
    db.commit()
    db.close()
    return jsonify({'success': True})


# ─────────────────────────────────────────────────────────────────────────────
# API – Savings Goals
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/savings/goals', methods=['GET', 'POST'])
@login_required
def savings_goals():
    uid = session['user_id']
    db  = get_db()

    if request.method == 'GET':
        goals = db.execute(
            'SELECT * FROM savings_goals WHERE user_id=? ORDER BY created_at DESC', (uid,)
        ).fetchall()
        db.close()
        return jsonify([dict(g) for g in goals])

    data = request.get_json()
    db.execute('''INSERT INTO savings_goals (user_id, name, target_amount, target_date)
                  VALUES (?,?,?,?)''',
               (uid, data['name'], data['target_amount'], data.get('target_date')))
    db.commit()
    row = db.execute('SELECT * FROM savings_goals WHERE user_id=? ORDER BY id DESC LIMIT 1', (uid,)).fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/savings/goals/<int:gid>', methods=['PUT', 'DELETE'])
@login_required
def manage_savings_goal(gid):
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM savings_goals WHERE id=? AND user_id=?', (gid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'DELETE':
        db.execute('DELETE FROM savings_goals WHERE id=?', (gid,))
        db.commit()
        db.close()
        return jsonify({'success': True})

    data = request.get_json()
    db.execute('''UPDATE savings_goals SET name=?, target_amount=?, current_amount=?, target_date=?
                  WHERE id=?''',
               (data.get('name', row['name']),
                data.get('target_amount', row['target_amount']),
                data.get('current_amount', row['current_amount']),
                data.get('target_date', row['target_date']),
                gid))
    db.commit()
    updated = db.execute('SELECT * FROM savings_goals WHERE id=?', (gid,)).fetchone()
    db.close()
    return jsonify(dict(updated))


# ─────────────────────────────────────────────────────────────────────────────
# API – Debt
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/debt', methods=['GET', 'POST'])
@login_required
def debt():
    uid = session['user_id']
    db  = get_db()

    if request.method == 'GET':
        accounts = db.execute(
            'SELECT * FROM debt_accounts WHERE user_id=? ORDER BY created_at DESC', (uid,)
        ).fetchall()
        db.close()
        return jsonify([dict(a) for a in accounts])

    data = request.get_json()
    db.execute('''INSERT INTO debt_accounts
        (user_id, name, balance, credit_limit, apr, is_promo, promo_rate,
         promo_end_date, account_type, monthly_payment,
         status, promo_start_date, end_date, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (uid,
         data['name'],
         data.get('balance', 0),
         data.get('credit_limit'),
         data.get('apr', 0),
         1 if data.get('is_promo') else 0,
         data.get('promo_rate'),
         data.get('promo_end_date'),
         data.get('account_type', 'credit_card'),
         data.get('monthly_payment'),
         data.get('status', 'balance'),
         data.get('promo_start_date'),
         data.get('end_date'),
         data.get('notes'))
    )
    db.commit()
    row = db.execute('SELECT * FROM debt_accounts WHERE user_id=? ORDER BY id DESC LIMIT 1', (uid,)).fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/debt/<int:did>', methods=['PUT', 'DELETE'])
@login_required
def manage_debt(did):
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM debt_accounts WHERE id=? AND user_id=?', (did, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'DELETE':
        db.execute('DELETE FROM debt_accounts WHERE id=?', (did,))
        db.commit()
        db.close()
        return jsonify({'success': True})

    data = request.get_json()
    db.execute('''UPDATE debt_accounts SET
        name=?, balance=?, credit_limit=?, apr=?, is_promo=?,
        promo_rate=?, promo_end_date=?, account_type=?, monthly_payment=?,
        status=?, promo_start_date=?, end_date=?, notes=?
        WHERE id=?''',
        (data.get('name', row['name']),
         data.get('balance', row['balance']),
         data.get('credit_limit', row['credit_limit']),
         data.get('apr', row['apr']),
         1 if data.get('is_promo') else 0,
         data.get('promo_rate', row['promo_rate']),
         data.get('promo_end_date', row['promo_end_date']),
         data.get('account_type', row['account_type']),
         data.get('monthly_payment', row['monthly_payment']),
         data.get('status', row['status'] or 'balance'),
         data.get('promo_start_date', row['promo_start_date']),
         data.get('end_date', row['end_date']),
         data.get('notes', row['notes']),
         did))
    db.commit()
    updated = db.execute('SELECT * FROM debt_accounts WHERE id=?', (did,)).fetchone()
    db.close()
    return jsonify(dict(updated))


# ─────────────────────────────────────────────────────────────────────────────
# API – Subscriptions
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/subscriptions', methods=['GET', 'POST'])
@login_required
def subscriptions():
    uid = session['user_id']
    db  = get_db()

    if request.method == 'GET':
        subs = db.execute(
            'SELECT * FROM subscriptions WHERE user_id=? ORDER BY next_due_date IS NULL ASC, next_due_date ASC, name ASC', (uid,)
        ).fetchall()
        db.close()
        return jsonify([dict(s) for s in subs])

    data = request.get_json()
    db.execute('''INSERT INTO subscriptions
        (user_id, name, amount, interval_count, interval_unit, next_due_date)
        VALUES (?,?,?,?,?,?)''',
        (uid,
         data['name'],
         data['amount'],
         data.get('interval_count', 1),
         data.get('interval_unit', 'month'),
         data.get('next_due_date'))
    )
    db.commit()
    row = db.execute('SELECT * FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 1', (uid,)).fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/subscriptions/<int:sid>', methods=['PUT', 'DELETE'])
@login_required
def manage_subscription(sid):
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM subscriptions WHERE id=? AND user_id=?', (sid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'DELETE':
        db.execute('DELETE FROM subscriptions WHERE id=?', (sid,))
        db.commit()
        db.close()
        return jsonify({'success': True})

    data = request.get_json()
    db.execute('''UPDATE subscriptions SET
        name=?, amount=?, interval_count=?, interval_unit=?, next_due_date=?
        WHERE id=?''',
        (data.get('name', row['name']),
         data.get('amount', row['amount']),
         data.get('interval_count', row['interval_count']),
         data.get('interval_unit', row['interval_unit']),
         data.get('next_due_date', row['next_due_date']),
         sid))
    db.commit()
    updated = db.execute('SELECT * FROM subscriptions WHERE id=?', (sid,)).fetchone()
    db.close()
    return jsonify(dict(updated))


# ─────────────────────────────────────────────────────────────────────────────
# API – Calendar data
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/calendar')
@login_required
def calendar_data():
    uid   = session['user_id']
    month = request.args.get('month', date.today().strftime('%Y-%m'))
    db    = get_db()

    year, mon = map(int, month.split('-'))
    start     = f'{month}-01'
    _, days   = monthrange(year, mon)
    end       = f'{month}-{days:02d}'

    events = []

    # Paychecks
    for p in db.execute(
        'SELECT * FROM paychecks WHERE user_id=? AND date BETWEEN ? AND ?',
        (uid, start, end)
    ).fetchall():
        events.append({'date': p['date'], 'type': 'paycheck',
                       'title': f'💵 Paycheck ${p["amount"]:,.2f}', 'id': p['id']})

    # Bills
    for b in db.execute(
        '''SELECT * FROM bills WHERE user_id=? AND is_postponed=0
           AND (due_date BETWEEN ? AND ? OR planned_pay_date BETWEEN ? AND ?)''',
        (uid, start, end, start, end)
    ).fetchall():
        d = b['due_date'] or b['planned_pay_date']
        if d:
            events.append({'date': d, 'type': 'bill',
                           'title': f'🧾 {b["name"]} ${b["amount"]:,.2f}', 'id': b['id']})

    # Subscriptions
    for s in db.execute(
        'SELECT * FROM subscriptions WHERE user_id=? AND next_due_date BETWEEN ? AND ?',
        (uid, start, end)
    ).fetchall():
        events.append({'date': s['next_due_date'], 'type': 'subscription',
                       'title': f'🔁 {s["name"]} ${s["amount"]:,.2f}', 'id': s['id']})

    # Savings goals deadlines
    for g in db.execute(
        'SELECT * FROM savings_goals WHERE user_id=? AND target_date BETWEEN ? AND ?',
        (uid, start, end)
    ).fetchall():
        events.append({'date': g['target_date'], 'type': 'goal',
                       'title': f'🎯 {g["name"]}', 'id': g['id']})

    # Debt promo expirations
    for d in db.execute(
        'SELECT * FROM debt_accounts WHERE user_id=? AND is_promo=1 AND promo_end_date BETWEEN ? AND ?',
        (uid, start, end)
    ).fetchall():
        events.append({'date': d['promo_end_date'], 'type': 'promo',
                       'title': f'⏰ {d["name"]} promo expires', 'id': d['id']})

    db.close()
    return jsonify(events)


# ─────────────────────────────────────────────────────────────────────────────
# API – Sticky Notes
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/notes', methods=['GET', 'POST'])
@login_required
def sticky_notes():
    uid = session['user_id']
    db  = get_db()

    if request.method == 'GET':
        notes = db.execute(
            'SELECT * FROM sticky_notes WHERE user_id=? ORDER BY updated_at DESC', (uid,)
        ).fetchall()
        db.close()
        return jsonify([dict(n) for n in notes])

    data = request.get_json()
    db.execute(
        'INSERT INTO sticky_notes (user_id, title, content, color) VALUES (?,?,?,?)',
        (uid, data.get('title', ''), data['content'], data.get('color', 'yellow'))
    )
    db.commit()
    row = db.execute(
        'SELECT * FROM sticky_notes WHERE user_id=? ORDER BY id DESC LIMIT 1', (uid,)
    ).fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/notes/<int:nid>', methods=['PUT', 'DELETE'])
@login_required
def manage_note(nid):
    uid = session['user_id']
    db  = get_db()
    row = db.execute('SELECT * FROM sticky_notes WHERE id=? AND user_id=?', (nid, uid)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'DELETE':
        db.execute('DELETE FROM sticky_notes WHERE id=?', (nid,))
        db.commit()
        db.close()
        return jsonify({'success': True})

    data = request.get_json()
    db.execute(
        'UPDATE sticky_notes SET title=?, content=?, color=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        (data.get('title', row['title']),
         data.get('content', row['content']),
         data.get('color', row['color']),
         nid)
    )
    db.commit()
    updated = db.execute('SELECT * FROM sticky_notes WHERE id=?', (nid,)).fetchone()
    db.close()
    return jsonify(dict(updated))


# ─────────────────────────────────────────────────────────────────────────────
# API – Help messages
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/help', methods=['POST'])
@login_required
def submit_help():
    uid  = session['user_id']
    data = request.get_json()
    db   = get_db()
    db.execute('INSERT INTO help_messages (user_id, subject, message) VALUES (?,?,?)',
               (uid, data.get('subject', ''), data['message']))
    db.commit()
    db.close()
    return jsonify({'success': True})


# ─────────────────────────────────────────────────────────────────────────────
# API – Export to Excel
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/export')
@login_required
def export_excel():
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from flask import send_file
    import io

    uid = session['user_id']
    db  = get_db()

    wb = Workbook()
    green_fill = PatternFill(start_color='3D6B54', end_color='3D6B54', fill_type='solid')
    header_font = Font(bold=True, color='FFFFFF')

    def make_sheet(title, headers, rows):
        ws = wb.create_sheet(title=title)
        ws.append(headers)
        for cell in ws[1]:
            cell.font   = header_font
            cell.fill   = green_fill
            cell.alignment = Alignment(horizontal='center')
        for row in rows:
            ws.append(list(row))
        return ws

    # Paychecks
    paychecks = db.execute('SELECT date, amount, notes FROM paychecks WHERE user_id=? ORDER BY date', (uid,)).fetchall()
    make_sheet('Paychecks', ['Date', 'Amount', 'Notes'], paychecks)

    # Bills
    bills = db.execute(
        'SELECT name, amount, due_date, planned_pay_date, is_paid, is_postponed, is_recurring, category, month, notes '
        'FROM bills WHERE user_id=? ORDER BY planned_pay_date', (uid,)
    ).fetchall()
    make_sheet('Bills', ['Name', 'Amount', 'Due Date', 'Planned Pay Date',
                          'Paid', 'Postponed', 'Recurring', 'Category', 'Month', 'Notes'], bills)

    # Savings Goals
    goals = db.execute(
        'SELECT name, target_amount, current_amount, target_date FROM savings_goals WHERE user_id=?', (uid,)
    ).fetchall()
    make_sheet('Savings Goals', ['Name', 'Target', 'Saved', 'Target Date'], goals)

    # Debt
    debt = db.execute(
        'SELECT name, balance, credit_limit, apr, is_promo, promo_end_date, account_type, monthly_payment '
        'FROM debt_accounts WHERE user_id=?', (uid,)
    ).fetchall()
    make_sheet('Debt', ['Name', 'Balance', 'Limit', 'APR', 'Promo', 'Promo End', 'Type', 'Monthly Payment'], debt)

    # Subscriptions
    subs = db.execute(
        'SELECT name, amount, interval_count, interval_unit, next_due_date FROM subscriptions WHERE user_id=?', (uid,)
    ).fetchall()
    make_sheet('Subscriptions', ['Name', 'Amount', 'Every', 'Unit', 'Next Due'], subs)

    # Remove default empty sheet
    if 'Sheet' in wb.sheetnames:
        del wb['Sheet']

    db.close()

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    filename = f'nsledger_export_{date.today().isoformat()}.xlsx'
    return send_file(output, download_name=filename,
                     as_attachment=True,
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ─────────────────────────────────────────────────────────────────────────────
# Admin routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/admin')
@admin_required
def admin():
    tab = request.args.get('tab', 'users')
    db  = get_db()

    users = db.execute(
        'SELECT id, name, email, is_admin, created_at, last_login, deleted_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC'
    ).fetchall()
    deleted_users = db.execute(
        'SELECT id, name, email, is_admin, created_at, last_login, deleted_at FROM users WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
    ).fetchall()

    help_msgs = db.execute(
        'SELECT h.*, u.name as user_name, u.email as user_email '
        'FROM help_messages h JOIN users u ON h.user_id=u.id '
        'ORDER BY h.created_at DESC'
    ).fetchall()

    maintenance = db.execute(
        'SELECT * FROM maintenance_log ORDER BY created_at DESC'
    ).fetchall()

    versions = db.execute(
        'SELECT * FROM versions ORDER BY release_date DESC'
    ).fetchall()

    ios_releases = db.execute(
        'SELECT * FROM ios_releases ORDER BY release_date DESC'
    ).fetchall()

    unread_count = db.execute(
        "SELECT COUNT(*) as cnt FROM help_messages WHERE status='unread'"
    ).fetchone()['cnt']

    db.close()
    return render_template('admin.html',
        active_tab=tab,
        users=users,
        deleted_users=deleted_users,
        help_msgs=help_msgs,
        maintenance=maintenance,
        versions=versions,
        ios_releases=ios_releases,
        unread_count=unread_count
    )


@app.route('/api/admin/users/<int:uid_target>', methods=['DELETE'])
@admin_required
def delete_user(uid_target):
    if uid_target == session['user_id']:
        return jsonify({'error': 'Cannot delete your own account'}), 400
    db = get_db()
    from datetime import datetime
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
    db.execute('UPDATE users SET deleted_at=? WHERE id=? AND is_admin=0', (now, uid_target))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/admin/help/<int:mid>', methods=['PUT'])
@admin_required
def update_help_message(mid):
    data = request.get_json()
    db   = get_db()
    db.execute('UPDATE help_messages SET status=? WHERE id=?', (data['status'], mid))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/admin/maintenance', methods=['GET', 'POST'])
@admin_required
def admin_maintenance():
    db = get_db()
    if request.method == 'GET':
        rows = db.execute('SELECT * FROM maintenance_log ORDER BY created_at DESC').fetchall()
        db.close()
        return jsonify([dict(r) for r in rows])
    data = request.get_json()
    db.execute('''INSERT INTO maintenance_log (category, title, description, status, stage, version)
                  VALUES (?,?,?,?,?,?)''',
               (data['category'], data['title'], data.get('description',''),
                data.get('status','open'), data.get('stage','testing'), data.get('version','')))
    db.commit()
    row = db.execute('SELECT * FROM maintenance_log ORDER BY id DESC LIMIT 1').fetchone()
    db.close()
    return jsonify(dict(row))


@app.route('/api/admin/maintenance/<int:mid>', methods=['PUT', 'DELETE'])
@admin_required
def manage_maintenance(mid):
    db = get_db()
    if request.method == 'DELETE':
        db.execute('DELETE FROM maintenance_log WHERE id=?', (mid,))
        db.commit()
        db.close()
        return jsonify({'success': True})
    data = request.get_json()
    db.execute('''UPDATE maintenance_log SET category=?, title=?, description=?,
                  status=?, stage=?, version=? WHERE id=?''',
               (data['category'], data['title'], data.get('description',''),
                data.get('status','open'), data.get('stage','testing'),
                data.get('version',''), mid))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/admin/versions', methods=['GET', 'POST'])
@admin_required
def admin_versions():
    db = get_db()
    if request.method == 'GET':
        rows = db.execute('SELECT * FROM versions ORDER BY release_date DESC').fetchall()
        db.close()
        return jsonify([dict(r) for r in rows])
    data = request.get_json()
    db.execute('INSERT INTO versions (version_number, release_date, notes) VALUES (?,?,?)',
               (data['version_number'], data.get('release_date'), data.get('notes','')))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/admin/ios', methods=['GET', 'POST'])
@admin_required
def admin_ios():
    db = get_db()
    if request.method == 'GET':
        rows = db.execute('SELECT * FROM ios_releases ORDER BY release_date DESC').fetchall()
        db.close()
        return jsonify([dict(r) for r in rows])
    data = request.get_json()
    db.execute('INSERT INTO ios_releases (version, release_date, notes) VALUES (?,?,?)',
               (data['version'], data.get('release_date'), data.get('notes','')))
    db.commit()
    db.close()
    return jsonify({'success': True})


# ─────────────────────────────────────────────────────────────────────────────
# Mobile API – JWT Auth  (used by iOS app)
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/mobile/login', methods=['POST'])
def mobile_login():
    data     = request.get_json() or {}
    email    = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    db       = get_db()
    user     = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
    if not user or not check_password_hash(user['password_hash'], password):
        db.close()
        return jsonify({'error': 'Invalid email or password'}), 401
    if user['deleted_at']:
        db.close()
        return jsonify({'error': 'This account has been deleted'}), 403
    db.execute('UPDATE users SET last_login=? WHERE id=?', (datetime.utcnow(), user['id']))
    db.commit()
    db.close()
    token = _make_jwt(user['id'])
    return jsonify({
        'token': token,
        'user': {
            'id':       user['id'],
            'name':     user['name'],
            'email':    user['email'],
            'is_admin': bool(user['is_admin'])
        }
    })


@app.route('/api/mobile/register', methods=['POST'])
def mobile_register():
    data     = request.get_json() or {}
    name     = (data.get('name') or '').strip()
    email    = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    sec_q1   = data.get('security_q1') or 'What was the name of your first pet?'
    sec_a1   = (data.get('security_a1') or '').strip().lower()
    sec_q2   = data.get('security_q2') or 'What city were you born in?'
    sec_a2   = (data.get('security_a2') or '').strip().lower()

    if not all([name, email, password]):
        return jsonify({'error': 'Name, email, and password are required'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    db       = get_db()
    existing = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
    if existing:
        db.close()
        return jsonify({'error': 'An account with that email already exists'}), 409

    pw_hash = generate_password_hash(password, method='pbkdf2:sha256')
    db.execute(
        'INSERT INTO users (name, email, password_hash, security_q1, security_a1, security_q2, security_a2) VALUES (?,?,?,?,?,?,?)',
        (name, email, pw_hash, sec_q1, sec_a1, sec_q2, sec_a2)
    )
    db.commit()
    user = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
    db.close()
    token = _make_jwt(user['id'])
    return jsonify({
        'token': token,
        'user': {'id': user['id'], 'name': user['name'], 'email': user['email'], 'is_admin': False}
    }), 201


@app.route('/api/mobile/me')
@login_required
def mobile_me():
    uid = session['user_id']
    db  = get_db()
    user = db.execute('SELECT id, name, email, is_admin, created_at, last_login FROM users WHERE id=?', (uid,)).fetchone()
    db.close()
    if not user:
        return jsonify({'error': 'User not found'}), 404
    return jsonify(dict(user))


@app.route('/api/mobile/data')
@login_required
def mobile_data():
    """Return all user data in one request — used for initial app load."""
    uid = session['user_id']
    db  = get_db()

    paychecks = [dict(r) for r in db.execute(
        'SELECT * FROM paychecks WHERE user_id=? ORDER BY date DESC', (uid,)
    ).fetchall()]

    bills = [dict(r) for r in db.execute(
        'SELECT b.*, p.date as paycheck_date FROM bills b '
        'LEFT JOIN paychecks p ON b.paycheck_id=p.id '
        'WHERE b.user_id=? ORDER BY b.due_date ASC', (uid,)
    ).fetchall()]

    savings_goals = [dict(r) for r in db.execute(
        'SELECT * FROM savings_goals WHERE user_id=? ORDER BY created_at DESC', (uid,)
    ).fetchall()]

    debt_accounts = [dict(r) for r in db.execute(
        'SELECT * FROM debt_accounts WHERE user_id=? ORDER BY created_at DESC', (uid,)
    ).fetchall()]

    subscriptions = [dict(r) for r in db.execute(
        'SELECT * FROM subscriptions WHERE user_id=? ORDER BY next_due_date IS NULL ASC, next_due_date ASC, name ASC', (uid,)
    ).fetchall()]

    sticky_notes = [dict(r) for r in db.execute(
        'SELECT * FROM sticky_notes WHERE user_id=? ORDER BY updated_at DESC', (uid,)
    ).fetchall()]

    user_row = db.execute(
        'SELECT id, name, email, is_admin, created_at, last_login FROM users WHERE id=?', (uid,)
    ).fetchone()

    db.close()

    return jsonify({
        'user':          dict(user_row) if user_row else {},
        'paychecks':     paychecks,
        'bills':         bills,
        'savings_goals': savings_goals,
        'debt_accounts': debt_accounts,
        'subscriptions': subscriptions,
        'sticky_notes':  sticky_notes,
        'today':         date.today().isoformat()
    })


@app.route('/api/mobile/delete-account', methods=['DELETE'])
@login_required
def mobile_delete_account():
    """Soft-delete the authenticated user's account. Required by Apple App Store."""
    uid = session['user_id']
    db  = get_db()
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
    db.execute('UPDATE users SET deleted_at=? WHERE id=?', (now, uid))
    db.commit()
    db.close()
    session.clear()
    return jsonify({'success': True, 'message': 'Account deleted'})


# ─────────────────────────────────────────────────────────────────────────────
# Run
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    app.run(debug=True, host='0.0.0.0', port=5000)

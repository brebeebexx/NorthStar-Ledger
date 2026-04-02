/* ═══════════════════════════════════════════════════════════════
   NorthStar Ledger — App JavaScript
═══════════════════════════════════════════════════════════════ */

// ─── State (copy from server-rendered data) ───────────────────
let state = {
  paychecks:          [...APP_DATA.paychecks],
  bills:              [...APP_DATA.bills],
  savingsGoals:       [...APP_DATA.savingsGoals],
  debtAccounts:       [...APP_DATA.debtAccounts],
  subscriptions:      [...APP_DATA.subscriptions],
  billNames:          [...APP_DATA.billNames],
  stickyNotes:        [...APP_DATA.stickyNotes],
  balanceAdjustments: [...(APP_DATA.balanceAdjustments || [])],
  today:              APP_DATA.today,
};

let calYear     = new Date().getFullYear();
let calMonth    = new Date().getMonth(); // 0-indexed
let plannerYear = new Date().getFullYear();
let plannerMonth= new Date().getMonth(); // 0-indexed

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const tab = APP_DATA.activeTab || 'dashboard';
  switchTab(tab);

  // Show current date in global date bar (visible on all pages)
  const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const d = document.getElementById('global-date-display');
  if (d) d.textContent = dateStr;

  // Set default dates on modals
  document.querySelectorAll('input[type="date"]').forEach(el => {
    if (!el.value) el.value = state.today;
  });
  const monthInputs = document.querySelectorAll('input[type="month"]');
  monthInputs.forEach(el => { if (!el.value) el.value = state.today.slice(0,7); });

  // Populate dropdowns on load
  populatePaycheckDropdowns();
  populateSavingsGoalDropdowns();
});


// ─── Tab Switching ────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(a => a.classList.remove('active'));

  const section = document.getElementById('tab-' + tab);
  if (section) section.classList.add('active');

  const navItem = document.querySelector(`[data-tab="${tab}"]`);
  if (navItem) navItem.classList.add('active');

  // Update URL without reload
  const url = new URL(window.location);
  url.searchParams.set('tab', tab);
  window.history.pushState({}, '', url);

  // Also render sticky notes on dashboard init
  if (tab === 'dashboard')     { renderDashboard(); renderStickyNotes(); }
  if (tab === 'planner')       renderPlanner();
  if (tab === 'savings')       renderSavings();
  if (tab === 'debt')          renderDebt();
  if (tab === 'subscriptions') renderSubscriptions();
  if (tab === 'insights')      renderInsights();
  if (tab === 'calendar')      renderCalendar();

  // Close mobile sidebar
  document.getElementById('sidebar')?.classList.remove('open');
}

// Intercept nav-item clicks for SPA-style tab switching
document.addEventListener('click', e => {
  const navItem = e.target.closest('.nav-item');
  if (navItem && navItem.dataset.tab) {
    e.preventDefault();
    switchTab(navItem.dataset.tab);
  }
});


// ─── Modals ───────────────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
  // Always refresh dropdowns when opening bill modals
  if (id === 'modal-add-bill' || id === 'modal-edit-bill') {
    populatePaycheckDropdowns();
    populateSavingsGoalDropdowns();
  }
  // Reset planned-date sync flag when opening Add Bill
  if (id === 'modal-add-bill') {
    _plannedDateTouched = false;
  }
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}
// Close on overlay click (but not the delete-done modal — user must click OK)
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay') && e.target.id !== 'modal-delete-done') {
    e.target.classList.remove('open');
  }
});

// ── Delete Account Flow ───────────────────────────────────────
function confirmDeleteAccount() {
  closeModal('modal-settings');
  openModal('modal-delete-confirm');
}

async function executeDeleteAccount() {
  closeModal('modal-delete-confirm');
  try {
    const res = await fetch('/api/account/delete', { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      openModal('modal-delete-done');
    } else {
      alert(data.error || 'Could not delete account. Please try again.');
    }
  } catch (e) {
    alert('Something went wrong. Please try again.');
  }
}


// ─── API Helpers ──────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}


// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
function renderDashboard() {
  const today = new Date(state.today + 'T00:00:00');
  const thisMonth = state.today.slice(0, 7);

  // Find current paycheck (most recent past or today)
  const pastPaychecks = state.paychecks
    .filter(p => p.date <= state.today)
    .sort((a, b) => b.date.localeCompare(a.date));
  const currentPaycheck = pastPaychecks[0] || null;

  // Stat cards
  const totalSaved = state.savingsGoals.reduce((s, g) => s + g.current_amount, 0);

  // Current Month Projection: unpaid bills this month vs projected month-end balance
  const thisMonthPaychecks = state.paychecks
    .filter(p => p.date && p.date.slice(0, 7) === thisMonth)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Unpaid bills for this month's paychecks (or due this month)
  const unpaidThisMonth = state.bills.filter(b =>
    !b.is_paid && !b.is_postponed &&
    (b.due_date ? b.due_date.slice(0, 7) === thisMonth : false)
  );
  const unpaidThisMonthTotal = unpaidThisMonth.reduce((s, b) => s + b.amount, 0);

  // Projected month-end balance: matches the planner exactly —
  // only this month's paychecks, starting from $0, income minus all non-postponed bills
  let projectedBalance = 0;
  for (const p of thisMonthPaychecks) {
    const pBills = state.bills.filter(b => b.paycheck_id === p.id && !b.is_postponed);
    const pAdjs  = (state.balanceAdjustments || []).filter(a => a.paycheck_id === p.id);
    const pOut   = pBills.reduce((s, b) => s + b.amount, 0);
    const pAdj   = pAdjs.reduce((s, a) => s + (a.adjustment_amount || 0), 0);
    projectedBalance += p.amount - pOut + pAdj;
  }
  const balanceColor = projectedBalance >= 0 ? 'green' : 'red';

  // Determine status message based on projected balance vs unpaid bills
  let projStatus, projStatusClass;
  if (projectedBalance < 0) {
    projStatus = '⚠️ Heads up — you\'re projected to end the month in the red.';
    projStatusClass = 'proj-status danger';
  } else if (projectedBalance < unpaidThisMonthTotal * 0.25) {
    projStatus = '😬 It\'s tight — not much cushion after bills this month.';
    projStatusClass = 'proj-status warning';
  } else if (projectedBalance < unpaidThisMonthTotal * 0.5) {
    projStatus = '🙂 Manageable — you\'ll cover bills with a little left over.';
    projStatusClass = 'proj-status neutral';
  } else {
    projStatus = '✅ Looking good — you\'re on track to finish the month strong.';
    projStatusClass = 'proj-status good';
  }

  const statsEl = document.getElementById('dashboard-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat-card projection-card">
        <div class="stat-label">Current Month Projection</div>
        <div class="${projStatusClass}">${projStatus}</div>
        <div class="projection-row">
          <div>
            <div class="proj-sublabel">Unpaid Bills</div>
            <div class="proj-amount red">$${fmt(unpaidThisMonthTotal)}</div>
          </div>
          <div class="proj-divider">vs</div>
          <div>
            <div class="proj-sublabel">Month-End Balance</div>
            <div class="proj-amount ${balanceColor}">$${fmt(projectedBalance)}</div>
          </div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Saved</div>
        <div class="stat-value green">$${fmt(totalSaved)}</div>
      </div>
    `;
  }

  // Upcoming bills (next 7 days)
  const in7 = new Date(today); in7.setDate(in7.getDate() + 7);
  const upcoming = state.bills
    .filter(b => !b.is_paid && !b.is_postponed && b.due_date && b.due_date <= in7.toISOString().slice(0,10))
    .sort((a,b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 5);

  const upEl = document.getElementById('dashboard-upcoming-bills');
  if (upEl) {
    if (upcoming.length) {
      upEl.innerHTML = upcoming.map(b => `
        <div style="display:flex;justify-content:space-between;padding:0.6rem 1.2rem;border-bottom:1px solid var(--border);font-size:0.875rem;">
          <span>${b.name}</span>
          <span style="font-weight:600;color:var(--warning);">$${fmt(b.amount)} — ${fmtDate(b.due_date)}</span>
        </div>`).join('');
    } else {
      upEl.innerHTML = '<p class="empty-state">No bills due in the next 7 days.</p>';
    }
  }

  // Savings goals summary with Needed/Month
  const savEl = document.getElementById('dashboard-savings');
  if (savEl) {
    if (state.savingsGoals.length) {
      savEl.innerHTML = state.savingsGoals.slice(0,3).map(g => {
        const pct = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
        const remaining = Math.max(0, g.target_amount - g.current_amount);
        let neededHtml = '';
        if (g.target_date && remaining > 0) {
          const now = new Date();
          const target = new Date(g.target_date + 'T00:00:00');
          const msLeft = target - now;
          const monthsLeft = Math.max(1, Math.ceil(msLeft / (1000 * 60 * 60 * 24 * 30.44)));
          const perMonth = remaining / monthsLeft;
          neededHtml = `<div style="font-size:0.73rem;color:var(--sage-dk);font-weight:600;margin-top:0.15rem;">
            $${fmt(perMonth)}/mo needed &mdash; ${monthsLeft} month${monthsLeft !== 1 ? 's' : ''} left</div>`;
        } else if (remaining <= 0) {
          neededHtml = `<div style="font-size:0.73rem;color:var(--sage-dk);font-weight:600;margin-top:0.15rem;">🎉 Goal reached!</div>`;
        }
        return `<div style="padding:0.7rem 1.2rem;border-bottom:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;">
            <span>${g.name}</span><span>${pct}%</span>
          </div>
          <div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
          <div style="font-size:0.73rem;color:var(--text-lt);margin-top:0.2rem;">$${fmt(g.current_amount)} of $${fmt(g.target_amount)}</div>
          ${neededHtml}
        </div>`;
      }).join('');
    } else {
      savEl.innerHTML = `<p class="empty-state">No savings goals yet. <button class="link-btn" onclick="switchTab('savings')">Add one →</button></p>`;
    }
  }
}


// ═══════════════════════════════════════════════════════════════
// PLANNER
// ═══════════════════════════════════════════════════════════════
function plannerPrevMonth() {
  plannerMonth--;
  if (plannerMonth < 0) { plannerMonth = 11; plannerYear--; }
  renderPlanner();
  if (document.getElementById('recurring-view')?.style.display !== 'none') renderRecurringInline();
}
function plannerNextMonth() {
  plannerMonth++;
  if (plannerMonth > 11) { plannerMonth = 0; plannerYear++; }
  renderPlanner();
  if (document.getElementById('recurring-view')?.style.display !== 'none') renderRecurringInline();
}

function renderPlanner() {
  const container = document.getElementById('planner-buckets');
  const label = document.getElementById('planner-month-label');
  if (!container) return;

  // ── Preserve which buckets the user has open before rebuilding DOM ──
  const openBuckets = new Set(
    [...document.querySelectorAll('.bucket-body:not(.collapsed)')]
      .map(el => el.id.replace('bucket-body-', ''))
  );

  // Update month label
  const monthStr = `${plannerYear}-${String(plannerMonth + 1).padStart(2, '0')}`;
  if (label) label.textContent = new Date(plannerYear, plannerMonth, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  if (!state.paychecks.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">💵</div><p>No paychecks yet. Add your first paycheck to get started.</p></div>`;
    return;
  }

  // ── Past Due Widget ───────────────────────────────────────────
  const pastDueBills = state.bills
    .filter(b => !b.is_paid && !b.is_postponed && b.due_date && b.due_date < state.today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  let pastDueHtml = '';
  if (pastDueBills.length) {
    const rows = pastDueBills.map(b => {
      const daysOverdue = Math.floor((new Date(state.today + 'T00:00:00') - new Date(b.due_date + 'T00:00:00')) / 86400000);
      return `<div class="alert-widget-row">
        <span class="alert-widget-name">${escHtml(b.name)}</span>
        <span class="alert-widget-detail">due ${fmtDate(b.due_date)} &mdash; <strong>${daysOverdue}d overdue</strong></span>
        <span class="alert-widget-amount">$${fmt(b.amount)}</span>
      </div>`;
    }).join('');
    pastDueHtml = `
    <div class="alert-widget alert-past-due">
      <div class="alert-widget-header">
        <span>🚨 Past Due Bills</span>
        <span class="alert-widget-count">${pastDueBills.length} bill${pastDueBills.length !== 1 ? 's' : ''}</span>
      </div>
      ${rows}
    </div>`;
  }

  // ── Promotions Ending Widget (within 60 days) ─────────────────
  const sixtyDaysOut = new Date(state.today + 'T00:00:00');
  sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
  const sixtyStr = sixtyDaysOut.toISOString().slice(0, 10);

  const promoAccounts = state.debtAccounts
    .filter(d => d.is_promo && d.promo_end_date && d.promo_end_date >= state.today && d.promo_end_date <= sixtyStr)
    .sort((a, b) => a.promo_end_date.localeCompare(b.promo_end_date));

  let promoHtml = '';
  if (promoAccounts.length) {
    const rows = promoAccounts.map(d => {
      const daysLeft = Math.ceil((new Date(d.promo_end_date + 'T00:00:00') - new Date(state.today + 'T00:00:00')) / 86400000);
      return `<div class="alert-widget-row">
        <span class="alert-widget-name">${escHtml(d.name)}</span>
        <span class="alert-widget-detail">ends ${fmtDate(d.promo_end_date)} &mdash; <strong>${daysLeft}d left</strong></span>
        <span class="alert-widget-amount">${d.promo_rate != null ? d.promo_rate + '% promo' : 'Promo'}</span>
      </div>`;
    }).join('');
    promoHtml = `
    <div class="alert-widget alert-promo">
      <div class="alert-widget-header">
        <span>⏰ Promotions Ending Soon</span>
        <span class="alert-widget-count">${promoAccounts.length} account${promoAccounts.length !== 1 ? 's' : ''}</span>
      </div>
      ${rows}
    </div>`;
  }

  // Inject alert widgets before buckets
  const alertsHtml = pastDueHtml + promoHtml;
  container.innerHTML = alertsHtml ? `<div class="planner-alerts">${alertsHtml}</div>` : '';

  // Filter paychecks to the selected month (by date), sort oldest → newest
  const sorted = [...state.paychecks]
    .filter(p => p.date && p.date.slice(0, 7) === monthStr)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Find current bucket globally (most recent paycheck on or before today)
  const currentId = (() => {
    const past = [...state.paychecks]
      .filter(p => p.date <= state.today)
      .sort((a, b) => b.date.localeCompare(a.date));
    return past.length ? past[0].id : null;
  })();

  if (!sorted.length) {
    container.innerHTML += `<div class="empty-state"><div class="empty-state-icon">💵</div>
      <p>No paychecks for this month. Use ‹ Prev / Next › to navigate or add a new paycheck.</p></div>`;
    // Still show unassigned bills
  }

  // Build buckets with a running balance that carries across all paychecks
  let runningBalance = 0;
  const bucketHtmlParts = sorted.map((p, idx) => {
    const bills = state.bills.filter(b => b.paycheck_id === p.id);
    const income     = p.amount;
    const paidOut    = bills.filter(b => b.is_paid && !b.is_postponed).reduce((s, b) => s + b.amount, 0);
    const pendingOut = bills.filter(b => !b.is_paid && !b.is_postponed).reduce((s, b) => s + b.amount, 0);
    // Reconcile adjustments for this paycheck
    const adjs    = state.balanceAdjustments.filter(a => a.paycheck_id === p.id);
    const adjTotal = adjs.reduce((s, a) => s + (a.adjustment_amount || 0), 0);
    const bucketNet  = income - paidOut - pendingOut + adjTotal;
    const prevRunningBalance = runningBalance;   // balance carried in from prior buckets
    runningBalance += bucketNet;

    const isCurrent  = p.id === currentId;
    const isNeg      = runningBalance < 0;
    const isFirst    = idx === 0;
    const isLast     = idx === sorted.length - 1;

    // Merge bills + reconcile adjustments into one date-ordered list
    // Bills: sort key = due_date (unpaid) or paid_date (paid). Adjustments: sort key = adjustment_date.
    const entries = [
      ...bills.map(b => ({
        type:     'bill',
        data:     b,
        sortDate: b.is_paid
          ? (b.paid_date || b.due_date || '9999-12-31')
          : (b.due_date  || b.planned_pay_date || '9999-12-31'),
        isPending: !b.is_paid && !b.is_postponed,
      })),
      ...adjs.map(a => ({
        type:     'adj',
        data:     a,
        sortDate: a.adjustment_date || '9999-12-31',
        isPending: true,  // reconcile entries sort alongside unpaid bills by date
      })),
    ];

    // Group 1: unpaid bills + reconcile adjustments, sorted by date.
    // Group 2: paid bills, sorted by date (shown at bottom).
    entries.sort((a, b) => {
      if (a.isPending !== b.isPending) return a.isPending ? -1 : 1;
      return a.sortDate.localeCompare(b.sortDate);
    });

    // Per-row running balance: start from whatever was carried in + this paycheck's income
    let rowBalance = prevRunningBalance + income;
    const entriesHtml = entries.length ? entries.map(entry => {
      if (entry.type === 'bill') {
        const b = entry.data;
        if (!b.is_postponed) rowBalance -= b.amount;
        return billRowHtml(b, rowBalance);
      } else {
        const a = entry.data;
        rowBalance += a.adjustment_amount;
        return adjRowHtml(a, rowBalance);
      }
    }).join('') :
      `<div style="padding:1rem 1.2rem;font-size:0.82rem;color:var(--text-lt);">No bills assigned to this paycheck.</div>`;

    // Running balance label
    const runLabel = isLast ? 'Month-End Balance' : 'Running Balance';

    return `
    <div class="bucket ${isCurrent ? 'current' : ''} ${isNeg ? 'negative' : ''}" id="bucket-${p.id}">
      <div class="bucket-header" onclick="toggleBucket(${p.id})">
        <div class="bucket-title">
          💵 ${fmtDate(p.date)}
          ${isCurrent ? '<span class="badge-current">CURRENT</span>' : ''}
          ${isNeg ? '<span class="badge-warning">⚠️ Negative</span>' : ''}
        </div>
        <div class="bucket-meta">
          <span class="bucket-income">+$${fmt(income)}</span>
          <span class="bucket-balance ${runningBalance >= 0 ? 'pos' : 'neg'}" title="${runLabel}">$${fmt(runningBalance)}</span>
          <button class="bill-btn edit" style="font-size:0.72rem;" onclick="event.stopPropagation(); openEditPaycheck(${p.id})">✏️ Edit</button>
          <span style="color:var(--text-lt);font-size:0.8rem;">${isCurrent ? '▾' : '▸'}</span>
        </div>
      </div>
      <div class="bucket-body ${isCurrent ? '' : 'collapsed'}" id="bucket-body-${p.id}">
        ${entriesHtml}
        <div class="bucket-recon-row">
          <span class="bucket-running-balance">
            This check: <strong>+$${fmt(income)}</strong> — Paid: <strong>$${fmt(paidOut)}</strong> — Pending: <strong>$${fmt(pendingOut)}</strong>
            ${adjTotal !== 0 ? `— Adj: <strong>${adjTotal >= 0 ? '+' : ''}$${fmt(adjTotal)}</strong>` : ''}
            &nbsp;·&nbsp; <span style="font-weight:700;color:${runningBalance >= 0 ? 'var(--sage-dk)' : 'var(--danger)'};">${runLabel}: $${fmt(runningBalance)}</span>
          </span>
          <button class="btn-outline" style="font-size:0.78rem;padding:0.3rem 0.8rem;" onclick="openReconcile(${p.id})">⚖️ Reconcile to Bank</button>
        </div>
      </div>
    </div>`;
  });

  container.innerHTML += bucketHtmlParts.join('');

  // ── Restore open/closed state the user had before re-render ──
  // (Start: every bucket is collapsed except current; openBuckets overrides that)
  openBuckets.forEach(id => {
    const el = document.getElementById('bucket-body-' + id);
    if (el) el.classList.remove('collapsed');
  });
  // If a bucket was previously open but is no longer in the DOM (month changed), that's fine

  // Unassigned bills section
  const unassigned = state.bills.filter(b => !b.paycheck_id);
  if (unassigned.length) {
    container.innerHTML += `
    <div class="bucket" id="bucket-unassigned">
      <div class="bucket-header" onclick="toggleBucket('unassigned')">
        <div class="bucket-title">📌 Unassigned Bills</div>
        <div class="bucket-meta"><span>${unassigned.length} bill${unassigned.length !== 1 ? 's' : ''}</span></div>
      </div>
      <div class="bucket-body collapsed" id="bucket-body-unassigned">
        ${unassigned.map(b => billRowHtml(b)).join('')}
      </div>
    </div>`;
  }
}

// billRowHtml now accepts an optional runningBal to show per-row balance
function billRowHtml(b, runningBal) {
  const isPaid = b.is_paid;
  const isPost = b.is_postponed;
  const nameClass = isPaid ? 'paid' : isPost ? 'postponed' : '';

  const pillHtml = isPaid
    ? '<span class="bucket-pill pill-paid">✓ Paid</span>'
    : isPost
    ? '<span class="bucket-pill pill-post">Postponed</span>'
    : '<span class="bucket-pill pill-pending">Pending</span>';

  const autoPillHtml = b.autopay
    ? '<span class="bucket-pill pill-auto">AUTO</span>'
    : '';

  const recurringIcon = b.is_recurring ? ' <span title="Recurring" style="font-size:0.7rem;color:var(--text-lt);">🔁</span>' : '';

  const notesHtml = b.notes
    ? `<div class="bill-note">📝 ${escHtml(b.notes)}</div>` : '';

  const paidDateHtml = isPaid && b.paid_date
    ? `<div class="bill-paid-date">Paid ${fmtDate(b.paid_date)}</div>` : '';

  const payBtnLabel = isPaid ? 'Unpay' : 'Mark Paid';
  const payBtnClass = isPaid ? 'unpay' : 'pay';

  const balHtml = runningBal !== undefined
    ? `<div class="bill-running-bal ${runningBal >= 0 ? 'pos' : 'neg'}" title="Balance after this bill">$${fmt(runningBal)}</div>`
    : '';

  return `
  <div class="bill-row ${isPaid ? 'row-paid' : isPost ? 'row-post' : ''}" id="bill-${b.id}">
    <div class="bill-name-col">
      <div class="bill-name ${nameClass}">${escHtml(b.name)}${recurringIcon}</div>
      ${b.due_date ? `<div class="bill-due">due ${fmtDate(b.due_date)}</div>` : ''}
      ${notesHtml}
      ${paidDateHtml}
    </div>
    <div class="bill-col-status">${pillHtml}</div>
    <div class="bill-col-auto">${autoPillHtml}</div>
    <div class="bill-amount-col">
      <div class="bill-amount ${nameClass}">$${fmt(b.amount)}</div>
      ${balHtml}
    </div>
    <div class="bill-actions">
      <button class="bill-btn ${payBtnClass}" onclick="togglePay(${b.id})">${payBtnLabel}</button>
      ${!isPaid && !isPost ? `<button class="bill-btn post" onclick="openPostpone(${b.id})">Postpone</button>` : ''}
      ${isPost ? `<button class="bill-btn unpost" onclick="unPostpone(${b.id})">Un-postpone</button>` : ''}
      <button class="bill-btn edit" onclick="openEditBill(${b.id})">Edit</button>
    </div>
  </div>`;
}

// Renders a reconcile adjustment as an inline row with running balance
function adjRowHtml(a, runningBal) {
  const sign = a.adjustment_amount >= 0 ? '+' : '';
  const balClass = runningBal >= 0 ? 'pos' : 'neg';
  const amtClass = a.adjustment_amount >= 0 ? 'pos' : 'neg';
  return `
  <div class="bill-row adj-row">
    <div class="bill-name-col">
      <div class="bill-name" style="color:var(--navy);font-style:italic;">⚖️ Reconcile to Bank</div>
      <div class="bill-due">${fmtDate(a.adjustment_date)} · Bank balance: $${fmt(a.bank_balance)}</div>
    </div>
    <div class="bill-col-status"></div>
    <div class="bill-col-auto"></div>
    <div class="bill-amount-col">
      <div class="bill-amount ${amtClass}" style="color:${a.adjustment_amount >= 0 ? 'var(--sage-dk)' : 'var(--danger)'};">${sign}$${fmt(a.adjustment_amount)}</div>
      <div class="bill-running-bal ${balClass}">$${fmt(runningBal)}</div>
    </div>
    <div class="bill-actions">
      <button class="bill-btn" style="border-color:var(--danger);color:var(--danger);" onclick="deleteAdjustment(${a.id})" title="Delete adjustment">✕ Delete</button>
    </div>
  </div>`;
}

function toggleBucket(id) {
  const body = document.getElementById('bucket-body-' + id);
  if (body) body.classList.toggle('collapsed');
}


// ═══════════════════════════════════════════════════════════════
// SAVINGS
// ═══════════════════════════════════════════════════════════════
function renderSavings() {
  const container = document.getElementById('savings-goals-grid');
  if (!container) return;

  if (!state.savingsGoals.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎯</div><p>No savings goals yet. Create your first one!</p></div>`;
    return;
  }

  container.className = 'savings-grid';
  container.innerHTML = state.savingsGoals.map(g => {
    const pct = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
    return `
    <div class="goal-card">
      <div class="goal-card-header">
        <div class="goal-card-name">🎯 ${g.name}</div>
        <div class="goal-card-actions">
          <button onclick="editGoal(${g.id})" title="Edit">✏️</button>
          <button onclick="deleteGoal(${g.id})" title="Delete">🗑️</button>
        </div>
      </div>
      <div class="goal-amounts">
        <span>Saved: <strong>$${fmt(g.current_amount)}</strong></span>
        <span>Goal: <strong>$${fmt(g.target_amount)}</strong></span>
      </div>
      <div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
      <div class="goal-pct">${pct}% complete</div>
      ${g.target_date ? `<div class="goal-date">🗓 Target: ${fmtDate(g.target_date)}</div>` : ''}
    </div>`;
  }).join('');
}


// ═══════════════════════════════════════════════════════════════
// DEBT
// ═══════════════════════════════════════════════════════════════
let _debtEditId = null;
let _subEditId  = null;

function renderDebt() {
  const container = document.getElementById('debt-accounts-list');
  if (!container) return;

  if (!state.debtAccounts.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">💳</div><p>No debt accounts added yet.</p></div>`;
    return;
  }

  const promos  = state.debtAccounts.filter(d => d.is_promo);
  const cards   = state.debtAccounts.filter(d => d.account_type === 'credit_card' && !d.is_promo);
  const loans   = state.debtAccounts.filter(d => d.account_type === 'loan');
  const others  = state.debtAccounts.filter(d => d.account_type === 'other' && !d.is_promo);

  let html = '';

  // ── Promotions ───────────────────────────────────────────────
  if (promos.length) {
    const activePromos = promos.filter(d => (d.status || 'balance') !== 'closed');
    const paidPromos   = promos.filter(d => (d.status || 'balance') === 'closed');
    html += `<div class="debt-section">
      <div class="debt-section-header">🏷️ Promotions</div>
      <table class="debt-table">
        <thead><tr><th>Name</th><th>Start Date</th><th>End Date</th><th>Balance</th><th class="dt-actions"></th></tr></thead>
        <tbody>
          ${activePromos.map(d => _debtEditId === d.id ? debtPromoRowEdit(d) : debtPromoRow(d)).join('')}
          ${paidPromos.map(d => _debtEditId === d.id ? debtPromoRowEdit(d) : debtPromoRow(d)).join('')}
        </tbody>
      </table></div>`;
  }

  // ── Credit Cards ─────────────────────────────────────────────
  if (cards.length) {
    const activeCards = cards.filter(d => (d.status || 'balance') !== 'no_balance');
    const noBalCards  = cards.filter(d => (d.status || 'balance') === 'no_balance');
    html += `<div class="debt-section">
      <div class="debt-section-header">💳 Credit Cards</div>
      <table class="debt-table">
        <thead><tr><th>Card Name</th><th>Interest Rate</th><th>Credit Limit</th><th>Status</th><th class="dt-actions"></th></tr></thead>
        <tbody>
          ${activeCards.map(d => _debtEditId === d.id ? debtCardRowEdit(d) : debtCardRow(d)).join('')}
          ${noBalCards.map(d => _debtEditId === d.id ? debtCardRowEdit(d) : debtCardRow(d, true)).join('')}
        </tbody>
      </table></div>`;
  }

  // ── Loans ────────────────────────────────────────────────────
  if (loans.length) {
    const active  = loans.filter(l => (l.status || 'balance') !== 'no_balance');
    const noBal   = loans.filter(l => (l.status || 'balance') === 'no_balance');
    html += `<div class="debt-section">
      <div class="debt-section-header">🏦 Loans</div>
      <table class="debt-table">
        <thead><tr><th>Loan Name</th><th>Rate</th><th>Loan Amount</th><th>Monthly Pmt</th><th>End Date</th><th>Note</th><th>Status</th><th class="dt-actions"></th></tr></thead>
        <tbody>
          ${active.map(d => _debtEditId === d.id ? debtLoanRowEdit(d) : debtLoanRow(d, false)).join('')}
          ${noBal.map(d => _debtEditId === d.id ? debtLoanRowEdit(d) : debtLoanRow(d, true)).join('')}
        </tbody>
      </table></div>`;
  }

  // ── Other ────────────────────────────────────────────────────
  if (others.length) {
    html += `<div class="debt-section">
      <div class="debt-section-header">📄 Other</div>
      <table class="debt-table">
        <thead><tr><th>Name</th><th>Balance</th><th>APR</th><th class="dt-actions"></th></tr></thead>
        <tbody>${others.map(d => _debtEditId === d.id ? debtOtherRowEdit(d) : debtOtherRow(d)).join('')}</tbody>
      </table></div>`;
  }

  container.innerHTML = html;
}

// ── Row renderers — display mode ─────────────────────────────
function debtRowActions(id) {
  return `<td class="dt-actions">
    <button class="bill-btn edit" onclick="startEditDebt(${id})">Edit</button>
    <button class="bill-btn" style="border-color:var(--danger);color:var(--danger);" onclick="deleteDebt(${id})">Delete</button>
  </td>`;
}
function debtRowActionsEdit(id) {
  return `<td class="dt-actions">
    <button class="bill-btn edit" onclick="saveDebt(${id})">Save</button>
    <button class="bill-btn" onclick="cancelEditDebt()">Cancel</button>
  </td>`;
}

function statusPill(status) {
  const map = { balance: ['pill-pending','Balance'], no_balance: ['pill-paid','No Balance'], closed: ['pill-post','Closed'] };
  const [cls, label] = map[status || 'balance'] || map['balance'];
  return `<span class="bucket-pill ${cls}" style="font-size:0.72rem;">${label}</span>`;
}

function debtPromoRow(d) {
  const today = state.today;
  const expired = d.promo_end_date && d.promo_end_date < today;
  const isPaid  = (d.status || 'balance') === 'closed';
  const rowCls  = isPaid ? 'dt-row-no-bal' : (expired ? 'dt-row-dim' : '');
  const markPaidBtn = !isPaid
    ? `<button class="bill-btn edit" style="font-size:0.72rem;" onclick="markPromoPaid(${d.id})">✓ Mark Paid</button>`
    : '';
  return `<tr class="${rowCls}" id="debt-row-${d.id}">
    <td><strong>${escHtml(d.name)}</strong>${d.apr != null ? `<div class="dt-sub">${d.apr}% promo rate</div>` : ''}${isPaid ? ' <span class="dt-expired">Paid</span>' : ''}</td>
    <td>${d.promo_start_date ? fmtDate(d.promo_start_date) : '<span class="dt-empty">—</span>'}</td>
    <td>${d.promo_end_date ? `${fmtDate(d.promo_end_date)}${expired && !isPaid ? ' <span class="dt-expired">Expired</span>' : ''}` : '<span class="dt-empty">—</span>'}</td>
    <td><strong style="color:${isPaid ? 'var(--text-lt)' : 'var(--danger)'};">$${fmt(d.balance)}</strong></td>
    <td class="dt-actions">
      ${markPaidBtn}
      <button class="bill-btn edit" onclick="startEditDebt(${d.id})">Edit</button>
      <button class="bill-btn" style="border-color:var(--danger);color:var(--danger);" onclick="deleteDebt(${d.id})">Delete</button>
    </td>
  </tr>`;
}
function debtCardRow(d, isNoBal) {
  const rowCls = isNoBal ? 'dt-row-no-bal' : '';
  return `<tr class="${rowCls}" id="debt-row-${d.id}">
    <td><strong>${escHtml(d.name)}</strong></td>
    <td>${d.apr}%</td>
    <td>${d.credit_limit ? '$' + fmt(d.credit_limit) : '<span class="dt-empty">—</span>'}</td>
    <td>${statusPill(d.status)}</td>
    ${debtRowActions(d.id)}
  </tr>`;
}
function debtLoanRow(d, isNoBal) {
  const rowCls = isNoBal ? 'dt-row-no-bal' : '';
  return `<tr class="${rowCls}" id="debt-row-${d.id}">
    <td><strong>${escHtml(d.name)}</strong></td>
    <td>${d.apr}%</td>
    <td>${d.credit_limit ? '$' + fmt(d.credit_limit) : '<span class="dt-empty">—</span>'}</td>
    <td>${d.monthly_payment ? '$' + fmt(d.monthly_payment) : '<span class="dt-empty">—</span>'}</td>
    <td>${d.end_date ? fmtDate(d.end_date) : '<span class="dt-empty">—</span>'}</td>
    <td>${d.notes ? `<span class="dt-note" title="${escHtml(d.notes)}">${escHtml(d.notes.length > 20 ? d.notes.slice(0,20)+'…' : d.notes)}</span>` : '<span class="dt-empty">—</span>'}</td>
    <td>${statusPill(d.status)}</td>
    ${debtRowActions(d.id)}
  </tr>`;
}
function debtOtherRow(d) {
  return `<tr id="debt-row-${d.id}">
    <td><strong>${escHtml(d.name)}</strong></td>
    <td style="color:var(--danger);">$${fmt(d.balance)}</td>
    <td>${d.apr}%</td>
    ${debtRowActions(d.id)}
  </tr>`;
}

// ── Row renderers — edit mode ────────────────────────────────
function debtInput(field, value, type='text', placeholder='') {
  return `<input class="dt-input" type="${type}" id="dedit-${field}" value="${value ?? ''}" placeholder="${placeholder}"/>`;
}
function debtSelect(field, value, options) {
  return `<select class="dt-input" id="dedit-${field}">${options.map(([v,l]) => `<option value="${v}"${v===value?' selected':''}>${l}</option>`).join('')}</select>`;
}

function debtPromoRowEdit(d) {
  return `<tr class="dt-row-editing" id="debt-row-${d.id}">
    <td>${debtInput('name', d.name, 'text', 'Name')}${debtInput('apr', d.apr, 'number', 'Rate %')}</td>
    <td>${debtInput('promo_start_date', d.promo_start_date, 'date')}</td>
    <td>${debtInput('promo_end_date', d.promo_end_date, 'date')}</td>
    <td>${debtInput('balance', d.balance, 'number', '0.00')}</td>
    ${debtRowActionsEdit(d.id)}
  </tr>`;
}
function debtCardRowEdit(d) {
  return `<tr class="dt-row-editing" id="debt-row-${d.id}">
    <td>${debtInput('name', d.name, 'text', 'Card name')}</td>
    <td>${debtInput('apr', d.apr, 'number', '0.00')}</td>
    <td>${debtInput('credit_limit', d.credit_limit, 'number', '0.00')}</td>
    <td>${debtSelect('status', d.status||'balance', [['balance','Balance'],['no_balance','No Balance'],['closed','Closed']])}</td>
    ${debtRowActionsEdit(d.id)}
  </tr>`;
}
function debtLoanRowEdit(d) {
  return `<tr class="dt-row-editing" id="debt-row-${d.id}">
    <td>${debtInput('name', d.name, 'text', 'Loan name')}</td>
    <td>${debtInput('apr', d.apr, 'number', '0.00')}</td>
    <td>${debtInput('credit_limit', d.credit_limit, 'number', '0.00')}</td>
    <td>${debtInput('monthly_payment', d.monthly_payment, 'number', '0.00')}</td>
    <td>${debtInput('end_date', d.end_date, 'date')}</td>
    <td>${debtInput('notes', d.notes, 'text', 'Note')}</td>
    <td>${debtSelect('status', d.status||'balance', [['balance','Balance'],['no_balance','No Balance']])}</td>
    ${debtRowActionsEdit(d.id)}
  </tr>`;
}
function debtOtherRowEdit(d) {
  return `<tr class="dt-row-editing" id="debt-row-${d.id}">
    <td>${debtInput('name', d.name, 'text', 'Name')}</td>
    <td>${debtInput('balance', d.balance, 'number', '0.00')}</td>
    <td>${debtInput('apr', d.apr, 'number', '0.00')}</td>
    ${debtRowActionsEdit(d.id)}
  </tr>`;
}

function startEditDebt(id) {
  _debtEditId = id;
  renderDebt();
}
function cancelEditDebt() {
  _debtEditId = null;
  renderDebt();
}

function getVal(field) {
  const el = document.getElementById('dedit-' + field);
  return el ? el.value : null;
}

async function saveDebt(id) {
  const d = state.debtAccounts.find(a => a.id === id);
  if (!d) return;

  const updated = {
    ...d,
    name:             getVal('name') || d.name,
    apr:              parseFloat(getVal('apr')) || 0,
    balance:          parseFloat(getVal('balance') ?? d.balance) || 0,
    credit_limit:     getVal('credit_limit') ? parseFloat(getVal('credit_limit')) : d.credit_limit,
    monthly_payment:  getVal('monthly_payment') ? parseFloat(getVal('monthly_payment')) : d.monthly_payment,
    status:           getVal('status') || d.status || 'balance',
    promo_start_date: getVal('promo_start_date') || d.promo_start_date,
    promo_end_date:   getVal('promo_end_date') || d.promo_end_date,
    end_date:         getVal('end_date') || d.end_date,
    notes:            getVal('notes') !== null ? getVal('notes') : d.notes,
  };

  const data = await api('PUT', `/api/debt/${id}`, updated);
  const idx = state.debtAccounts.findIndex(a => a.id === id);
  if (idx > -1) {
    const wasActive = (state.debtAccounts[idx].status || 'balance') === 'balance';
    const nowPaidOff = (updated.status === 'no_balance' || updated.status === 'closed');
    state.debtAccounts[idx] = { ...state.debtAccounts[idx], ...data };
    if (wasActive && nowPaidOff) {
      showCelebration(`"${d.name}" paid off! Great work! 💪`);
    }
  }
  _debtEditId = null;
  renderDebt();
}

function calcPayoffMonths(balance, apr, payment) {
  if (payment <= 0) return null;
  const monthlyRate = apr / 100 / 12;
  if (monthlyRate === 0) return Math.ceil(balance / payment);
  let bal = balance, months = 0;
  while (bal > 0 && months < 600) {
    bal = bal * (1 + monthlyRate) - payment;
    months++;
  }
  return months >= 600 ? null : months;
}

function calcPayoff() {
  const balance  = parseFloat(document.getElementById('calc-balance').value);
  const apr      = parseFloat(document.getElementById('calc-apr').value);
  const payment  = parseFloat(document.getElementById('calc-payment').value);
  const resultEl = document.getElementById('calc-result');
  if (!balance || !payment) { resultEl.style.display='none'; return; }

  const months = calcPayoffMonths(balance, apr || 0, payment);
  if (!months) {
    resultEl.innerHTML = '⚠️ Payment is too low to pay off the balance.';
  } else {
    const totalPaid = payment * months;
    const interest  = totalPaid - balance;
    const date = new Date(); date.setMonth(date.getMonth() + months);
    resultEl.innerHTML = `
      <strong>Payoff in ~${months} months</strong> (${date.toLocaleDateString('en-US', {month:'long', year:'numeric'})})<br>
      Total paid: $${fmt(totalPaid)} — Interest paid: $${fmt(interest)}`;
  }
  resultEl.style.display = 'block';
}


// ═══════════════════════════════════════════════════════════════
// SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════
function renderSubscriptions() {
  const container = document.getElementById('subscriptions-list');
  if (!container) return;

  if (!state.subscriptions.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔁</div><p>No subscriptions yet. Add your first one!</p></div>`;
    return;
  }

  const monthly = calcMonthlySubTotal();
  const annual  = monthly * 12;

  const toMonthly = s => {
    if (s.interval_unit === 'month') return s.amount * s.interval_count;
    if (s.interval_unit === 'year')  return (s.amount * s.interval_count) / 12;
    if (s.interval_unit === 'week')  return (s.amount * s.interval_count * 52) / 12;
    return s.amount;
  };

  const rows = state.subscriptions.map(s => {
    const mo = toMonthly(s);
    if (_subEditId === s.id) {
      return `<tr id="sub-row-${s.id}">
        <td><input class="dt-input" id="sedit-name" value="${escHtml(s.name)}" style="width:140px;"></td>
        <td><input class="dt-input" id="sedit-amount" type="number" value="${s.amount}" style="width:80px;"></td>
        <td>
          <select class="dt-input" id="sedit-unit" style="width:90px;">
            <option value="month" ${s.interval_unit==='month'?'selected':''}>Monthly</option>
            <option value="year"  ${s.interval_unit==='year' ?'selected':''}>Yearly</option>
            <option value="week"  ${s.interval_unit==='week' ?'selected':''}>Weekly</option>
          </select>
        </td>
        <td><input class="dt-input" id="sedit-due" type="date" value="${s.next_due_date||''}" style="width:130px;"></td>
        <td>$${fmt(mo)}/mo</td>
        <td class="dt-actions">
          <button class="bill-btn edit" onclick="saveSubEdit(${s.id})">Save</button>
          <button class="bill-btn" onclick="cancelSubEdit()">Cancel</button>
        </td>
      </tr>`;
    }
    return `<tr id="sub-row-${s.id}">
      <td><strong>${escHtml(s.name)}</strong></td>
      <td>$${fmt(s.amount)}</td>
      <td>${cycleLabel(s)}</td>
      <td>${s.next_due_date ? fmtDate(s.next_due_date) : '<span class="dt-empty">—</span>'}</td>
      <td>$${fmt(mo)}/mo</td>
      <td class="dt-actions">
        <button class="bill-btn edit" onclick="startSubEdit(${s.id})">Edit</button>
        <button class="bill-btn" style="border-color:var(--danger);color:var(--danger);" onclick="deleteSub(${s.id})">Delete</button>
      </td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="sub-summary-bar">
      <div class="sub-summary-item">
        <div class="sub-summary-label">Monthly Total</div>
        <div class="sub-summary-value">$${fmt(monthly)}<span class="sub-summary-unit">/mo</span></div>
      </div>
      <div class="sub-summary-divider"></div>
      <div class="sub-summary-item">
        <div class="sub-summary-label">Annual Total</div>
        <div class="sub-summary-value">$${fmt(annual)}<span class="sub-summary-unit">/yr</span></div>
      </div>
      <div class="sub-summary-divider"></div>
      <div class="sub-summary-item">
        <div class="sub-summary-label">Subscriptions</div>
        <div class="sub-summary-value">${state.subscriptions.length}</div>
      </div>
    </div>
    <div class="debt-section" style="margin-top:1rem;">
      <table class="debt-table">
        <thead><tr><th>Name</th><th>Amount</th><th>Frequency</th><th>Next Due</th><th>Monthly Cost</th><th class="dt-actions"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function calcMonthlySubTotal() {
  return state.subscriptions.reduce((sum, s) => {
    if (s.interval_unit === 'month') return sum + s.amount * s.interval_count;
    if (s.interval_unit === 'year')  return sum + (s.amount * s.interval_count) / 12;
    if (s.interval_unit === 'week')  return sum + (s.amount * 52) / 12;
    return sum + s.amount;
  }, 0);
}

function cycleLabel(s) {
  if (s.interval_unit === 'month' && s.interval_count === 1) return 'Monthly';
  if (s.interval_unit === 'year'  && s.interval_count === 1) return 'Yearly';
  if (s.interval_unit === 'week'  && s.interval_count === 1) return 'Weekly';
  return `Every ${s.interval_count} ${s.interval_unit}${s.interval_count !== 1 ? 's' : ''}`;
}


// ═══════════════════════════════════════════════════════════════
// INSIGHTS
// ═══════════════════════════════════════════════════════════════
let insightsYear = new Date().getFullYear();

function insightsPrevYear() { insightsYear--; renderInsights(); }
function insightsNextYear() { insightsYear++; renderInsights(); }

function renderInsights() {
  const container = document.getElementById('insights-content');
  const label     = document.getElementById('insights-year-label');
  if (!container) return;
  if (label) label.textContent = insightsYear;

  const yr   = String(insightsYear);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── Filter data ──────────────────────────────────────────────
  const yearPaychecks = state.paychecks.filter(p => p.date && p.date.startsWith(yr));
  const yearPaidBills = state.bills.filter(b => b.is_paid && b.paid_date && b.paid_date.startsWith(yr));
  const yearAllBills  = state.bills.filter(b => b.due_date && b.due_date.startsWith(yr));

  // ── Top-level totals ─────────────────────────────────────────
  const totalIncome = yearPaychecks.reduce((s, p) => s + p.amount, 0);
  const totalPaid   = yearPaidBills.reduce((s, b) => s + b.amount, 0);
  const netLeft     = totalIncome - totalPaid;
  const paidOnTime  = yearPaidBills.filter(b => b.paid_date && b.due_date && b.paid_date <= b.due_date).length;
  const paidLate    = yearPaidBills.length - paidOnTime;

  // ── Income by source ─────────────────────────────────────────
  const bySource = {};
  yearPaychecks.forEach(p => {
    const k = p.notes || 'Income';
    bySource[k] = (bySource[k] || 0) + p.amount;
  });
  const sourceEntries = Object.entries(bySource).sort(([,a],[,b]) => b - a);
  const maxSource = Math.max(...sourceEntries.map(([,v]) => v), 1);

  // ── Monthly data ─────────────────────────────────────────────
  const monthly = MONTHS.map((name, i) => {
    const mStr   = `${yr}-${String(i + 1).padStart(2, '0')}`;
    const income = yearPaychecks.filter(p => p.date.startsWith(mStr)).reduce((s, p) => s + p.amount, 0);
    const paid   = yearPaidBills.filter(b => b.paid_date && b.paid_date.startsWith(mStr)).reduce((s, b) => s + b.amount, 0);
    return { name, income, paid };
  });
  const maxMonthly = Math.max(...monthly.map(m => Math.max(m.income, m.paid)), 1);

  // ── Top bills ────────────────────────────────────────────────
  const billTotals = {};
  yearPaidBills.forEach(b => { billTotals[b.name] = (billTotals[b.name] || 0) + b.amount; });
  const topBills = Object.entries(billTotals).sort(([,a],[,b]) => b - a).slice(0, 10);
  const maxBill  = topBills.length ? topBills[0][1] : 1;

  // ── Bill breakdowns ───────────────────────────────────────────
  const autopayCount   = yearAllBills.filter(b => b.autopay).length;
  const manualCount    = yearAllBills.filter(b => !b.autopay).length;
  const recurringCount = yearAllBills.filter(b => b.is_recurring).length;
  const onetimeCount   = yearAllBills.filter(b => !b.is_recurring).length;
  const totalBillCount = yearAllBills.length || 1;

  // ── Subscriptions ────────────────────────────────────────────
  const subAnnual = state.subscriptions.reduce((s, sub) => {
    const unit  = sub.interval_unit || 'month';
    const count = sub.interval_count || 1;
    const monthly = unit === 'year' ? sub.amount / 12 / count : sub.amount / count;
    return s + monthly * 12;
  }, 0);

  // ── Savings ──────────────────────────────────────────────────
  const totalSavedAll = state.savingsGoals.reduce((s, g) => s + g.current_amount, 0);
  const totalTargetAll = state.savingsGoals.reduce((s, g) => s + g.target_amount, 0);

  // ── Debt ─────────────────────────────────────────────────────
  const totalDebt  = state.debtAccounts.filter(d => (d.status || 'balance') === 'balance').reduce((s, d) => s + (d.balance || 0), 0);
  const cardDebt   = state.debtAccounts.filter(d => d.account_type === 'credit_card' && (d.status || 'balance') === 'balance').reduce((s, d) => s + d.balance, 0);
  const loanDebt   = state.debtAccounts.filter(d => d.account_type === 'loan' && (d.status || 'balance') === 'balance').reduce((s, d) => s + d.balance, 0);

  // ── Render ───────────────────────────────────────────────────
  const noData = totalIncome === 0 && yearPaidBills.length === 0;

  container.innerHTML = `
    ${noData ? `<div class="empty-state"><div class="empty-state-icon">📊</div><p>No data found for ${yr}. Try a different year.</p></div>` : `

    <!-- Stat Cards -->
    <div class="insights-stat-grid">
      <div class="ins-stat-card">
        <div class="ins-stat-label">Total Income</div>
        <div class="ins-stat-value green">$${fmt(totalIncome)}</div>
        <div class="ins-stat-sub">${yearPaychecks.length} paycheck${yearPaychecks.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="ins-stat-card">
        <div class="ins-stat-label">Total Bills Paid</div>
        <div class="ins-stat-value red">$${fmt(totalPaid)}</div>
        <div class="ins-stat-sub">${yearPaidBills.length} bill${yearPaidBills.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="ins-stat-card">
        <div class="ins-stat-label">Net Remaining</div>
        <div class="ins-stat-value ${netLeft >= 0 ? 'green' : 'red'}">$${fmt(netLeft)}</div>
        <div class="ins-stat-sub">after all paid bills</div>
      </div>
      <div class="ins-stat-card">
        <div class="ins-stat-label">Paid on Time</div>
        <div class="ins-stat-value gold">${paidOnTime}</div>
        <div class="ins-stat-sub">${paidLate} paid late</div>
      </div>
    </div>

    <!-- Row 1: Income by Source + Bill Breakdown -->
    <div class="insights-row">
      <div class="ins-card">
        <div class="ins-card-title">💵 Income by Source</div>
        ${sourceEntries.length ? sourceEntries.map(([src, amt]) => `
          <div class="ins-bar-row">
            <div class="ins-bar-label">${escHtml(src)}</div>
            <div class="ins-bar-track"><div class="ins-bar-fill green-bar" style="width:${Math.round((amt/maxSource)*100)}%"></div></div>
            <div class="ins-bar-val">$${fmt(amt)}</div>
          </div>`).join('') : '<p class="empty-state" style="padding:1rem 0;">No paychecks for this year.</p>'}
      </div>
      <div class="ins-card">
        <div class="ins-card-title">📋 Bill Breakdown</div>
        <div class="ins-breakdown-grid">
          <div class="ins-breakdown-item">
            <div class="ins-breakdown-circle" style="--pct:${Math.round((autopayCount/totalBillCount)*100)}%;--clr:var(--sage-dk);">
              <span>${Math.round((autopayCount/totalBillCount)*100)}%</span>
            </div>
            <div class="ins-breakdown-label">AutoPay</div>
            <div class="ins-breakdown-count">${autopayCount} of ${yearAllBills.length}</div>
          </div>
          <div class="ins-breakdown-item">
            <div class="ins-breakdown-circle" style="--pct:${Math.round((manualCount/totalBillCount)*100)}%;--clr:var(--gold);">
              <span>${Math.round((manualCount/totalBillCount)*100)}%</span>
            </div>
            <div class="ins-breakdown-label">Manual Pay</div>
            <div class="ins-breakdown-count">${manualCount} of ${yearAllBills.length}</div>
          </div>
          <div class="ins-breakdown-item">
            <div class="ins-breakdown-circle" style="--pct:${Math.round((recurringCount/totalBillCount)*100)}%;--clr:#6366f1;">
              <span>${Math.round((recurringCount/totalBillCount)*100)}%</span>
            </div>
            <div class="ins-breakdown-label">Recurring</div>
            <div class="ins-breakdown-count">${recurringCount} of ${yearAllBills.length}</div>
          </div>
          <div class="ins-breakdown-item">
            <div class="ins-breakdown-circle" style="--pct:${Math.round((onetimeCount/totalBillCount)*100)}%;--clr:#f59e0b;">
              <span>${Math.round((onetimeCount/totalBillCount)*100)}%</span>
            </div>
            <div class="ins-breakdown-label">One-Time</div>
            <div class="ins-breakdown-count">${onetimeCount} of ${yearAllBills.length}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Monthly Overview Chart -->
    <div class="ins-card ins-card-full">
      <div class="ins-card-title">📅 Monthly Overview — Income vs Bills Paid</div>
      <div class="ins-legend">
        <span class="ins-legend-dot green-dot"></span><span>Income</span>
        <span class="ins-legend-dot red-dot" style="margin-left:1rem;"></span><span>Bills Paid</span>
      </div>
      <div class="ins-bar-chart">
        ${monthly.map(m => `
          <div class="ins-month-col">
            <div class="ins-month-bars">
              <div class="ins-month-bar green-bar" style="height:${m.income ? Math.max(4, Math.round((m.income/maxMonthly)*160)) : 0}px" title="Income: $${fmt(m.income)}"></div>
              <div class="ins-month-bar red-bar"   style="height:${m.paid   ? Math.max(4, Math.round((m.paid/maxMonthly)*160))   : 0}px" title="Paid: $${fmt(m.paid)}"></div>
            </div>
            <div class="ins-month-label">${m.name}</div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Top Bills + Financials summary -->
    <div class="insights-row">
      <div class="ins-card">
        <div class="ins-card-title">🏆 Top 10 Bills Paid</div>
        ${topBills.length ? topBills.map(([name, amt], i) => `
          <div class="ins-bar-row">
            <div class="ins-bar-label"><span class="ins-rank">${i+1}</span>${escHtml(name)}</div>
            <div class="ins-bar-track"><div class="ins-bar-fill red-bar" style="width:${Math.round((amt/maxBill)*100)}%"></div></div>
            <div class="ins-bar-val">$${fmt(amt)}</div>
          </div>`).join('') : '<p class="empty-state" style="padding:1rem 0;">No paid bills found.</p>'}
      </div>

      <div style="display:flex;flex-direction:column;gap:1.2rem;">
        <!-- Subscriptions -->
        <div class="ins-card">
          <div class="ins-card-title">🔁 Subscriptions</div>
          <div class="ins-summary-row"><span>Monthly Cost</span><strong>$${fmt(subAnnual/12)}/mo</strong></div>
          <div class="ins-summary-row"><span>Annual Cost</span><strong style="color:var(--danger);">$${fmt(subAnnual)}/yr</strong></div>
          <div class="ins-summary-row"><span>Active Subscriptions</span><strong>${state.subscriptions.length}</strong></div>
        </div>

        <!-- Savings -->
        <div class="ins-card">
          <div class="ins-card-title">🎯 Savings Goals</div>
          <div class="ins-summary-row"><span>Total Saved</span><strong style="color:var(--sage-dk);">$${fmt(totalSavedAll)}</strong></div>
          <div class="ins-summary-row"><span>Total Target</span><strong>$${fmt(totalTargetAll)}</strong></div>
          <div class="ins-summary-row"><span>Goals Active</span><strong>${state.savingsGoals.length}</strong></div>
        </div>

        <!-- Debt -->
        <div class="ins-card">
          <div class="ins-card-title">💳 Debt Overview</div>
          <div class="ins-summary-row"><span>Total Debt</span><strong style="color:var(--danger);">$${fmt(totalDebt)}</strong></div>
          <div class="ins-summary-row"><span>Credit Cards</span><strong>$${fmt(cardDebt)}</strong></div>
          <div class="ins-summary-row"><span>Loans</span><strong>$${fmt(loanDebt)}</strong></div>
        </div>
      </div>
    </div>
  `}`;
}

// ═══════════════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════════════
async function renderCalendar() {
  const month = `${calYear}-${String(calMonth + 1).padStart(2, '0')}`;
  const label = document.getElementById('cal-month-label');
  if (label) label.textContent = new Date(calYear, calMonth, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });

  const events = await fetch(`/api/calendar?month=${month}`).then(r => r.json());

  // Group events by date
  const byDate = {};
  events.forEach(e => {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  });

  const container = document.getElementById('calendar-grid');
  if (!container) return;

  // Build calendar grid
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const prevDays = new Date(calYear, calMonth, 0).getDate();

  let html = `<div class="cal-day-names">`;
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => html += `<div class="cal-day-name">${d}</div>`);
  html += `</div><div class="cal-grid">`;

  // Prev month filler
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${prevDays - i}</div></div>`;
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === state.today;
    const dayEvents = byDate[dateStr] || [];
    const evHtml = dayEvents.map(e => `<div class="cal-event ${e.type === 'paycheck' ? 'ev-pay' : e.type === 'bill' ? 'ev-bill' : e.type === 'subscription' ? 'ev-sub' : e.type === 'promo' ? 'ev-promo' : 'ev-goal'}" title="${e.title}">${e.title}</div>`).join('');
    html += `<div class="cal-day ${isToday ? 'today' : ''}" data-count="${dayEvents.length || ''}">
      <div class="cal-day-num">${d}</div>${evHtml}</div>`;
  }

  // Next month filler
  const remaining = 42 - (firstDay + daysInMonth);
  for (let d = 1; d <= remaining; d++) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${d}</div></div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

function prevMonth() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); }
function nextMonth() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); }


// ═══════════════════════════════════════════════════════════════
// ACTIONS — Paychecks
// ═══════════════════════════════════════════════════════════════
async function addPaycheck() {
  const date   = document.getElementById('pc-date').value;
  const amount = parseFloat(document.getElementById('pc-amount').value);
  const notes  = document.getElementById('pc-notes').value;
  if (!date || !amount) return alert('Date and amount are required.');

  const data = await api('POST', '/api/paychecks', { date, amount, notes });
  state.paychecks.push(data);
  closeModal('modal-add-paycheck');
  clearFields(['pc-date','pc-amount','pc-notes']);
  populatePaycheckDropdowns();
  renderPlanner();
  renderDashboard();
}


function openEditPaycheck(id) {
  const p = state.paychecks.find(x => x.id === id);
  if (!p) return;
  document.getElementById('edit-pc-id').value     = id;
  document.getElementById('edit-pc-date').value   = p.date;
  document.getElementById('edit-pc-amount').value = p.amount;
  document.getElementById('edit-pc-notes').value  = p.notes || '';
  openModal('modal-edit-paycheck');
}

async function saveEditPaycheck() {
  const id     = parseInt(document.getElementById('edit-pc-id').value);
  const date   = document.getElementById('edit-pc-date').value;
  const amount = parseFloat(document.getElementById('edit-pc-amount').value);
  const notes  = document.getElementById('edit-pc-notes').value;
  if (!date || !amount) return alert('Date and amount are required.');

  const data = await api('PUT', `/api/paychecks/${id}`, { date, amount, notes });
  const idx = state.paychecks.findIndex(p => p.id === id);
  if (idx > -1) state.paychecks[idx] = { ...state.paychecks[idx], ...data };
  closeModal('modal-edit-paycheck');
  populatePaycheckDropdowns();
  renderPlanner();
  renderDashboard();
}

async function deletePaycheck() {
  const id = parseInt(document.getElementById('edit-pc-id').value);
  if (!confirm('Delete this paycheck? Bills assigned to it will become unassigned.')) return;
  await api('DELETE', `/api/paychecks/${id}`, null);
  state.paychecks = state.paychecks.filter(p => p.id !== id);
  // Unassign bills that were linked to this paycheck
  state.bills.forEach(b => { if (b.paycheck_id === id) b.paycheck_id = null; });
  closeModal('modal-edit-paycheck');
  populatePaycheckDropdowns();
  renderPlanner();
  renderDashboard();
}


// ═══════════════════════════════════════════════════════════════
// ACTIONS — Bills
// ═══════════════════════════════════════════════════════════════
function handleCategoryChange() {
  const cat = document.getElementById('bill-category').value;
  document.getElementById('savings-goal-picker').style.display =
    (cat === 'savings' || cat === 'trip') ? 'block' : 'none';
}

function toggleFrequencyField(rowId, show) {
  const el = document.getElementById(rowId);
  if (el) el.style.display = show ? 'block' : 'none';
}

// Sync planned pay date to due date unless user has manually changed it
let _plannedDateTouched = false;
function syncPlannedDate() {
  if (!_plannedDateTouched) {
    const due = document.getElementById('bill-due-date').value;
    document.getElementById('bill-planned-date').value = due;
  }
}

async function addBill() {
  const name       = document.getElementById('bill-name').value.trim();
  const amount     = parseFloat(document.getElementById('bill-amount').value);
  const category   = document.getElementById('bill-category').value;
  const goalId     = document.getElementById('bill-savings-goal').value || null;
  const dueDate    = document.getElementById('bill-due-date').value || null;
  const plannedDate= document.getElementById('bill-planned-date').value || null;
  const rawPaycheck = document.getElementById('bill-paycheck').value;
  // 'auto' → find the best matching paycheck by due date
  const paycheckId = rawPaycheck === 'auto'
    ? autoAssignPaycheck(dueDate || plannedDate)
    : (rawPaycheck ? parseInt(rawPaycheck) : null);
  // Auto-derive billing month from due date (or planned date as fallback)
  const month      = (dueDate || plannedDate || '').slice(0, 7) || null;
  const recurring  = document.getElementById('bill-recurring').checked;
  const autopay    = document.getElementById('bill-autopay').checked;
  const notes      = document.getElementById('bill-notes').value;
  const frequency  = document.getElementById('bill-frequency').value || 'monthly';

  if (!name || !amount) return alert('Name and amount are required.');

  const data = await api('POST', '/api/bills', {
    name, amount, category, savings_goal_id: goalId ? parseInt(goalId) : null,
    due_date: dueDate, planned_pay_date: plannedDate,
    paycheck_id: paycheckId ? parseInt(paycheckId) : null,
    month, is_recurring: recurring, autopay, notes, frequency
  });
  state.bills.push(data);

  // Update goal amount in local state if applicable
  if (goalId && (category === 'savings' || category === 'trip')) {
    const goal = state.savingsGoals.find(g => g.id === parseInt(goalId));
    if (goal) goal.current_amount += amount;
  }

  closeModal('modal-add-bill');
  clearFields(['bill-name','bill-amount','bill-due-date','bill-planned-date','bill-notes']);
  document.getElementById('bill-recurring').checked = false;
  document.getElementById('bill-autopay').checked   = false;
  document.getElementById('bill-frequency').value   = 'monthly';
  toggleFrequencyField('bill-frequency-row', false);
  document.getElementById('bill-paycheck').value = 'auto';
  document.getElementById('bill-category').value = 'bill';
  document.getElementById('savings-goal-picker').style.display = 'none';
  renderPlanner();
  renderDashboard();
}

async function togglePay(id) {
  const data = await api('POST', `/api/bills/${id}/pay`, {});
  const bill = state.bills.find(b => b.id === id);
  if (bill) { bill.is_paid = data.is_paid; bill.is_postponed = 0; bill.paid_date = data.paid_date || null; }
  renderPlanner();
  renderDashboard();
}

function openPostpone(id) {
  document.getElementById('postpone-bill-id').value = id;
  document.getElementById('postpone-date').value = state.today;
  openModal('modal-postpone');
}

async function doPostpone() {
  const id   = parseInt(document.getElementById('postpone-bill-id').value);
  const date = document.getElementById('postpone-date').value;
  await api('POST', `/api/bills/${id}/postpone`, { new_date: date });
  const bill = state.bills.find(b => b.id === id);
  if (bill) { bill.is_postponed = 1; bill.is_paid = 0; bill.planned_pay_date = date; }
  closeModal('modal-postpone');
  renderPlanner();
}

async function unPostpone(id) {
  await api('POST', `/api/bills/${id}/unpostpone`, {});
  const bill = state.bills.find(b => b.id === id);
  if (bill) { bill.is_postponed = 0; }
  renderPlanner();
}

function openEditBill(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  document.getElementById('edit-bill-id').value      = id;
  document.getElementById('edit-bill-name').value    = bill.name;
  document.getElementById('edit-bill-amount').value  = bill.amount;
  document.getElementById('edit-bill-due').value     = bill.due_date || '';
  document.getElementById('edit-bill-planned').value = bill.planned_pay_date || '';
  document.getElementById('edit-bill-notes').value   = bill.notes || '';
  document.getElementById('edit-bill-autopay').checked   = !!bill.autopay;
  document.getElementById('edit-bill-recurring').checked = !!bill.is_recurring;
  const freqSel = document.getElementById('edit-bill-frequency');
  if (freqSel) freqSel.value = bill.frequency || 'monthly';
  toggleFrequencyField('edit-bill-frequency-row', !!bill.is_recurring);
  const sel = document.getElementById('edit-bill-paycheck');
  if (sel) sel.value = bill.paycheck_id || '';
  openModal('modal-edit-bill');
}

async function saveEditBill() {
  const id      = parseInt(document.getElementById('edit-bill-id').value);
  const bill    = state.bills.find(b => b.id === id);
  const payload = {
    name:             document.getElementById('edit-bill-name').value,
    amount:           parseFloat(document.getElementById('edit-bill-amount').value),
    due_date:         document.getElementById('edit-bill-due').value || null,
    planned_pay_date: document.getElementById('edit-bill-planned').value || null,
    paycheck_id:      parseInt(document.getElementById('edit-bill-paycheck').value) || null,
    notes:            document.getElementById('edit-bill-notes').value,
    autopay:          document.getElementById('edit-bill-autopay').checked ? 1 : 0,
    is_paid:          bill ? bill.is_paid : 0,
    is_postponed:     bill ? bill.is_postponed : 0,
    is_recurring:     document.getElementById('edit-bill-recurring').checked ? 1 : 0,
    frequency:        document.getElementById('edit-bill-frequency').value || 'monthly',
    category:         bill ? bill.category : 'bill',
  };
  const data = await api('PUT', `/api/bills/${id}`, payload);
  const idx = state.bills.findIndex(b => b.id === id);
  if (idx > -1) state.bills[idx] = { ...state.bills[idx], ...data };
  closeModal('modal-edit-bill');
  renderPlanner();
  renderDashboard();
}

async function deleteBill() {
  const id = parseInt(document.getElementById('edit-bill-id').value);
  if (!confirm('Delete this bill?')) return;
  await api('DELETE', `/api/bills/${id}`, null);
  state.bills = state.bills.filter(b => b.id !== id);
  closeModal('modal-edit-bill');
  renderPlanner();
  renderDashboard();
}

// ── Recurring Bills Manager ────────────────────────────────────

function switchPlannerView(view) {
  const isPlanner   = view === 'planner';
  document.getElementById('planner-view').style.display    = isPlanner ? '' : 'none';
  document.getElementById('recurring-view').style.display  = isPlanner ? 'none' : '';
  document.getElementById('pvt-planner').classList.toggle('active', isPlanner);
  document.getElementById('pvt-recurring').classList.toggle('active', !isPlanner);
  if (!isPlanner) renderRecurringInline();
}

function renderRecurringInline() {
  const listEl  = document.getElementById('recurring-inline-list');
  const emptyEl = document.getElementById('recurring-inline-empty');
  const monthEl = document.getElementById('recurring-month-inline');
  const label   = document.getElementById('recurring-month-label');
  if (!listEl) return;

  // Sync month label and generate-month input with current planner month
  const monthStr = `${plannerYear}-${String(plannerMonth + 1).padStart(2, '0')}`;
  if (label) label.textContent = new Date(plannerYear, plannerMonth, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (monthEl) monthEl.value = monthStr;

  // Bills for selected month — recurring bills whose due_date falls in this month
  const thisMonthBills = state.bills.filter(b =>
    b.is_recurring && b.due_date && b.due_date.slice(0, 7) === monthStr
  ).sort((a, b) => a.name.localeCompare(b.name));

  // Also collect unique templates (all recurring, for the total)
  const allRecurring = state.bills.filter(b => b.is_recurring);
  const seen = {};
  [...allRecurring].sort((a, b) => b.id - a.id).forEach(b => {
    const key = b.name.toLowerCase().trim();
    if (!seen[key]) seen[key] = b;
  });
  const allTemplates = Object.values(seen);

  if (!thisMonthBills.length) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    emptyEl.textContent = allTemplates.length
      ? `No recurring bills due in ${label?.textContent || monthStr}. Use "Add to Month" to generate them.`
      : 'No recurring bills yet. Mark a bill as "Recurring" when adding or editing it.';
    return;
  }
  emptyEl.style.display = 'none';

  const totalAmt = thisMonthBills.reduce((s, b) => s + b.amount, 0);
  const paidCount = thisMonthBills.filter(b => b.is_paid).length;

  listEl.innerHTML = `
    <div class="debt-section">
      <table class="debt-table">
        <thead>
          <tr>
            <th>Bill Name</th>
            <th>Amount</th>
            <th>Due Date</th>
            <th>Status</th>
            <th>AutoPay</th>
            <th class="dt-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${thisMonthBills.map(b => `
          <tr id="rec-inline-row-${b.id}" class="${b.is_paid ? 'dt-row-no-bal' : ''}">
            <td><strong>${escHtml(b.name)}</strong></td>
            <td style="color:${b.is_paid ? 'var(--text-lt)' : 'var(--danger)'};font-weight:700;">$${fmt(b.amount)}</td>
            <td>${b.due_date ? fmtDate(b.due_date) : '<span class="dt-empty">—</span>'}</td>
            <td>${b.is_paid
              ? '<span class="bucket-pill pill-paid" style="font-size:0.72rem;">✓ Paid</span>'
              : '<span class="bucket-pill pill-pending" style="font-size:0.72rem;">Unpaid</span>'}</td>
            <td>${b.autopay ? '<span class="bucket-pill pill-paid" style="font-size:0.72rem;">AutoPay</span>' : '<span class="dt-empty">Manual</span>'}</td>
            <td class="dt-actions">
              <button class="bill-btn edit" onclick="openEditBillFromRecurring(${b.id})">Edit</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:0.75rem;display:flex;gap:1.5rem;font-size:0.82rem;color:var(--text-lt);">
      <span>${thisMonthBills.length} bill${thisMonthBills.length !== 1 ? 's' : ''} this month</span>
      <span>Total: <strong style="color:var(--danger);">$${fmt(totalAmt)}</strong></span>
      <span>Paid: <strong style="color:var(--sage-dk);">${paidCount} of ${thisMonthBills.length}</strong></span>
    </div>`;
}

async function doGenerateRecurringInline() {
  const month = document.getElementById('recurring-month-inline').value;
  const msgEl = document.getElementById('recurring-gen-msg-inline');
  if (!month) return alert('Please select a month.');
  const result = await api('POST', '/api/bills/generate-recurring', { month });
  msgEl.style.display = 'inline';
  if (result.created > 0) {
    window.location.href = `?tab=planner`;
  } else {
    msgEl.style.color = 'var(--text-lt)';
    msgEl.textContent = `All recurring bills already exist for ${month}.`;
    setTimeout(() => { msgEl.style.display = 'none'; }, 4000);
  }
}

function openEditBillFromRecurring(id) {
  // Switch back to planner view and open the edit modal for this bill
  switchPlannerView('planner');
  openEditBill(id);
}

function openRecurringManager() {
  // Default month to current planner month
  const monthStr = `${plannerYear}-${String(plannerMonth + 1).padStart(2, '0')}`;
  const el = document.getElementById('recurring-month');
  if (el) el.value = monthStr;
  const msg = document.getElementById('recurring-gen-msg');
  if (msg) msg.style.display = 'none';
  renderRecurringList();
  openModal('modal-recurring');
}

function renderRecurringList() {
  const listEl  = document.getElementById('recurring-list');
  const emptyEl = document.getElementById('recurring-empty');
  if (!listEl) return;

  // Get unique recurring templates — most recent bill per name
  const recurringBills = state.bills.filter(b => b.is_recurring);
  const seen = {};
  // Sort newest first so we pick the most recent per name
  [...recurringBills].sort((a, b) => (b.id - a.id)).forEach(b => {
    const key = b.name.toLowerCase().trim();
    if (!seen[key]) seen[key] = b;
  });
  const templates = Object.values(seen).sort((a, b) => a.name.localeCompare(b.name));

  if (!templates.length) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  const freqLabel = { monthly:'Monthly', bimonthly:'Every 2 mo', quarterly:'Quarterly', semiannual:'Semi-annual', annual:'Annual' };
  listEl.innerHTML = `
    <div class="rec-header-row">
      <div>Bill Name</div>
      <div>Amount</div>
      <div>Due Day</div>
      <div>Frequency</div>
      <div>Notes</div>
      <div></div>
    </div>
    ${templates.map(b => `
    <div class="rec-row" id="rec-row-${b.id}">
      <div class="rec-cell">
        <input class="rec-input" id="rec-name-${b.id}" value="${escHtml(b.name)}" placeholder="Bill name"/>
      </div>
      <div class="rec-cell">
        <input class="rec-input rec-amount" id="rec-amount-${b.id}" type="number" step="0.01" value="${b.amount}" placeholder="0.00"/>
      </div>
      <div class="rec-cell">
        <input class="rec-input" id="rec-due-${b.id}" type="date" value="${b.due_date || ''}" title="Used as the anchor date for frequency calculations"/>
      </div>
      <div class="rec-cell">
        <select class="rec-input rec-freq" id="rec-freq-${b.id}">
          <option value="monthly"   ${(b.frequency||'monthly')==='monthly'   ? 'selected':''}>Monthly</option>
          <option value="bimonthly" ${(b.frequency||'monthly')==='bimonthly' ? 'selected':''}>Every 2 months</option>
          <option value="quarterly" ${(b.frequency||'monthly')==='quarterly' ? 'selected':''}>Quarterly</option>
          <option value="semiannual"${(b.frequency||'monthly')==='semiannual'? 'selected':''}>Semi-annual</option>
          <option value="annual"    ${(b.frequency||'monthly')==='annual'    ? 'selected':''}>Annual</option>
        </select>
      </div>
      <div class="rec-cell rec-notes-cell">
        <input class="rec-input" id="rec-notes-${b.id}" value="${escHtml(b.notes || '')}" placeholder="Notes…"/>
      </div>
      <div class="rec-cell rec-actions">
        <button class="rec-save-btn" onclick="saveRecurringTemplate(${b.id})" title="Save changes">💾</button>
        <button class="rec-del-btn"  onclick="removeRecurring(${b.id})"        title="Remove recurring flag">✕</button>
      </div>
    </div>`).join('')}
  `;
}

async function saveRecurringTemplate(id) {
  const name      = document.getElementById(`rec-name-${id}`).value.trim();
  const amount    = parseFloat(document.getElementById(`rec-amount-${id}`).value);
  const due       = document.getElementById(`rec-due-${id}`).value || null;
  const frequency = document.getElementById(`rec-freq-${id}`).value || 'monthly';
  const notes     = document.getElementById(`rec-notes-${id}`).value;

  if (!name || !amount) return alert('Name and amount are required.');

  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;

  const data = await api('PUT', `/api/bills/${id}`, { ...bill, name, amount, due_date: due, notes, frequency, is_recurring: 1 });
  const idx = state.bills.findIndex(b => b.id === id);
  if (idx > -1) state.bills[idx] = { ...state.bills[idx], ...data };

  // Visual confirmation
  const row = document.getElementById(`rec-row-${id}`);
  if (row) { row.style.background = '#d1fae5'; setTimeout(() => row.style.background = '', 1000); }
}

async function removeRecurring(id) {
  if (!confirm('Remove recurring flag from this bill? It will stay as a one-time bill.')) return;
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  const data = await api('PUT', `/api/bills/${id}`, { ...bill, is_recurring: 0 });
  const idx = state.bills.findIndex(b => b.id === id);
  if (idx > -1) state.bills[idx] = { ...state.bills[idx], ...data };
  renderRecurringList();
}

// Frequency check helper (mirrors server logic)
const FREQ_MONTHS = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, annual: 12 };
function billDueInMonth(bill, targetMonth) {
  const n = FREQ_MONTHS[bill.frequency || 'monthly'] || 1;
  if (n === 1) return true;
  const anchor = (bill.due_date || bill.planned_pay_date || '').slice(0, 7);
  if (!anchor) return true;
  const [ay, am] = anchor.split('-').map(Number);
  const [ty, tm] = targetMonth.split('-').map(Number);
  const diff = (ty - ay) * 12 + (tm - am);
  return diff >= 0 && diff % n === 0;
}

async function doGenerateRecurring() {
  const month   = document.getElementById('recurring-month').value;
  const msgEl   = document.getElementById('recurring-gen-msg');
  if (!month) return alert('Please select a month.');

  const result = await api('POST', '/api/bills/generate-recurring', { month });

  msgEl.style.display = 'inline';
  if (result.created > 0) {
    // Reload bills from server so new ones appear
    window.location.href = `?tab=planner`;
  } else {
    msgEl.style.color = 'var(--text-lt)';
    msgEl.textContent = `All recurring bills already exist for ${month} (or none are due that month).`;
    setTimeout(() => { msgEl.style.display = 'none'; }, 4000);
  }
}


// ═══════════════════════════════════════════════════════════════
// ACTIONS — Reconcile
// ═══════════════════════════════════════════════════════════════
function openReconcile(paycheckId) {
  document.getElementById('reconcile-paycheck-id').value = paycheckId;
  document.getElementById('reconcile-date').value = state.today;
  document.getElementById('reconcile-balance').value = '';
  document.getElementById('reconcile-result').style.display = 'none';
  openModal('modal-reconcile');
}

async function doReconcile() {
  const pid     = parseInt(document.getElementById('reconcile-paycheck-id').value);
  const balance = parseFloat(document.getElementById('reconcile-balance').value);
  const date    = document.getElementById('reconcile-date').value;
  if (!balance || !date) return alert('Please enter your bank balance and date.');

  const result = await api('POST', '/api/reconcile', {
    paycheck_id: pid, bank_balance: balance, date
  });

  // Push the new adjustment into state so the planner updates immediately
  state.balanceAdjustments.push({
    id:                result.id,
    paycheck_id:       pid,
    bank_balance:      balance,
    adjustment_amount: result.adjustment,
    adjustment_date:   date,
  });

  const resultEl = document.getElementById('reconcile-result');
  const sign = result.adjustment >= 0 ? '+' : '';
  resultEl.innerHTML = `
    <div class="alert alert-success" style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:0.85rem 1rem;font-size:0.875rem;">
      <strong>✓ Reconciled!</strong><br>
      Your bank balance: <strong>$${fmt(result.actual)}</strong><br>
      NorthStar expected: <strong>$${fmt(result.expected)}</strong><br>
      Adjustment applied: <strong style="color:${result.adjustment >= 0 ? 'var(--sage-dk)' : 'var(--danger)'};">${sign}$${fmt(result.adjustment)}</strong>
    </div>`;
  resultEl.style.display = 'block';

  // Re-render the planner so the adjustment shows immediately
  renderPlanner();
}

async function deleteAdjustment(id) {
  if (!confirm('Delete this reconcile adjustment?')) return;
  await api('DELETE', `/api/reconcile/${id}`, null);
  state.balanceAdjustments = state.balanceAdjustments.filter(a => a.id !== id);
  renderPlanner();
}


// ═══════════════════════════════════════════════════════════════
// ACTIONS — Savings Goals
// ═══════════════════════════════════════════════════════════════
async function addGoal() {
  const name   = document.getElementById('goal-name').value.trim();
  const target = parseFloat(document.getElementById('goal-target').value);
  const date   = document.getElementById('goal-date').value || null;
  if (!name || !target) return alert('Name and target amount are required.');

  const data = await api('POST', '/api/savings/goals', { name, target_amount: target, target_date: date });
  state.savingsGoals.push(data);
  closeModal('modal-add-goal');
  clearFields(['goal-name','goal-target','goal-date']);
  populateSavingsGoalDropdowns();
  renderSavings();
  renderDashboard();
}

async function deleteGoal(id) {
  if (!confirm('Delete this savings goal?')) return;
  await api('DELETE', `/api/savings/goals/${id}`, null);
  state.savingsGoals = state.savingsGoals.filter(g => g.id !== id);
  populateSavingsGoalDropdowns();
  renderSavings();
  renderDashboard();
}

async function editGoal(id) {
  const goal = state.savingsGoals.find(g => g.id === id);
  if (!goal) return;
  const newName    = prompt('Goal name:', goal.name);
  if (newName === null) return;
  const newTarget  = parseFloat(prompt('Target amount:', goal.target_amount));
  const newCurrent = parseFloat(prompt('Current saved amount:', goal.current_amount));
  const newDate    = prompt('Target date (YYYY-MM-DD, or blank):', goal.target_date || '');
  const data = await api('PUT', `/api/savings/goals/${id}`, {
    name: newName, target_amount: newTarget,
    current_amount: isNaN(newCurrent) ? goal.current_amount : newCurrent,
    target_date: newDate || null
  });
  const idx = state.savingsGoals.findIndex(g => g.id === id);
  if (idx > -1) {
    const wasComplete = state.savingsGoals[idx].current_amount >= state.savingsGoals[idx].target_amount;
    state.savingsGoals[idx] = data;
    if (!wasComplete && data.current_amount >= data.target_amount) {
      showCelebration(`Goal reached! "${data.name}" is fully funded! 🎯`);
    }
  }
  populateSavingsGoalDropdowns();
  renderSavings();
  renderDashboard();
}


// ═══════════════════════════════════════════════════════════════
// ACTIONS — Debt
// ═══════════════════════════════════════════════════════════════
function togglePromoFields() {
  const show = document.getElementById('debt-is-promo').checked;
  document.getElementById('promo-fields').style.display = show ? 'block' : 'none';
  // Show/hide loan-specific fields based on type
  const type = document.getElementById('debt-type').value;
  const loanFields = document.getElementById('loan-fields');
  if (loanFields) loanFields.style.display = type === 'loan' ? 'block' : 'none';
}
function toggleDebtTypeFields() {
  const type = document.getElementById('debt-type').value;
  const loanFields = document.getElementById('loan-fields');
  if (loanFields) loanFields.style.display = type === 'loan' ? 'block' : 'none';
  // Update status options based on type
  const statusSel = document.getElementById('debt-status');
  if (statusSel) {
    const hasClosed = type === 'credit_card';
    const closedOpt = statusSel.querySelector('option[value="closed"]');
    if (closedOpt) closedOpt.style.display = hasClosed ? '' : 'none';
  }
}

async function addDebt() {
  const name      = document.getElementById('debt-name').value.trim();
  const type      = document.getElementById('debt-type').value;
  const balance   = parseFloat(document.getElementById('debt-balance').value) || 0;
  const limit     = parseFloat(document.getElementById('debt-limit').value) || null;
  const apr       = parseFloat(document.getElementById('debt-apr').value) || 0;
  const payment   = parseFloat(document.getElementById('debt-payment').value) || null;
  const status    = document.getElementById('debt-status').value || 'balance';
  const endDate   = document.getElementById('debt-end-date').value || null;
  const notes     = document.getElementById('debt-notes').value.trim() || null;
  const isPromo   = document.getElementById('debt-is-promo').checked;
  const promoRate = isPromo ? parseFloat(document.getElementById('debt-promo-rate').value) || 0 : null;
  const promoEnd  = isPromo ? document.getElementById('debt-promo-end').value || null : null;
  const promoStart= isPromo ? document.getElementById('debt-promo-start').value || null : null;
  if (!name) return alert('Account name is required.');

  const data = await api('POST', '/api/debt', {
    name, account_type: type, balance, credit_limit: limit,
    apr, monthly_payment: payment, is_promo: isPromo,
    promo_rate: promoRate, promo_end_date: promoEnd, promo_start_date: promoStart,
    status, end_date: endDate, notes
  });
  state.debtAccounts.push(data);
  closeModal('modal-add-debt');
  clearFields(['debt-name','debt-balance','debt-limit','debt-apr','debt-payment','debt-end-date','debt-notes']);
  document.getElementById('debt-is-promo').checked = false;
  document.getElementById('promo-fields').style.display = 'none';
  renderDebt();
}

async function deleteDebt(id) {
  if (!confirm('Delete this debt account?')) return;
  await api('DELETE', `/api/debt/${id}`, null);
  state.debtAccounts = state.debtAccounts.filter(d => d.id !== id);
  if (_debtEditId === id) _debtEditId = null;
  renderDebt();
}

async function markPromoPaid(id) {
  const d   = state.debtAccounts.find(d => d.id === id);
  const res = await api('PUT', `/api/debt/${id}`, { status: 'closed' });
  if (res && res.id) {
    const idx = state.debtAccounts.findIndex(d => d.id === id);
    if (idx !== -1) state.debtAccounts[idx] = { ...state.debtAccounts[idx], ...res };
    renderDebt();
    showCelebration(`Promotion paid off! "${d ? d.name : 'Account'}" is closed! 🎉`);
  }
}


// ═══════════════════════════════════════════════════════════════
// ACTIONS — Subscriptions
// ═══════════════════════════════════════════════════════════════
async function addSubscription() {
  const name     = document.getElementById('sub-name').value.trim();
  const amount   = parseFloat(document.getElementById('sub-amount').value);
  const interval = document.getElementById('sub-interval').value;
  const nextDue  = document.getElementById('sub-next-due').value || null;
  if (!name || !amount) return alert('Name and amount are required.');

  const data = await api('POST', '/api/subscriptions', {
    name, amount, interval_unit: interval, interval_count: 1, next_due_date: nextDue
  });
  state.subscriptions.push(data);
  closeModal('modal-add-sub');
  clearFields(['sub-name','sub-amount','sub-next-due']);
  renderSubscriptions();
  renderDashboard();
}

async function deleteSub(id) {
  if (!confirm('Delete this subscription?')) return;
  await api('DELETE', `/api/subscriptions/${id}`, null);
  state.subscriptions = state.subscriptions.filter(s => s.id !== id);
  renderSubscriptions();
  renderDashboard();
}

function startSubEdit(id) {
  _subEditId = id;
  renderSubscriptions();
}
function cancelSubEdit() {
  _subEditId = null;
  renderSubscriptions();
}
async function saveSubEdit(id) {
  const s = state.subscriptions.find(x => x.id === id);
  if (!s) return;
  const name   = document.getElementById('sedit-name').value.trim();
  const amount = parseFloat(document.getElementById('sedit-amount').value);
  const unit   = document.getElementById('sedit-unit').value;
  const due    = document.getElementById('sedit-due').value || null;
  if (!name || isNaN(amount)) return alert('Name and amount are required.');
  const data = await api('PUT', `/api/subscriptions/${id}`, { ...s, name, amount, interval_unit: unit, next_due_date: due });
  const idx = state.subscriptions.findIndex(x => x.id === id);
  if (idx > -1) state.subscriptions[idx] = { ...state.subscriptions[idx], ...data };
  _subEditId = null;
  renderSubscriptions();
  renderDashboard();
}
async function editSub(id) { startSubEdit(id); }


// ═══════════════════════════════════════════════════════════════
// ACTIONS — Help
// ═══════════════════════════════════════════════════════════════
async function submitHelp() {
  const subject = document.getElementById('help-subject').value.trim();
  const message = document.getElementById('help-message').value.trim();
  if (!message) return alert('Please enter a message.');
  await api('POST', '/api/help', { subject, message });
  document.getElementById('help-subject').value = '';
  document.getElementById('help-message').value = '';
  document.getElementById('help-success').style.display = 'block';
  setTimeout(() => document.getElementById('help-success').style.display = 'none', 4000);
}


// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
function fmt(n) {
  return (Math.abs(n) < 0.01 ? 0 : n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return new Date(parseInt(y), parseInt(m)-1, parseInt(day))
    .toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to   + 'T00:00:00');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function clearFields(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}


// ═══════════════════════════════════════════════════════════════
// STICKY NOTES
// ═══════════════════════════════════════════════════════════════

let selectedNoteColor = 'yellow';

function renderStickyNotes() {
  const board = document.getElementById('sticky-notes-board');
  if (!board) return;

  if (!state.stickyNotes.length) {
    board.innerHTML = '<p class="notes-empty">No notes yet — add one to get started!</p>';
    return;
  }

  board.innerHTML = state.stickyNotes.map(n => {
    const isHex      = (n.color || '').startsWith('#');
    const colorClass = isHex ? '' : `note-${n.color || 'yellow'}`;
    const colorStyle = isHex ? `background:${n.color};` : '';
    const dateStr = n.updated_at ? new Date(n.updated_at).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
    return `
    <div class="sticky-note ${colorClass}" style="${colorStyle}" id="note-${n.id}">
      ${n.title ? `<div class="sticky-note-title">${escHtml(n.title)}</div>` : '<div style="height:0.8rem;"></div>'}
      <div class="sticky-note-content">${escHtml(n.content)}</div>
      <div class="sticky-note-date">${dateStr}</div>
      <div class="sticky-note-footer">
        <button class="sticky-note-btn" onclick="openEditNote(${n.id})">✏️ Edit</button>
        <button class="sticky-note-btn" onclick="deleteNote(${n.id})">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

function selectNoteColor(color, btn) {
  selectedNoteColor = color;
  document.querySelectorAll('.note-color-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function openEditNote(id) {
  const note = state.stickyNotes.find(n => n.id === id);
  if (!note) return;
  document.getElementById('note-edit-id').value   = id;
  document.getElementById('note-title').value     = note.title || '';
  document.getElementById('note-content').value   = note.content || '';
  selectedNoteColor = note.color || 'yellow';
  // Set active color button
  document.querySelectorAll('.note-color-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.color === selectedNoteColor);
  });
  document.querySelector('.modal-header h3').textContent = '📌 Edit Note';
  openModal('modal-add-note');
}

async function saveNote() {
  const editId  = document.getElementById('note-edit-id').value;
  const title   = document.getElementById('note-title').value.trim();
  const content = document.getElementById('note-content').value.trim();
  const color   = selectedNoteColor;

  if (!content) return alert('Please write something in the note.');

  if (editId) {
    // Edit existing
    const data = await api('PUT', `/api/notes/${editId}`, { title, content, color });
    const idx = state.stickyNotes.findIndex(n => n.id === parseInt(editId));
    if (idx > -1) state.stickyNotes[idx] = { ...state.stickyNotes[idx], ...data };
  } else {
    // New note
    const data = await api('POST', '/api/notes', { title, content, color });
    state.stickyNotes.unshift(data);
  }

  closeModal('modal-add-note');
  clearFields(['note-title', 'note-content', 'note-edit-id']);
  selectedNoteColor = 'yellow';
  document.querySelectorAll('.note-color-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.querySelector('#modal-add-note .modal-header h3').textContent = '📌 New Sticky Note';
  renderStickyNotes();
}

async function deleteNote(id) {
  if (!confirm('Delete this note?')) return;
  await api('DELETE', `/api/notes/${id}`, null);
  state.stickyNotes = state.stickyNotes.filter(n => n.id !== id);
  renderStickyNotes();
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ═══════════════════════════════════════════════════════════════
// DROPDOWN POPULATION
// ═══════════════════════════════════════════════════════════════

function populatePaycheckDropdowns() {
  // Sort paychecks newest first for the dropdown display
  const sorted = [...state.paychecks].sort((a, b) => b.date.localeCompare(a.date));
  const optionsHtml = sorted.map(p =>
    `<option value="${p.id}">${fmtDate(p.date)} — $${fmt(p.amount)}</option>`
  ).join('');

  // Add Bill dropdown: default is Auto-assign
  const addSel = document.querySelector('#bill-paycheck');
  if (addSel) {
    const current = addSel.value;
    addSel.innerHTML = '<option value="auto">✦ Auto-assign by due date</option><option value="">— Unassigned —</option>' + optionsHtml;
    if (current && addSel.querySelector(`option[value="${current}"]`)) {
      addSel.value = current;
    } else {
      addSel.value = 'auto';
    }
  }

  // Edit / Move dropdowns: default is Unassigned (manual control)
  ['#edit-bill-paycheck', '#move-bill-paycheck'].forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    const current = el.value;
    el.innerHTML = '<option value="">— Unassigned —</option>' + optionsHtml;
    if (current && el.querySelector(`option[value="${current}"]`)) {
      el.value = current;
    }
  });
}

// Find the best paycheck for a bill's due date:
// → the most-recent paycheck whose date is on or before the due date.
// → if no paycheck precedes the due date, use the earliest paycheck.
function autoAssignPaycheck(dueDate) {
  if (!dueDate || !state.paychecks.length) return null;
  const sorted = [...state.paychecks].sort((a, b) => a.date.localeCompare(b.date));
  let best = null;
  for (const p of sorted) {
    if (p.date <= dueDate) best = p;
  }
  if (!best) best = sorted[0]; // all paychecks are after due date → use earliest
  return best ? best.id : null;
}

function openMoveBill(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  document.getElementById('move-bill-id').value = id;
  populatePaycheckDropdowns();
  const sel = document.getElementById('move-bill-paycheck');
  if (sel) sel.value = bill.paycheck_id || '';
  openModal('modal-move-bill');
}

async function doMoveBill() {
  const id         = parseInt(document.getElementById('move-bill-id').value);
  const paycheckId = parseInt(document.getElementById('move-bill-paycheck').value) || null;
  const bill       = state.bills.find(b => b.id === id);
  if (!bill) return;

  const data = await api('PUT', `/api/bills/${id}`, {
    ...bill, paycheck_id: paycheckId
  });
  const idx = state.bills.findIndex(b => b.id === id);
  if (idx > -1) state.bills[idx] = { ...state.bills[idx], ...data };
  closeModal('modal-move-bill');
  renderPlanner();
  renderDashboard();
}

function populateSavingsGoalDropdowns() {
  const optionsHtml = state.savingsGoals.map(g =>
    `<option value="${g.id}">${g.name} ($${fmt(g.current_amount)} / $${fmt(g.target_amount)})</option>`
  ).join('');

  const el = document.getElementById('bill-savings-goal');
  if (!el) return;
  const current = el.value;
  el.innerHTML = '<option value="">— Select a goal —</option>' + optionsHtml;
  if (current && el.querySelector(`option[value="${current}"]`)) {
    el.value = current;
  }
}


// ═══════════════════════════════════════════════════════════════
// CALCULATOR
// ═══════════════════════════════════════════════════════════════

let calcBuffer = '';
let calcOperator = '';
let calcPrev = null;
let calcNewNum = false;
let calcActiveTab = 'basic';

function openCalculator() {
  calcBuffer = '';
  calcOperator = '';
  calcPrev = null;
  calcNewNum = false;
  updateCalcDisplay('0');
  openModal('modal-calculator');
}

function switchCalcTab(tab) {
  calcActiveTab = tab;
  document.querySelectorAll('.calc-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.calc-panel').forEach(p => p.style.display = p.id === 'calc-panel-' + tab ? 'block' : 'none');
}

function calcInput(val) {
  if (calcNewNum) {
    calcBuffer = (val === '.') ? '0.' : val;
    calcNewNum = false;
  } else {
    if (val === '.' && calcBuffer.includes('.')) return;
    if (calcBuffer === '0' && val !== '.') calcBuffer = val;
    else calcBuffer += val;
  }
  updateCalcDisplay(calcBuffer);
}

function calcOp(op) {
  const num = parseFloat(calcBuffer);
  if (calcPrev !== null && !calcNewNum) {
    calcPrev = applyOp(calcPrev, calcOperator, num);
    updateCalcDisplay(calcPrev);
  } else {
    calcPrev = num;
  }
  calcOperator = op;
  calcNewNum = true;
}

function calcEquals() {
  if (calcPrev === null || !calcOperator) return;
  const num = parseFloat(calcBuffer);
  const result = applyOp(calcPrev, calcOperator, num);
  const display = Number.isFinite(result) ? +result.toFixed(10) : 'Error';
  updateCalcDisplay(display);
  calcBuffer = String(display);
  calcPrev = null;
  calcOperator = '';
  calcNewNum = true;
}

function applyOp(a, op, b) {
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return b !== 0 ? a / b : 'Error';
  return b;
}

function calcClear() {
  calcBuffer = '';
  calcOperator = '';
  calcPrev = null;
  calcNewNum = false;
  updateCalcDisplay('0');
}

function calcBackspace() {
  if (calcNewNum) return;
  calcBuffer = calcBuffer.slice(0, -1);
  updateCalcDisplay(calcBuffer || '0');
}

function calcToggleSign() {
  const n = parseFloat(calcBuffer) * -1;
  calcBuffer = String(n);
  updateCalcDisplay(calcBuffer);
}

function calcPercent() {
  const n = parseFloat(calcBuffer) / 100;
  calcBuffer = String(n);
  updateCalcDisplay(calcBuffer);
}

function updateCalcDisplay(val) {
  const el = document.getElementById('basic-calc-display');
  if (!el) return;
  const s = String(val);
  // Format with commas if it's a valid number and not mid-input
  if (!isNaN(s) && !s.endsWith('.') && s !== '-') {
    const n = parseFloat(s);
    el.textContent = n.toLocaleString('en-US', { maximumFractionDigits: 10 });
  } else {
    el.textContent = s;
  }
}

function switchPayoffMode(mode) {
  document.getElementById('payoff-mode-payoff').style.display = mode === 'payoff' ? 'block' : 'none';
  document.getElementById('payoff-mode-rate').style.display   = mode === 'rate'   ? 'block' : 'none';
  document.getElementById('mode-btn-payoff').classList.toggle('active', mode === 'payoff');
  document.getElementById('mode-btn-rate').classList.toggle('active', mode === 'rate');
}

function runRateCalc() {
  const balance  = parseFloat(document.getElementById('rate-balance').value)  || 0;
  const payment  = parseFloat(document.getElementById('rate-payment').value)  || 0;
  const months   = parseInt(document.getElementById('rate-months').value)     || 0;
  const resultEl = document.getElementById('rate-result');

  if (!balance || !payment || !months) { resultEl.style.display = 'none'; return; }

  if (payment * months <= balance) {
    resultEl.innerHTML = '⚠️ Your total payments don\'t cover the balance. Increase payment or months.';
    resultEl.style.display = 'block';
    return;
  }

  // Solve for monthly rate r numerically using Newton-Raphson
  // PMT = P * r * (1+r)^n / ((1+r)^n - 1)  →  solve for r
  let r = 0.01; // initial guess ~12% APR
  for (let i = 0; i < 1000; i++) {
    const pow = Math.pow(1 + r, months);
    const f   = payment - balance * r * pow / (pow - 1);
    const df  = -balance * (pow * (1 + months * r) - pow - months * r * pow) / Math.pow(pow - 1, 2);
    const rNew = r - f / df;
    if (Math.abs(rNew - r) < 1e-9) { r = rNew; break; }
    r = rNew;
    if (r <= 0) { r = 1e-6; }
  }

  const apr        = r * 12 * 100;
  const totalPaid  = payment * months;
  const totalInterest = totalPaid - balance;

  if (apr < 0 || apr > 500 || !isFinite(apr)) {
    resultEl.innerHTML = '⚠️ Couldn\'t estimate a rate with these numbers. Double-check your entries.';
  } else if (apr < 0.01) {
    resultEl.innerHTML = `✅ <strong>Estimated APR: ~0% (interest-free!)</strong><br>Total paid: <strong>$${fmt(totalPaid)}</strong>`;
  } else {
    resultEl.innerHTML = `
      ✅ <strong>Estimated APR: ~${apr.toFixed(2)}%</strong><br>
      Monthly rate: ~${(r * 100).toFixed(3)}%<br>
      Total paid: <strong>$${fmt(totalPaid)}</strong> &nbsp;·&nbsp;
      Total interest: <strong style="color:var(--danger);">$${fmt(totalInterest)}</strong>`;
  }
  resultEl.style.display = 'block';
}

function runPayoffCalc() {
  const balance  = parseFloat(document.getElementById('payoff-balance').value) || 0;
  const apr      = parseFloat(document.getElementById('payoff-apr').value) || 0;
  const payment  = parseFloat(document.getElementById('payoff-payment').value) || 0;
  const resultEl = document.getElementById('payoff-result');
  if (!balance || !payment) { resultEl.style.display = 'none'; return; }

  const months = calcPayoffMonths(balance, apr, payment);
  if (!months) {
    resultEl.innerHTML = '⚠️ Payment is too low to ever pay off this balance.';
  } else {
    const totalPaid = payment * months;
    const interest  = totalPaid - balance;
    const payoffDate = new Date();
    payoffDate.setMonth(payoffDate.getMonth() + months);
    resultEl.innerHTML = `
      <strong>Payoff in ~${months} month${months !== 1 ? 's' : ''}</strong>
      (${payoffDate.toLocaleDateString('en-US', { month:'long', year:'numeric' })})<br>
      Total paid: <strong>$${fmt(totalPaid)}</strong> &nbsp;·&nbsp;
      Interest: <strong style="color:var(--danger);">$${fmt(interest)}</strong>`;
  }
  resultEl.style.display = 'block';
}

function runSavingsCalc() {
  const goal     = parseFloat(document.getElementById('sc-goal').value) || 0;
  const current  = parseFloat(document.getElementById('sc-current').value) || 0;
  const monthly  = parseFloat(document.getElementById('sc-monthly').value) || 0;
  const rate     = parseFloat(document.getElementById('sc-rate').value) || 0;
  const resultEl = document.getElementById('savings-calc-result');
  if (!goal || !monthly) { resultEl.style.display = 'none'; return; }

  const needed = goal - current;
  if (needed <= 0) {
    resultEl.innerHTML = `🎉 You've already reached your goal!`;
    resultEl.style.display = 'block';
    return;
  }

  // With compound interest (monthly)
  const monthlyRate = rate / 100 / 12;
  let balance = current, months = 0;
  while (balance < goal && months < 600) {
    balance = balance * (1 + monthlyRate) + monthly;
    months++;
  }

  if (months >= 600) {
    resultEl.innerHTML = '⚠️ Goal may not be reachable with current monthly savings.';
  } else {
    const totalContributed = monthly * months;
    const interest = balance - current - totalContributed;
    const targetDate = new Date();
    targetDate.setMonth(targetDate.getMonth() + months);
    resultEl.innerHTML = `
      <strong>Reach goal in ~${months} month${months !== 1 ? 's' : ''}</strong>
      (${targetDate.toLocaleDateString('en-US', { month:'long', year:'numeric' })})<br>
      You'll contribute: <strong>$${fmt(totalContributed)}</strong>
      ${rate > 0 ? ` &nbsp;·&nbsp; Interest earned: <strong style="color:var(--sage-dk);">$${fmt(Math.max(0, interest))}</strong>` : ''}`;
  }
  resultEl.style.display = 'block';
}


// ═══════════════════════════════════════════════════════════════
// DARK MODE
// ═══════════════════════════════════════════════════════════════
function toggleDarkMode() {
  const isDark = document.body.classList.toggle('dark-mode');
  localStorage.setItem('nsl-dark-mode', isDark ? '1' : '0');
  document.getElementById('dark-mode-btn').textContent = isDark ? '☀️ Light Mode' : '🌙 Dark Mode';
}

(function initDarkMode() {
  if (localStorage.getItem('nsl-dark-mode') === '1') {
    document.body.classList.add('dark-mode');
    const btn = document.getElementById('dark-mode-btn');
    if (btn) btn.textContent = '☀️ Light Mode';
  }
})();


// ═══════════════════════════════════════════════════════════════
// GLOBAL SEARCH
// ═══════════════════════════════════════════════════════════════
function runGlobalSearch(query) {
  const q     = query.trim().toLowerCase();
  const box   = document.getElementById('global-search-results');
  if (!q) { box.style.display = 'none'; return; }

  const results = [];

  // Bills
  state.bills.filter(b => {
    const hay = `${b.name} ${b.amount} ${b.due_date || ''} ${b.category || ''}`.toLowerCase();
    return hay.includes(q);
  }).slice(0, 5).forEach(b => results.push({
    section: 'Bills',
    icon: b.is_paid ? '✅' : '🧾',
    name: b.name,
    meta: `Due ${b.due_date ? fmtDate(b.due_date) : '—'} · ${b.is_paid ? 'Paid' : 'Unpaid'}`,
    amount: `$${fmt(b.amount)}`,
    action: () => { switchTab('bills'); }
  }));

  // Debt
  state.debtAccounts.filter(d => {
    const hay = `${d.name} ${d.balance} ${d.account_type}`.toLowerCase();
    return hay.includes(q);
  }).slice(0, 4).forEach(d => results.push({
    section: 'Debt',
    icon: d.is_promo ? '🏷️' : d.account_type === 'loan' ? '🏦' : '💳',
    name: d.name,
    meta: `${d.account_type === 'loan' ? 'Loan' : d.is_promo ? 'Promo' : 'Credit Card'} · ${d.apr}% APR`,
    amount: `$${fmt(d.balance)}`,
    action: () => { switchTab('debt'); }
  }));

  // Subscriptions
  state.subscriptions.filter(s => {
    const hay = `${s.name} ${s.amount}`.toLowerCase();
    return hay.includes(q);
  }).slice(0, 4).forEach(s => results.push({
    section: 'Subscriptions',
    icon: '🔁',
    name: s.name,
    meta: cycleLabel(s) + (s.next_due_date ? ` · Next: ${fmtDate(s.next_due_date)}` : ''),
    amount: `$${fmt(s.amount)}`,
    action: () => { switchTab('subscriptions'); }
  }));

  // Savings
  state.savingsGoals.filter(g => g.name.toLowerCase().includes(q)).slice(0, 3).forEach(g => results.push({
    section: 'Savings',
    icon: '🎯',
    name: g.name,
    meta: `Saved $${fmt(g.current_amount)} of $${fmt(g.target_amount)}`,
    amount: `${Math.round((g.current_amount / g.target_amount) * 100) || 0}%`,
    action: () => { switchTab('savings'); }
  }));

  if (!results.length) {
    box.innerHTML = `<div class="search-no-results">No results for "<strong>${escHtml(query)}</strong>"</div>`;
    box.style.display = 'block';
    return;
  }

  let html = '';
  let lastSection = '';
  results.forEach(r => {
    if (r.section !== lastSection) {
      html += `<div class="search-result-section">${r.section}</div>`;
      lastSection = r.section;
    }
    html += `<div class="search-result-item" onclick="this.closest('.global-search-results').style.display='none'; document.getElementById('global-search').value=''; (${r.action.toString()})()">
      <span class="search-result-icon">${r.icon}</span>
      <div>
        <div class="search-result-name">${escHtml(r.name)}</div>
        <div class="search-result-meta">${r.meta}</div>
      </div>
      <span class="search-result-amount">${r.amount}</span>
    </div>`;
  });

  box.innerHTML = html;
  box.style.display = 'block';
}

// Close search results when clicking outside
document.addEventListener('click', e => {
  const wrap = document.getElementById('global-search')?.closest('.global-search-wrap');
  if (wrap && !wrap.contains(e.target)) {
    const box = document.getElementById('global-search-results');
    if (box) box.style.display = 'none';
  }
});


// ═══════════════════════════════════════════════════════════════
// CONFETTI CELEBRATION
// ═══════════════════════════════════════════════════════════════
function fireConfetti() {
  if (typeof confetti === 'undefined') return;
  const end = Date.now() + 2200;
  const colors = ['#7BA68C', '#D4A853', '#3D6B54', '#F5E8C8', '#2C4A7C'];
  (function frame() {
    confetti({ particleCount: 6, angle: 60,  spread: 55, origin: { x: 0 }, colors });
    confetti({ particleCount: 6, angle: 120, spread: 55, origin: { x: 1 }, colors });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function showCelebration(message) {
  fireConfetti();
  // Brief toast overlay
  const toast = document.createElement('div');
  toast.className = 'celebration-toast';
  toast.innerHTML = `<span class="celebration-emoji">🎉</span><span>${message}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 50);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 3200);
}

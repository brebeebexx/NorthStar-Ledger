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
  snapshots:          [...(APP_DATA.snapshots || [])],
  today:              APP_DATA.today,
};

// Single shared month for all tabs (planner, dashboard, debt, savings, subs, calendar)
// Restore last-viewed month from localStorage so a page refresh stays on the same month
const _savedMonth = localStorage.getItem('nsl_plannerMonth');
let plannerYear  = _savedMonth ? parseInt(_savedMonth.slice(0, 4))  : new Date().getFullYear();
let plannerMonth = _savedMonth ? parseInt(_savedMonth.slice(5, 7)) - 1 : new Date().getMonth();
// calYear/calMonth are now aliases so calendar uses the same state
Object.defineProperty(window, 'calYear',  { get: () => plannerYear,  set: v => { plannerYear  = v; } });
Object.defineProperty(window, 'calMonth', { get: () => plannerMonth, set: v => { plannerMonth = v; } });

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

  // Auto-snapshot: silently record this month's debt + savings if not yet snapped
  autoSnapshot();
});

// ── Snapshot helpers ──────────────────────────────────────────────────────────
function calcSnapshotTotals() {
  const totalDebt    = state.debtAccounts
    .filter(d => (d.status || 'balance') === 'balance')
    .reduce((s, d) => s + (d.balance || 0), 0);
  const totalSavings = state.savingsGoals
    .reduce((s, g) => s + (g.current_amount || 0), 0);
  return { totalDebt, totalSavings };
}

async function autoSnapshot() {
  const month = state.today.slice(0, 7);
  const already = state.snapshots.find(s => s.month === month);
  if (already) return; // already snapped this month
  await takeSnapshot(true); // silent = no alert
}

async function takeSnapshot(silent = false) {
  const month = state.today.slice(0, 7);
  const { totalDebt, totalSavings } = calcSnapshotTotals();
  const data = await api('POST', '/api/snapshots', {
    month,
    total_debt:    totalDebt,
    total_savings: totalSavings,
  });
  // Upsert into local state
  const idx = state.snapshots.findIndex(s => s.month === month);
  if (idx > -1) state.snapshots[idx] = data;
  else          state.snapshots.push(data);
  state.snapshots.sort((a, b) => a.month.localeCompare(b.month));
  if (!silent) {
    const tab = document.querySelector('.tab-section.active')?.id?.replace('tab-','');
    if (tab === 'insights') renderInsights();
    alert(`📸 Snapshot saved for ${month}!\nDebt: $${fmt(totalDebt)} · Savings: $${fmt(totalSavings)}`);
  }
}


// ─── Tab Switching ────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(a => a.classList.remove('active'));

  const section = document.getElementById('tab-' + tab);
  if (section) section.classList.add('active');

  const navItem = document.querySelector(`[data-tab="${tab}"]`);
  if (navItem) navItem.classList.add('active');

  // Show/hide shared month nav and sync label
  updateSharedNavVisibility(tab);
  syncAllMonthLabels();

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
  if (tab === 'forecast')      renderForecast();
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
  const refDate   = viewRefDate();
  const thisMonth = `${plannerYear}-${String(plannerMonth + 1).padStart(2, '0')}`;
  const today     = new Date(refDate + 'T00:00:00');

  // Find current paycheck (most recent on or before the reference date)
  const pastPaychecks = state.paychecks
    .filter(p => p.date <= refDate)
    .sort((a, b) => b.date.localeCompare(a.date));
  const currentPaycheck = pastPaychecks[0] || null;

  // Stat cards
  const totalSaved = state.savingsGoals.reduce((s, g) => s + g.current_amount, 0);

  // Selected Month Projection: unpaid bills vs projected month-end balance
  const thisMonthPaychecks = state.paychecks
    .filter(p => p.date && p.date.slice(0, 7) === thisMonth)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Unpaid bills for selected month
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

  // Upcoming bills — unpaid bills for the selected month, sorted by due date
  const upcoming = state.bills
    .filter(b => {
      if (b.is_paid || b.is_postponed || !b.due_date) return false;
      // Match the selected month (bills can be stored by due_date or by month field)
      const billMonth = (b.month || b.due_date.slice(0, 7));
      return billMonth === thisMonth;
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 8);

  const upEl = document.getElementById('dashboard-upcoming-bills');
  if (upEl) {
    if (upcoming.length) {
      upEl.innerHTML = upcoming.map(b => {
        const daysLeft = Math.ceil((new Date(b.due_date + 'T00:00:00') - today) / 86400000);
        const dueColor = daysLeft < 0 ? 'var(--danger)' : daysLeft <= 3 ? 'var(--warning)' : 'var(--text-md)';
        const dueLabel = daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : daysLeft === 0 ? 'Due today' : `Due in ${daysLeft}d`;
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.6rem 1.2rem;border-bottom:1px solid var(--border);font-size:0.875rem;">
          <span>${escHtml(b.name)}</span>
          <span style="display:flex;gap:1rem;align-items:center;">
            <span style="font-size:0.75rem;color:${dueColor};font-weight:600;">${dueLabel}</span>
            <span style="font-weight:600;">$${fmt(b.amount)}</span>
          </span>
        </div>`;
      }).join('');
    } else {
      upEl.innerHTML = '<p class="empty-state">No unpaid bills for this month.</p>';
    }
  }

  // Savings goals summary with Needed/Month + Needs Attention warning
  const savEl = document.getElementById('dashboard-savings');
  if (savEl) {
    if (state.savingsGoals.length) {
      const todayStr = state.today;
      const needsAttention = state.savingsGoals.filter(g =>
        g.target_date && g.target_date < todayStr && g.current_amount < g.target_amount
      );

      let warningBanner = '';
      if (needsAttention.length) {
        warningBanner = `
          <div style="display:flex;align-items:center;gap:0.6rem;padding:0.65rem 1.2rem;background:#fffbeb;border-bottom:1px solid #fcd34d;font-size:0.8rem;color:#b45309;">
            <span style="font-size:1rem;">⚠️</span>
            <span><strong>${needsAttention.length} goal${needsAttention.length > 1 ? 's' : ''}</strong> past target date &mdash;
              <button class="link-btn" style="color:#b45309;font-weight:600;" onclick="switchTab('savings')">Review →</button>
            </span>
          </div>`;
      }

      const goalRows = state.savingsGoals.slice(0, 3).map(g => {
        const pct = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
        const remaining = Math.max(0, g.target_amount - g.current_amount);
        const isAlert = g.target_date && g.target_date < todayStr && remaining > 0;
        const isComplete = remaining <= 0;
        let neededHtml = '';
        if (isAlert) {
          neededHtml = `<div style="font-size:0.73rem;color:#b45309;font-weight:600;margin-top:0.15rem;">⚠️ Target date passed — $${fmt(remaining)} remaining</div>`;
        } else if (isComplete) {
          neededHtml = `<div style="font-size:0.73rem;color:var(--sage-dk);font-weight:600;margin-top:0.15rem;">🎉 Goal reached!</div>`;
        } else if (g.target_date && remaining > 0) {
          const target = new Date(g.target_date + 'T00:00:00');
          const msLeft = target - today;
          const monthsLeft = Math.max(1, Math.ceil(msLeft / (1000 * 60 * 60 * 24 * 30.44)));
          const perMonth = remaining / monthsLeft;
          neededHtml = `<div style="font-size:0.73rem;color:var(--sage-dk);font-weight:600;margin-top:0.15rem;">
            $${fmt(perMonth)}/mo needed &mdash; ${monthsLeft} month${monthsLeft !== 1 ? 's' : ''} left</div>`;
        }
        const cardBg = isAlert ? 'background:#fffbeb;' : isComplete ? 'background:#f0fdf4;' : '';
        const barColor = isAlert ? 'background:linear-gradient(90deg,#d97706,#fbbf24);' : isComplete ? 'background:linear-gradient(90deg,#16a34a,#4ade80);' : '';
        return `<div style="padding:0.7rem 1.2rem;border-bottom:1px solid var(--border);${cardBg}">
          <div style="display:flex;justify-content:space-between;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;">
            <span>${escHtml(g.name)}</span><span>${pct}%</span>
          </div>
          <div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${pct}%;${barColor}"></div></div>
          <div style="font-size:0.73rem;color:var(--text-lt);margin-top:0.2rem;">$${fmt(g.current_amount)} of $${fmt(g.target_amount)}</div>
          ${neededHtml}
        </div>`;
      }).join('');

      savEl.innerHTML = warningBanner + goalRows;
    } else {
      savEl.innerHTML = `<p class="empty-state">No savings goals yet. <button class="link-btn" onclick="switchTab('savings')">Add one →</button></p>`;
    }
  }
}


// ═══════════════════════════════════════════════════════════════
// PLANNER
// ═══════════════════════════════════════════════════════════════
// Sync the single shared month label
function syncAllMonthLabels() {
  const label = new Date(plannerYear, plannerMonth, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const el = document.getElementById('shared-month-label');
  if (el) el.textContent = label;
}

// Tabs that show the shared month nav bar
const MONTH_NAV_TABS = new Set(['dashboard','planner','savings','debt','subscriptions','calendar']);
// Forecast uses its own horizon controls — no shared month nav needed

function updateSharedNavVisibility(tab) {
  const bar = document.getElementById('shared-month-nav-bar');
  if (!bar) return;
  bar.style.display = MONTH_NAV_TABS.has(tab) ? 'flex' : 'none';
}

function _reRenderActiveTab() {
  const tab = document.querySelector('.tab-section.active')?.id?.replace('tab-', '');
  if (tab === 'planner') {
    renderPlanner();
    if (document.getElementById('recurring-view')?.style.display !== 'none') renderRecurringInline();
  } else if (tab === 'dashboard')     renderDashboard();
  else if (tab === 'savings')         renderSavings();
  else if (tab === 'debt')            renderDebt();
  else if (tab === 'subscriptions')   renderSubscriptions();
  else if (tab === 'calendar')        renderCalendar();
}

function _saveMonth() {
  localStorage.setItem('nsl_plannerMonth', `${plannerYear}-${String(plannerMonth + 1).padStart(2, '0')}`);
}
function globalPrevMonth() {
  plannerMonth--;
  if (plannerMonth < 0) { plannerMonth = 11; plannerYear--; }
  _saveMonth();
  syncAllMonthLabels();
  _reRenderActiveTab();
}
function globalNextMonth() {
  plannerMonth++;
  if (plannerMonth > 11) { plannerMonth = 0; plannerYear++; }
  _saveMonth();
  syncAllMonthLabels();
  _reRenderActiveTab();
}

// Keep old names as aliases so nothing else breaks
function plannerPrevMonth() { globalPrevMonth(); }
function plannerNextMonth() { globalNextMonth(); }
function prevMonth()        { globalPrevMonth(); }
function nextMonth()        { globalNextMonth(); }

// Reference date for the currently viewed month:
//   current month  → today's actual date
//   past month     → last day of that month (so overdue = unpaid by month-end)
//   future month   → first day of that month (nothing is overdue yet)
function viewRefDate() {
  const todayMonth = state.today.slice(0, 7);
  const selMonth   = `${plannerYear}-${String(plannerMonth + 1).padStart(2, '0')}`;
  if (selMonth === todayMonth) return state.today;
  if (selMonth < todayMonth) {
    // Last day of selected past month
    const d = new Date(plannerYear, plannerMonth + 1, 0);
    return d.toISOString().slice(0, 10);
  }
  // First day of selected future month
  return `${selMonth}-01`;
}

// Calculate the net ending balance for a given year/month (0-indexed month).
// Mirrors the planner's running-balance logic: income - paid - pending + adjustments.
function calcMonthEndBalance(year, month) {
  const mStr = `${year}-${String(month + 1).padStart(2, '0')}`;
  const checks = state.paychecks.filter(p => p.date && p.date.slice(0, 7) === mStr);
  let bal = 0;
  for (const p of checks) {
    const bills     = state.bills.filter(b => b.paycheck_id === p.id);
    const paidOut   = bills.filter(b => b.is_paid    && !b.is_postponed).reduce((s, b) => s + b.amount, 0);
    const pendingOut= bills.filter(b => !b.is_paid   && !b.is_postponed).reduce((s, b) => s + b.amount, 0);
    const adjs      = state.balanceAdjustments.filter(a => a.paycheck_id === p.id);
    const adjTotal  = adjs.reduce((s, a) => s + (a.adjustment_amount || 0), 0);
    bal += p.amount - paidOut - pendingOut + adjTotal;
  }
  return bal;
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
  const refDate = viewRefDate();
  const pastDueBills = state.bills
    .filter(b => !b.is_paid && !b.is_postponed && b.due_date && b.due_date < refDate)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  let pastDueHtml = '';
  if (pastDueBills.length) {
    const rows = pastDueBills.map(b => {
      const daysOverdue = Math.floor((new Date(refDate + 'T00:00:00') - new Date(b.due_date + 'T00:00:00')) / 86400000);
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

  // ── Promotions Ending Widget (within 60 days of view reference) ──
  const sixtyDaysOut = new Date(refDate + 'T00:00:00');
  sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
  const sixtyStr = sixtyDaysOut.toISOString().slice(0, 10);

  const promoAccounts = state.debtAccounts
    .filter(d => d.is_promo && d.promo_end_date && d.promo_end_date >= refDate && d.promo_end_date <= sixtyStr)
    .sort((a, b) => a.promo_end_date.localeCompare(b.promo_end_date));

  let promoHtml = '';
  if (promoAccounts.length) {
    const rows = promoAccounts.map(d => {
      const daysLeft = Math.ceil((new Date(d.promo_end_date + 'T00:00:00') - new Date(refDate + 'T00:00:00')) / 86400000);
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

  // ── Carry previous month's ending balance into this month ────────────────
  const prevMonth     = plannerMonth === 0 ? 11 : plannerMonth - 1;
  const prevYear      = plannerMonth === 0 ? plannerYear - 1 : plannerYear;
  const prevMonthName = new Date(prevYear, prevMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const carryover     = calcMonthEndBalance(prevYear, prevMonth);

  if (carryover !== 0 && sorted.length) {
    const carryClass = carryover >= 0 ? 'carry-positive' : 'carry-negative';
    const sign       = carryover >= 0 ? '+' : '';
    container.innerHTML += `
    <div class="carryover-banner ${carryClass}">
      <span class="carryover-label">↩ Carried from ${prevMonthName}</span>
      <span class="carryover-amount">${sign}$${fmt(carryover)}</span>
    </div>`;
  }

  // Build buckets with a running balance that carries across all paychecks
  let runningBalance = carryover;
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
    // Sort groups: 0 = paid (top), 1 = pending (middle), 2 = postponed (bottom)
    const entries = [
      ...bills.map(b => ({
        type:      'bill',
        data:      b,
        sortDate:  b.is_paid
          ? (b.paid_date || b.due_date || '9999-12-31')
          : (b.due_date  || b.planned_pay_date || '9999-12-31'),
        sortGroup: b.is_paid ? 0 : b.is_postponed ? 2 : 1,
      })),
      ...adjs.map(a => ({
        type:      'adj',
        data:      a,
        sortDate:  a.adjustment_date || '9999-12-31',
        sortGroup: 1,  // reconcile entries sort alongside pending bills
      })),
    ];

    // Sort: paid first (group 0), then pending (group 1), postponed last (group 2).
    // Within each group, sort by date ascending.
    entries.sort((a, b) => {
      if (a.sortGroup !== b.sortGroup) return a.sortGroup - b.sortGroup;
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
          ${p.income_type === 'bonus' ? '🎁' : '💵'} ${fmtDate(p.date)}
          ${p.income_type === 'bonus' ? '<span class="badge-bonus">BONUS</span>' : ''}
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
            ${isFirst && carryover !== 0 ? `Carried in: <strong style="color:${carryover >= 0 ? 'var(--sage-dk)' : 'var(--danger)'};">${carryover >= 0 ? '+' : ''}$${fmt(carryover)}</strong> — ` : ''}This check: <strong>+$${fmt(income)}</strong> — Paid: <strong>$${fmt(paidOut)}</strong> — Pending: <strong>$${fmt(pendingOut)}</strong>
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

// ── Import Recurring Bills for current planner month ─────────────────────────
function openImportRecurring() {
  const monthStr   = `${plannerYear}-${String(plannerMonth + 1).padStart(2,'0')}`;
  const monthLabel = new Date(plannerYear, plannerMonth, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const dueThisMonth = state.subscriptions
    .map(s => ({ sub: s, dueDate: subDueInMonth(s, plannerYear, plannerMonth) }))
    .filter(x => x.dueDate !== null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // Skip ones already imported this month (match by name)
  const existingNames = new Set(
    state.bills
      .filter(b => b.due_date && b.due_date.slice(0,7) === monthStr)
      .map(b => b.name.toLowerCase().trim())
  );
  const toAdd = dueThisMonth.filter(x => !existingNames.has(x.sub.name.toLowerCase().trim()));

  const el  = document.getElementById('import-recurring-body');
  const btn = document.getElementById('import-recurring-confirm');
  if (!el || !btn) return;

  if (!dueThisMonth.length) {
    el.innerHTML = `<p style="color:var(--text-lt);padding:0.5rem 0;">No subscriptions are due in ${monthLabel}.</p>`;
    btn.style.display = 'none';
  } else if (!toAdd.length) {
    el.innerHTML = `<p style="color:var(--sage-dk);padding:0.5rem 0;">✅ All subscriptions due in ${monthLabel} have already been added.</p>`;
    btn.style.display = 'none';
  } else {
    const total = toAdd.reduce((s, x) => s + x.sub.amount, 0);
    el.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-lt);margin:0 0 0.75rem;">
        These will be added as <strong>unassigned bills</strong> for <strong>${monthLabel}</strong>. You can then assign them to a paycheck as normal.
      </p>
      <table style="width:100%;font-size:0.85rem;border-collapse:collapse;">
        <thead><tr style="border-bottom:2px solid var(--border);">
          <th style="text-align:left;padding:0.4rem 0.5rem;">Name</th>
          <th style="text-align:left;padding:0.4rem 0.5rem;">Due Date</th>
          <th style="text-align:right;padding:0.4rem 0.5rem;">Amount</th>
        </tr></thead>
        <tbody>${toAdd.map(x => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:0.4rem 0.5rem;">🔁 ${escHtml(x.sub.name)}</td>
            <td style="padding:0.4rem 0.5rem;">${fmtDate(x.dueDate)}</td>
            <td style="padding:0.4rem 0.5rem;text-align:right;">$${fmt(x.sub.amount)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr style="border-top:2px solid var(--border);">
          <td colspan="2" style="padding:0.5rem 0.5rem;font-weight:700;">Total</td>
          <td style="padding:0.5rem 0.5rem;text-align:right;font-weight:700;color:var(--danger);">-$${fmt(total)}</td>
        </tr></tfoot>
      </table>`;
    btn.style.display = '';
    btn.onclick = () => confirmImportRecurring(toAdd);
  }
  openModal('modal-import-recurring');
}

async function confirmImportRecurring(toAdd) {
  const monthStr = `${plannerYear}-${String(plannerMonth + 1).padStart(2,'0')}`;

  // Paychecks for this month, sorted oldest → newest
  const monthChecks = [...state.paychecks]
    .filter(p => p.date && p.date.slice(0,7) === monthStr)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const { sub, dueDate } of toAdd) {
    // Auto-assign: find the most recent paycheck on or before the due date.
    // If none exists before due date, use the first paycheck of the month.
    let assigned = null;
    if (monthChecks.length) {
      const before = monthChecks.filter(p => p.date <= dueDate);
      assigned = before.length ? before[before.length - 1] : monthChecks[0];
    }

    const data = await api('POST', '/api/bills', {
      name:         sub.name,
      amount:       sub.amount,
      due_date:     dueDate,
      month:        monthStr,
      paycheck_id:  assigned ? assigned.id : null,
      is_recurring: 1,
      category:     'subscription',
      notes:        'Auto-imported from Subscriptions',
    });
    state.bills.push(data);
  }
  closeModal('modal-import-recurring');
  populatePaycheckDropdowns();
  renderPlanner();
  renderDashboard();
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

  const paidDateHtml = isPaid
    ? `<div class="bill-paid-date">Paid ${b.paid_date ? fmtDate(b.paid_date) : '—'} <button class="paid-date-edit-btn" onclick="openEditPaidDate(${b.id})" title="Edit paid date">✏️</button></div>`
    : '';

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

  const today = state.today;

  // Classify each goal
  const complete      = state.savingsGoals.filter(g => g.current_amount >= g.target_amount);
  const needsAttention= state.savingsGoals.filter(g =>
    g.current_amount < g.target_amount && g.target_date && g.target_date < today
  );
  const inProgress    = state.savingsGoals.filter(g =>
    g.current_amount < g.target_amount && (!g.target_date || g.target_date >= today)
  );

  function goalCard(g, status) {
    const pct        = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
    const remaining  = Math.max(0, g.target_amount - g.current_amount);
    const isComplete = status === 'complete';
    const isAlert    = status === 'attention';

    let dateHtml = '';
    if (g.target_date) {
      if (isAlert) {
        dateHtml = `<div class="goal-date goal-date-overdue">⚠️ Target was ${fmtDate(g.target_date)} — please update</div>`;
      } else if (isComplete) {
        dateHtml = `<div class="goal-date">🗓 Target was ${fmtDate(g.target_date)}</div>`;
      } else {
        const msLeft     = new Date(g.target_date + 'T00:00:00') - new Date(today + 'T00:00:00');
        const monthsLeft = Math.max(1, Math.ceil(msLeft / (1000 * 60 * 60 * 24 * 30.44)));
        const perMonth   = remaining / monthsLeft;
        dateHtml = `<div class="goal-date">🗓 Target: ${fmtDate(g.target_date)} &mdash; <strong>$${fmt(perMonth)}/mo needed</strong></div>`;
      }
    }

    const barColor = isAlert ? '#e85d5d' : isComplete ? 'var(--brand)' : 'var(--sage-dk)';

    return `
    <div class="goal-card ${isAlert ? 'goal-card-alert' : isComplete ? 'goal-card-complete' : ''}">
      <div class="goal-card-header">
        <div class="goal-card-name">${isComplete ? '✅' : isAlert ? '⚠️' : '🎯'} ${escHtml(g.name)}</div>
        <div class="goal-card-actions">
          <button onclick="editGoal(${g.id})" title="Edit">✏️</button>
          <button onclick="deleteGoal(${g.id})" title="Delete">🗑️</button>
        </div>
      </div>
      <div class="goal-amounts">
        <span>Saved: <strong>$${fmt(g.current_amount)}</strong></span>
        <span>Goal: <strong>$${fmt(g.target_amount)}</strong></span>
      </div>
      <div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${pct}%;background:${barColor};"></div></div>
      <div class="goal-pct">${pct}% complete</div>
      ${dateHtml}
    </div>`;
  }

  function section(title, goals, status, extraClass = '') {
    if (!goals.length) return '';
    return `
    <div class="savings-section ${extraClass}">
      <div class="savings-section-header">${title}</div>
      <div class="savings-grid">${goals.map(g => goalCard(g, status)).join('')}</div>
    </div>`;
  }

  container.className = ''; // reset — sections handle their own grid
  container.innerHTML =
    section('🎯 In Progress', inProgress, 'active') +
    section('⚠️ Needs Attention — Target Date Passed', needsAttention, 'attention', 'savings-section-alert') +
    section('✅ Complete', complete, 'complete', 'savings-section-complete');
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

  // Sort by next due date (nulls last), then name
  const sorted = [...state.subscriptions].sort((a, b) => {
    if (!a.next_due_date && !b.next_due_date) return a.name.localeCompare(b.name);
    if (!a.next_due_date) return 1;
    if (!b.next_due_date) return -1;
    return a.next_due_date.localeCompare(b.next_due_date) || a.name.localeCompare(b.name);
  });

  const monthly = calcMonthlySubTotal();
  const annual  = monthly * 12;

  const toMonthly = s => subToMonthly(s);

  const rows = sorted.map(s => {
    const mo = toMonthly(s);
    return `<tr id="sub-row-${s.id}">
      <td><strong>${escHtml(s.name)}</strong></td>
      <td>$${fmt(s.amount)}</td>
      <td>${cycleLabel(s)}</td>
      <td>${s.next_due_date ? fmtDate(s.next_due_date) : '<span class="dt-empty">—</span>'}</td>
      <td>$${fmt(mo)}/mo</td>
      <td class="dt-actions">
        <button class="bill-btn edit" onclick="openSubEditModal(${s.id})">Edit</button>
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

// ── Subscription due-date helper ──────────────────────────────────────────────
// Returns the due date string (YYYY-MM-DD) if sub falls in targetYear/targetMonth, else null.
function subDueInMonth(sub, targetYear, targetMonth) {
  if (!sub.next_due_date) return null;
  const next = new Date(sub.next_due_date + 'T00:00:00');
  const n    = sub.interval_count || 1;
  const unit = sub.interval_unit  || 'month';
  const ny   = next.getFullYear();
  const nm   = next.getMonth(); // 0-indexed

  if (unit === 'month' || unit === 'year') {
    const cycleMonths = unit === 'year' ? n * 12 : n;
    const offset = (targetYear - ny) * 12 + (targetMonth - nm);
    if (offset % cycleMonths !== 0) return null;
    // Clamp day to end of target month
    const maxDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    const day    = Math.min(next.getDate(), maxDay);
    return `${targetYear}-${String(targetMonth + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  if (unit === 'week') {
    const daysPerCycle = n * 7;
    const targetFirst  = new Date(targetYear, targetMonth, 1);
    const targetLast   = new Date(targetYear, targetMonth + 1, 0);
    const daysToFirst  = Math.round((targetFirst - next) / 86400000);
    // Find k such that next + k*cycle lands in target month
    const kBase = daysToFirst >= 0
      ? Math.ceil(daysToFirst / daysPerCycle)
      : -Math.ceil(Math.abs(daysToFirst) / daysPerCycle);
    for (const k of [kBase - 1, kBase, kBase + 1]) {
      const d = new Date(next.getTime() + k * daysPerCycle * 86400000);
      if (d >= targetFirst && d <= targetLast) return d.toISOString().slice(0, 10);
    }
    return null;
  }
  return null;
}

// Shared helper — converts any subscription to its monthly cost equivalent
function subToMonthly(s) {
  const n = s.interval_count || 1;
  if (s.interval_unit === 'month') return s.amount / n;
  if (s.interval_unit === 'year')  return s.amount / (n * 12);
  if (s.interval_unit === 'week')  return (s.amount * 52) / (n * 12);
  return s.amount;
}

function calcMonthlySubTotal() {
  return state.subscriptions.reduce((sum, s) => sum + subToMonthly(s), 0);
}

function cycleLabel(s) {
  const n = s.interval_count || 1;
  if (n === 1 && s.interval_unit === 'week')  return 'Weekly';
  if (n === 2 && s.interval_unit === 'week')  return 'Biweekly';
  if (n === 1 && s.interval_unit === 'month') return 'Monthly';
  if (n === 3 && s.interval_unit === 'month') return 'Quarterly';
  if (n === 6 && s.interval_unit === 'month') return 'Every 6 Months';
  if (n === 1 && s.interval_unit === 'year')  return 'Yearly';
  return `Every ${n} ${s.interval_unit}${n !== 1 ? 's' : ''}`;
}


// ═══════════════════════════════════════════════════════════════
// FORECAST
// ═══════════════════════════════════════════════════════════════
let _fcHorizon   = 6;          // months to project
let _fcPurchases = [];         // [{id, name, amount, month}]  (month = 'YYYY-MM')
let _fcCharts    = {};         // Chart.js instances keyed by canvas id

function setForecastHorizon(n) {
  _fcHorizon = n;
  document.querySelectorAll('.fc-chip').forEach(c => c.classList.toggle('active', +c.dataset.months === n));
  renderForecast();
}

function resetForecastOverrides() {
  document.getElementById('fc-start-balance').value    = '';
  document.getElementById('fc-income-override').value  = '';
  document.getElementById('fc-expense-override').value = '';
  renderForecast();
}

// ── Smart data detection ──────────────────────────────────────────────────────

function fcDetectMonthlyIncome() {
  // Average the last 3 months of PAYCHECK income only (exclude bonus/extra)
  const byMonth = {};
  state.paychecks.forEach(p => {
    if (!p.date) return;
    if (p.income_type === 'bonus') return;   // exclude Extra/Bonus from forecast
    const mo = p.date.slice(0, 7);
    byMonth[mo] = (byMonth[mo] || 0) + p.amount;
  });
  const sorted = Object.entries(byMonth).sort((a,b) => b[0].localeCompare(a[0]));
  if (!sorted.length) return 0;
  const sample = sorted.slice(0, Math.min(3, sorted.length)).map(([,v]) => v);
  return sample.reduce((s,v) => s + v, 0) / sample.length;
}

function fcDetectMonthlyExpenses() {
  // Average the last 3 months of bill totals (by due_date month) + monthly subscription cost
  const byMonth = {};
  state.bills.forEach(b => {
    if (!b.due_date) return;
    const mo = b.due_date.slice(0, 7);
    byMonth[mo] = (byMonth[mo] || 0) + b.amount;
  });
  const sorted = Object.entries(byMonth).sort((a,b) => b[0].localeCompare(a[0]));
  const billsAvg = sorted.length
    ? sorted.slice(0, Math.min(3, sorted.length)).map(([,v]) => v).reduce((s,v) => s+v, 0)
      / Math.min(3, sorted.length)
    : 0;
  return billsAvg + calcMonthlySubTotal();
}

function fcDetectStartBalance() {
  // Best estimate = this month's projected net (income - ALL bills, paid or not)
  // This is exactly what the planner calculates as "month-end balance."
  // It represents roughly what you'll have at the end of the current month.
  const today   = state.today;
  const mo      = today.slice(0, 7);
  const income  = state.paychecks
    .filter(p => p.date && p.date.slice(0,7) === mo && p.income_type !== 'bonus')
    .reduce((s,p) => s + p.amount, 0);
  const expenses = state.bills
    .filter(b => b.due_date && b.due_date.slice(0,7) === mo && !b.is_postponed)
    .reduce((s,b) => s + b.amount, 0);
  return income - expenses;  // can be negative — that's useful info
}

// ── Planned purchases helpers ─────────────────────────────────────────────────
function addFcPurchase() {
  const today = new Date(state.today + 'T00:00:00');
  const next  = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const mo    = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}`;
  const id    = Date.now();
  _fcPurchases.push({ id, name: '', amount: 0, month: mo, type: 'lump' });
  renderForecast();
}
function removeFcPurchase(id) {
  _fcPurchases = _fcPurchases.filter(p => p.id !== id);
  renderForecast();
}
function setFcPurchaseType(id, type) {
  const p = _fcPurchases.find(x => x.id === id);
  if (p) p.type = type;
  renderForecast();
}
function updateFcPurchase(id, field, value) {
  const p = _fcPurchases.find(x => x.id === id);
  if (!p) return;
  p[field] = field === 'amount' ? parseFloat(value) || 0 : value;
  // Auto-recalculate on month change (definitive picker action); name/amount needs Calculate btn
  if (field === 'month') renderForecast();
}

function renderFcPurchases(ctx) {
  // ctx = { monthlyIncome, monthlyExpenses, startBalance }
  const el = document.getElementById('fc-purchases-list');
  if (!el) return;

  if (!_fcPurchases.length) {
    el.innerHTML = `<p style="color:var(--text-lt);font-size:0.83rem;padding:0.4rem 0;">No purchases added yet. Hit <strong>+ Add</strong> to plan a big expense or a new financed payment.</p>`;
    return;
  }

  const todayDate = new Date(state.today + 'T00:00:00');

  el.innerHTML = _fcPurchases.map(p => {
    const isFinanced = p.type === 'financed';

    // ── Analysis block ──────────────────────────────────────────
    let analysisHtml = '';
    if (ctx && p.amount > 0) {
      if (isFinanced) {
        // How does this monthly payment change the budget?
        const newMonthlyExp = ctx.monthlyExpenses + p.amount;
        const newNet        = ctx.monthlyIncome - newMonthlyExp;
        const ratio         = ctx.monthlyIncome > 0 ? newNet / ctx.monthlyIncome : -1;
        let sColor, sIcon, sLabel;
        if (ratio >= 0.20)      { sColor = 'var(--sage-dk)'; sIcon = '✅'; sLabel = 'Manageable'; }
        else if (ratio >= 0.05) { sColor = '#b45309';        sIcon = '⚠️'; sLabel = 'Tight'; }
        else                    { sColor = 'var(--danger)';  sIcon = '❌'; sLabel = 'Risky'; }
        const startLabel = p.month
          ? p.month.slice(5,7) + '/' + p.month.slice(0,4)
          : 'selected month';
        analysisHtml = `
          <div class="fc-purchase-analysis">
            <div class="fc-pa-row"><span class="fc-pa-label">Monthly expenses:</span>
              <span>$${fmt(ctx.monthlyExpenses)} → <strong>$${fmt(newMonthlyExp)}</strong> (+$${fmt(p.amount)}/mo)</span></div>
            <div class="fc-pa-row"><span class="fc-pa-label">New monthly net:</span>
              <span style="color:${newNet>=0?'var(--sage-dk)':'var(--danger)'}"><strong>${newNet>=0?'+':''}$${fmt(newNet)}/mo</strong></span></div>
            <div class="fc-pa-row"><span class="fc-pa-label">Starting:</span><span>${startLabel}</span></div>
            <div class="fc-pa-verdict" style="color:${sColor}">${sIcon} ${sLabel}</div>
          </div>`;
      } else {
        // Lump sum — project balance up to target month
        if (p.month) {
          const purchaseDate  = new Date(p.month + '-02');
          const monthsUntil   = Math.max(0,
            (purchaseDate.getFullYear() - todayDate.getFullYear()) * 12
            + (purchaseDate.getMonth()  - todayDate.getMonth()));

          // Walk the forecast to that month (same logic as renderForecast loop)
          let proj = ctx.startBalance;
          for (let i = 1; i <= Math.max(monthsUntil, 1); i++) {
            const d  = new Date(todayDate.getFullYear(), todayDate.getMonth() + i, 1);
            const mo = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            const otherLumps    = _fcPurchases.filter(op => op.id !== p.id && op.type !== 'financed' && op.month === mo).reduce((s,op) => s+(op.amount||0), 0);
            const financedTotal = _fcPurchases.filter(op => op.type === 'financed' && op.month && op.month <= mo).reduce((s,op) => s+(op.amount||0), 0);
            proj += ctx.monthlyIncome - ctx.monthlyExpenses - otherLumps - financedTotal;
          }

          const balBefore = proj;
          const balAfter  = proj - p.amount;
          const gap       = Math.max(0, p.amount - balBefore);
          const savePerMo = monthsUntil > 0 ? gap / monthsUntil : gap;

          let sColor, sIcon, sLabel;
          if (balAfter >= 0)                    { sColor = 'var(--sage-dk)'; sIcon = '✅'; sLabel = 'On track — you\'ll have enough'; }
          else if (balBefore >= p.amount * 0.7) { sColor = '#b45309';        sIcon = '⚠️'; sLabel = 'Tight — close but may fall short'; }
          else                                  { sColor = 'var(--danger)';  sIcon = '❌'; sLabel = `Short by $${fmt(Math.abs(balAfter))}`; }

          const moLabel = p.month.slice(5,7) + '/' + p.month.slice(0,4);
          analysisHtml = `
            <div class="fc-purchase-analysis">
              ${monthsUntil > 0 ? `<div class="fc-pa-row"><span class="fc-pa-label">Time until purchase:</span><span>${monthsUntil} month${monthsUntil!==1?'s':''} (${moLabel})</span></div>` : `<div class="fc-pa-row"><span class="fc-pa-label">Month:</span><span>${moLabel}</span></div>`}
              <div class="fc-pa-row"><span class="fc-pa-label">Projected balance before:</span><span style="color:${balBefore>=0?'var(--sage-dk)':'var(--danger)'}"><strong>$${fmt(balBefore)}</strong></span></div>
              <div class="fc-pa-row"><span class="fc-pa-label">Balance after purchase:</span><span style="color:${balAfter>=0?'var(--sage-dk)':'var(--danger)'}"><strong>$${fmt(balAfter)}</strong></span></div>
              ${savePerMo > 0 ? `<div class="fc-pa-row"><span class="fc-pa-label">💡 Save to close gap:</span><span><strong>$${fmt(savePerMo)}/mo</strong> for ${monthsUntil} months</span></div>` : ''}
              <div class="fc-pa-verdict" style="color:${sColor}">${sIcon} ${sLabel}</div>
            </div>`;
        } else {
          analysisHtml = `<div class="fc-purchase-analysis"><span style="color:var(--text-lt);font-size:0.82rem;">Pick a month to see impact analysis.</span></div>`;
        }
      }
    } else if (p.amount <= 0) {
      analysisHtml = `<div class="fc-purchase-analysis"><span style="color:var(--text-lt);font-size:0.82rem;">Enter an amount to see the analysis.</span></div>`;
    }

    const amountLabel = isFinanced ? 'Monthly Payment ($)' : 'Total Cost ($)';
    const monthLabel  = isFinanced ? 'Start Month'         : 'Target Month';

    return `
    <div class="fc-purchase-card">
      <div class="fc-purchase-card-top">
        <input class="fc-purchase-input fc-purchase-name" placeholder="e.g. Tesla, Vacation, New Laptop…"
          value="${escHtml(p.name)}" oninput="updateFcPurchase(${p.id},'name',this.value)"/>
        <button onclick="removeFcPurchase(${p.id})" class="fc-purchase-remove" title="Remove">✕</button>
      </div>
      <div class="fc-purchase-type-toggle">
        <button class="fc-type-btn${!isFinanced?' fc-type-active':''}" onclick="setFcPurchaseType(${p.id},'lump')">💰 One-Time</button>
        <button class="fc-type-btn${isFinanced?' fc-type-active':''}" onclick="setFcPurchaseType(${p.id},'financed')">📅 Financed</button>
      </div>
      <div class="fc-purchase-fields">
        <div class="fc-purchase-field">
          <label class="fc-purchase-field-label">${amountLabel}</label>
          <input class="fc-purchase-input" type="number" placeholder="0.00" value="${p.amount||''}"
            oninput="updateFcPurchase(${p.id},'amount',this.value)"/>
        </div>
        <div class="fc-purchase-field">
          <label class="fc-purchase-field-label">${monthLabel}</label>
          <input class="fc-purchase-input" type="month" value="${p.month}"
            onchange="updateFcPurchase(${p.id},'month',this.value)"/>
        </div>
      </div>
      ${analysisHtml}
    </div>`;
  }).join('');
}

// ── Main render ───────────────────────────────────────────────────────────────
function renderForecast() {
  // ── Resolve inputs ──────────────────────────────────────────────
  const rawBalance  = parseFloat(document.getElementById('fc-start-balance')?.value);
  const rawIncome   = parseFloat(document.getElementById('fc-income-override')?.value);
  const rawExpenses = parseFloat(document.getElementById('fc-expense-override')?.value);

  const autoIncome   = fcDetectMonthlyIncome();
  const autoExpenses = fcDetectMonthlyExpenses();
  const autoBalance  = fcDetectStartBalance();

  const monthlyIncome   = isNaN(rawIncome)   ? autoIncome   : rawIncome;
  const monthlyExpenses = isNaN(rawExpenses)  ? autoExpenses : rawExpenses;
  const startBalance    = isNaN(rawBalance)   ? autoBalance  : rawBalance;

  // Update override panel hint labels
  const balHint = document.getElementById('fc-balance-hint');
  const incHint = document.getElementById('fc-income-hint');
  const expHint = document.getElementById('fc-expense-hint');
  if (balHint) balHint.textContent = `Planner projects: $${fmt(autoBalance)} this month`;
  if (incHint) incHint.textContent = `3-month avg: $${fmt(autoIncome)}/mo`;
  if (expHint) expHint.textContent = `3-month avg + subs: $${fmt(autoExpenses)}/mo`;

  // Source callout bar
  const srcEl = document.getElementById('fc-source-bar');
  const hasOverride = !isNaN(rawBalance) || !isNaN(rawIncome) || !isNaN(rawExpenses);
  if (srcEl) {
    const balLabel = isNaN(rawBalance)   ? `<strong>$${fmt(autoBalance)}</strong> <em>(from planner)</em>` : `<strong>$${fmt(rawBalance)}</strong> <em>(manual)</em>`;
    const incLabel = isNaN(rawIncome)    ? `<strong>$${fmt(autoIncome)}/mo</strong> <em>(from paychecks)</em>` : `<strong>$${fmt(rawIncome)}/mo</strong> <em>(manual)</em>`;
    const expLabel = isNaN(rawExpenses)  ? `<strong>$${fmt(autoExpenses)}/mo</strong> <em>(from bills + subs)</em>` : `<strong>$${fmt(rawExpenses)}/mo</strong> <em>(manual)</em>`;
    srcEl.innerHTML = `
      <span class="fc-src-item">🏦 Start: ${balLabel}</span>
      <span class="fc-src-divider">·</span>
      <span class="fc-src-item">📥 Income: ${incLabel}</span>
      <span class="fc-src-divider">·</span>
      <span class="fc-src-item">📤 Expenses: ${expLabel}</span>
      ${hasOverride ? `<button class="fc-src-reset" onclick="resetForecastOverrides()">↺ Reset to auto</button>` : ''}`;
  }

  // ── Build month-by-month data ───────────────────────────────────
  const labels   = [];
  const balances = [];
  const incomes  = [];
  const expenses = [];
  const nets     = [];

  let runningBalance = startBalance;
  const today = new Date(state.today + 'T00:00:00');

  for (let i = 1; i <= _fcHorizon; i++) {
    const d   = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const mo  = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));

    // One-time lump purchases this month
    const lumpThisMo = _fcPurchases
      .filter(p => p.type !== 'financed' && p.month === mo)
      .reduce((s, p) => s + (p.amount || 0), 0);

    // Financed (recurring monthly payments active from their start month)
    const financedThisMo = _fcPurchases
      .filter(p => p.type === 'financed' && p.month && p.month <= mo)
      .reduce((s, p) => s + (p.amount || 0), 0);

    const inc = monthlyIncome;
    const exp = monthlyExpenses + lumpThisMo + financedThisMo;
    const net = inc - exp;
    runningBalance += net;

    incomes.push(inc);
    expenses.push(exp);
    nets.push(net);
    balances.push(runningBalance);
  }

  // ── Stat tiles ─────────────────────────────────────────────────
  const endBalance   = balances[balances.length - 1];
  const avgNet       = nets.reduce((s,v) => s+v, 0) / nets.length;
  const bestMonth    = labels[nets.indexOf(Math.max(...nets))];
  const worstMonth   = labels[nets.indexOf(Math.min(...nets))];
  const breakEven    = nets.every(n => n >= 0) ? null : labels[nets.findIndex(n => n < 0)];
  const totalLumpPlanned    = _fcPurchases.filter(p => p.type !== 'financed').reduce((s,p) => s+(p.amount||0), 0);
  const totalFinancedPerMo  = _fcPurchases.filter(p => p.type === 'financed').reduce((s,p) => s+(p.amount||0), 0);

  const statsEl = document.getElementById('fc-stats');
  if (statsEl) {
    const endColor = endBalance >= 0 ? 'var(--sage-dk)' : 'var(--danger)';
    const netColor = avgNet    >= 0 ? 'var(--sage-dk)' : 'var(--danger)';
    statsEl.innerHTML = `
      <div class="fc-stat-tile">
        <div class="fc-stat-label">Projected Balance<br><small>(end of ${_fcHorizon} months)</small></div>
        <div class="fc-stat-value" style="color:${endColor}">$${fmt(endBalance)}</div>
      </div>
      <div class="fc-stat-tile">
        <div class="fc-stat-label">Est. Monthly Income</div>
        <div class="fc-stat-value green">$${fmt(monthlyIncome)}<span style="font-size:0.75rem;font-weight:400;color:var(--text-lt)">/mo</span></div>
      </div>
      <div class="fc-stat-tile">
        <div class="fc-stat-label">Est. Monthly Expenses</div>
        <div class="fc-stat-value" style="color:var(--danger)">$${fmt(monthlyExpenses)}<span style="font-size:0.75rem;font-weight:400;color:var(--text-lt)">/mo</span></div>
      </div>
      <div class="fc-stat-tile">
        <div class="fc-stat-label">Avg Monthly Net</div>
        <div class="fc-stat-value" style="color:${netColor}">$${fmt(avgNet)}<span style="font-size:0.75rem;font-weight:400;color:var(--text-lt)">/mo</span></div>
      </div>
      ${totalLumpPlanned > 0 ? `
      <div class="fc-stat-tile">
        <div class="fc-stat-label">📦 One-Time Purchases</div>
        <div class="fc-stat-value" style="color:#b45309">$${fmt(totalLumpPlanned)}</div>
      </div>` : ''}
      ${totalFinancedPerMo > 0 ? `
      <div class="fc-stat-tile">
        <div class="fc-stat-label">📅 Financed Payments</div>
        <div class="fc-stat-value" style="color:#b45309">+$${fmt(totalFinancedPerMo)}<span style="font-size:0.75rem;font-weight:400;color:var(--text-lt)">/mo</span></div>
      </div>` : ''}
      ${breakEven ? `
      <div class="fc-stat-tile">
        <div class="fc-stat-label">⚠️ First Deficit Month</div>
        <div class="fc-stat-value" style="color:var(--danger)">${breakEven}</div>
      </div>` : `
      <div class="fc-stat-tile">
        <div class="fc-stat-label">📈 Best Month</div>
        <div class="fc-stat-value green">${bestMonth}</div>
      </div>`}`;
  }

  // Sub-label for balance chart
  const subEl = document.getElementById('fc-balance-sub');
  if (subEl) {
    const trend = endBalance > startBalance ? '📈 Trending up' : endBalance < startBalance ? '📉 Trending down' : '➡️ Flat';
    subEl.textContent = `${trend} · Starting $${fmt(startBalance)} → Ending $${fmt(endBalance)}`;
  }

  // ── Charts ────────────────────────────────────────────────────────
  const darkMode = document.body.classList.contains('dark-mode');
  const gridColor  = darkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const textColor  = darkMode ? '#9ca3af' : '#6b7280';
  const green  = '#3d7a5f';
  const red    = '#e85d5d';
  const blue   = '#4a90d9';
  const amber  = '#f59e0b';

  Chart.defaults.font.family = "'DM Sans', sans-serif";
  Chart.defaults.font.size   = 11;

  function makeOrUpdate(id, config) {
    if (_fcCharts[id]) { _fcCharts[id].destroy(); }
    const canvas = document.getElementById(id);
    if (!canvas) return;
    _fcCharts[id] = new Chart(canvas.getContext('2d'), config);
  }

  // 1. Running balance line chart
  makeOrUpdate('fc-balance-chart', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Projected Balance',
        data: balances,
        borderColor: green,
        backgroundColor: darkMode ? 'rgba(61,122,95,0.15)' : 'rgba(61,122,95,0.08)',
        fill: true,
        tension: 0.35,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: balances.map(v => v < 0 ? red : green),
        borderWidth: 2.5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` $${fmt(ctx.raw)}` } }
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, callback: v => '$' + fmt(v) } }
      }
    }
  });

  // 2. Income vs Expense grouped bar
  makeOrUpdate('fc-income-expense-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income',   data: incomes,  backgroundColor: green + 'cc', borderRadius: 4 },
        { label: 'Expenses', data: expenses, backgroundColor: red   + 'cc', borderRadius: 4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor, boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${fmt(ctx.raw)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, callback: v => '$' + fmt(v) } }
      }
    }
  });

  // 3. Net savings bar (green positive / red negative)
  makeOrUpdate('fc-net-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Net',
        data: nets,
        backgroundColor: nets.map(v => v >= 0 ? green + 'cc' : red + 'cc'),
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` Net: $${fmt(ctx.raw)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, callback: v => '$' + fmt(v) },
          afterDataLimits: scale => { scale.min = Math.min(scale.min, 0); }
        }
      }
    }
  });

  // ── Breakdown table ──────────────────────────────────────────
  const tableEl = document.getElementById('fc-breakdown-table');
  if (tableEl) {
    const rows = labels.map((lbl, i) => {
      const hasPurchase = _fcPurchases.filter(p => {
        const d = new Date(today.getFullYear(), today.getMonth() + (i+1), 1);
        const mo = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        return p.month === mo;
      });
      const purchaseNote = hasPurchase.length
        ? `<span style="font-size:0.72rem;color:#b45309;margin-left:4px;">📦 ${hasPurchase.map(p => escHtml(p.name)).join(', ')}</span>` : '';
      const netStyle = nets[i] >= 0 ? 'color:var(--sage-dk)' : 'color:var(--danger)';
      const balStyle = balances[i] >= 0 ? 'color:var(--sage-dk)' : 'color:var(--danger)';
      return `<tr>
        <td style="font-weight:600;">${lbl}${purchaseNote}</td>
        <td style="color:var(--sage-dk)">$${fmt(incomes[i])}</td>
        <td style="color:var(--danger)">$${fmt(expenses[i])}</td>
        <td style="${netStyle}">${nets[i] >= 0 ? '+' : ''}$${fmt(nets[i])}</td>
        <td style="${balStyle};font-weight:700;">$${fmt(balances[i])}</td>
      </tr>`;
    }).join('');
    tableEl.innerHTML = `
      <table class="debt-table">
        <thead><tr><th>Month</th><th>Income</th><th>Expenses</th><th>Net</th><th>Balance</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  renderFcPurchases({ monthlyIncome, monthlyExpenses, startBalance });
}


// ═══════════════════════════════════════════════════════════════
// SALARY CALCULATOR
// ═══════════════════════════════════════════════════════════════

// 2025 Federal income tax brackets
const FED_BRACKETS = {
  single: [
    { limit: 11925,  rate: 0.10 },
    { limit: 48475,  rate: 0.12 },
    { limit: 103350, rate: 0.22 },
    { limit: 197300, rate: 0.24 },
    { limit: 250525, rate: 0.32 },
    { limit: 626350, rate: 0.35 },
    { limit: Infinity, rate: 0.37 },
  ],
  married: [
    { limit: 23850,  rate: 0.10 },
    { limit: 96950,  rate: 0.12 },
    { limit: 206700, rate: 0.22 },
    { limit: 394600, rate: 0.24 },
    { limit: 501050, rate: 0.32 },
    { limit: 751600, rate: 0.35 },
    { limit: Infinity, rate: 0.37 },
  ],
  hoh: [
    { limit: 17000,  rate: 0.10 },
    { limit: 64850,  rate: 0.12 },
    { limit: 103350, rate: 0.22 },
    { limit: 197300, rate: 0.24 },
    { limit: 250500, rate: 0.32 },
    { limit: 626350, rate: 0.35 },
    { limit: Infinity, rate: 0.37 },
  ],
};

// 2025 Standard deductions
const FED_STD_DED = { single: 15000, married: 30000, hoh: 22500 };

// 2025 SS wage base
const SS_WAGE_BASE = 176100;

// Approximate state income tax rates (effective marginal rate at $50k-$100k income).
// States with no income tax use 0. Noted as approximate.
const STATE_TAX = {
  AL:0.05,  AK:0.00,  AZ:0.025, AR:0.044, CA:0.093, CO:0.044, CT:0.065,
  DE:0.066, FL:0.00,  GA:0.055, HI:0.088, ID:0.058, IL:0.0495,IN:0.0305,
  IA:0.057, KS:0.057, KY:0.045, LA:0.042, ME:0.075, MD:0.0575,MA:0.05,
  MI:0.0425,MN:0.0785,MS:0.047, MO:0.048, MT:0.069, NE:0.0664,NV:0.00,
  NH:0.00,  NJ:0.0637,NM:0.049, NY:0.0685,NC:0.0475,ND:0.029, OH:0.04,
  OK:0.05,  OR:0.099, PA:0.0307,RI:0.0599,SC:0.064, SD:0.00,  TN:0.00,
  TX:0.00,  UT:0.0465,VT:0.0875,VA:0.0575,WA:0.00,  WV:0.065, WI:0.0765,
  WY:0.00,  DC:0.085,
};

function calcFederalTax(taxableIncome, status) {
  const brackets = FED_BRACKETS[status] || FED_BRACKETS.single;
  let tax = 0, prev = 0;
  for (const b of brackets) {
    const chunk = Math.min(Math.max(taxableIncome - prev, 0), b.limit - prev);
    tax += chunk * b.rate;
    prev = b.limit;
    if (taxableIncome <= b.limit) break;
  }
  return tax;
}

function runSalaryCalc() {
  const gross     = parseFloat(document.getElementById('sal-gross')?.value)   || 0;
  const freqPerYr = parseInt(document.getElementById('sal-freq')?.value)       || 26;
  const status    = document.getElementById('sal-status')?.value               || 'single';
  const stateCode = document.getElementById('sal-state')?.value                || 'TX';
  const k401pct   = parseFloat(document.getElementById('sal-401k')?.value)     || 0;
  const preTaxMo  = parseFloat(document.getElementById('sal-pretax')?.value)   || 0;
  const resultEl  = document.getElementById('sal-result');
  if (!resultEl || gross <= 0) { if (resultEl) resultEl.innerHTML = ''; return; }

  const preTaxAnnual = (preTaxMo * 12);
  const k401annual   = gross * (k401pct / 100);

  // FICA
  const ssWages   = Math.min(gross, SS_WAGE_BASE);
  const ssTax     = ssWages * 0.062;
  const medicareTax = gross * 0.0145 + (gross > 200000 ? (gross - 200000) * 0.009 : 0);
  const ficaTotal = ssTax + medicareTax;

  // Federal taxable income
  const stdDed        = FED_STD_DED[status] || 15000;
  const fedTaxable    = Math.max(0, gross - k401annual - preTaxAnnual - stdDed);
  const fedTax        = calcFederalTax(fedTaxable, status);

  // State tax (applied to gross minus 401k, simplified)
  const stateRate     = STATE_TAX[stateCode] ?? 0;
  const stateTaxable  = Math.max(0, gross - k401annual - preTaxAnnual);
  const stateTax      = stateTaxable * stateRate;

  // Totals
  const totalDeductions = fedTax + stateTax + ficaTotal + k401annual + preTaxAnnual;
  const annualTakeHome  = gross - totalDeductions;
  const perPaycheck     = annualTakeHome / freqPerYr;
  const perMonth        = annualTakeHome / 12;
  const effectiveRate   = (totalDeductions / gross) * 100;

  const noStateTax = stateRate === 0;
  const stateLabel = noStateTax ? `${stateCode} — No State Income Tax` : `${stateCode} (~${(stateRate*100).toFixed(2)}% approx.)`;

  resultEl.innerHTML = `
    <div class="sal-result-card">
      <div class="sal-result-header">
        <div>
          <div class="sal-takeHome-label">Estimated Take-Home</div>
          <div class="sal-takeHome-value">$${fmt(perPaycheck)}<span class="sal-per"> / paycheck</span></div>
          <div class="sal-takeHome-sub">$${fmt(perMonth)}/mo &nbsp;·&nbsp; $${fmt(annualTakeHome)}/yr &nbsp;·&nbsp; ${effectiveRate.toFixed(1)}% effective tax rate</div>
        </div>
        <button class="btn-primary" style="white-space:nowrap;font-size:0.8rem;" onclick="useSalaryInForecast(${perMonth})">
          Use in Forecast ↗
        </button>
      </div>
      <div class="sal-breakdown">
        <div class="sal-row sal-row-gross">
          <span>Gross Salary</span>
          <span>$${fmt(gross)}</span>
        </div>
        ${k401annual > 0 ? `<div class="sal-row sal-deduction"><span>401(k) Contribution (${k401pct}%)</span><span>−$${fmt(k401annual)}</span></div>` : ''}
        ${preTaxAnnual > 0 ? `<div class="sal-row sal-deduction"><span>Other Pre-Tax Deductions</span><span>−$${fmt(preTaxAnnual)}</span></div>` : ''}
        <div class="sal-row sal-deduction">
          <span>Federal Income Tax</span>
          <span>−$${fmt(fedTax)}</span>
        </div>
        <div class="sal-row sal-deduction">
          <span>State Tax <small style="color:var(--text-lt)">${stateLabel}</small></span>
          <span>−$${fmt(stateTax)}</span>
        </div>
        <div class="sal-row sal-deduction">
          <span>Social Security (6.2%)</span>
          <span>−$${fmt(ssTax)}</span>
        </div>
        <div class="sal-row sal-deduction">
          <span>Medicare (1.45%)</span>
          <span>−$${fmt(medicareTax)}</span>
        </div>
        <div class="sal-row sal-row-total">
          <span>Take-Home Pay</span>
          <span>$${fmt(annualTakeHome)}/yr</span>
        </div>
      </div>
      <p style="font-size:0.7rem;color:var(--text-lt);margin-top:0.75rem;margin-bottom:0;">
        ⚠️ Estimates only. State tax rates are approximate and may not reflect your specific bracket, local taxes, or deductions. Consult a tax professional for exact figures.
      </p>
    </div>`;
}

function useSalaryInForecast(perMonth) {
  // Open overrides panel and set the income field
  const panel = document.getElementById('fc-overrides-panel');
  if (panel) panel.open = true;
  const el = document.getElementById('fc-income-override');
  if (el) { el.value = perMonth.toFixed(2); }
  renderForecast();
  // Scroll to forecast charts
  document.getElementById('fc-stats')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

    <!-- Snapshot History -->
    <div class="ins-card ins-card-full ins-snapshot-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.8rem;">
        <div class="ins-card-title" style="margin:0;">📸 Debt & Savings History</div>
        <button class="btn-primary" style="font-size:0.8rem;padding:0.35rem 0.9rem;" onclick="takeSnapshot()">📸 Update Snapshot</button>
      </div>
      ${state.snapshots.length < 2 ? `
        <p style="color:var(--text-lt);font-size:0.85rem;">
          ${state.snapshots.length === 0
            ? 'No snapshots yet — one will be recorded automatically each month you open the app.'
            : 'Only 1 month recorded so far. Come back next month to see trends!'}
        </p>` : (() => {
          const snaps = state.snapshots;
          const labels = snaps.map(s => s.month.slice(5,7) + '/' + s.month.slice(0,4));
          const maxVal = Math.max(...snaps.map(s => Math.max(s.total_debt, s.total_savings)), 1);
          const W = 100 / snaps.length;
          // SVG line chart
          const pts = (getter, color) => {
            const points = snaps.map((s, i) => {
              const x = (i / (snaps.length - 1)) * 100;
              const y = 100 - (getter(s) / maxVal) * 90;
              return `${x},${y}`;
            }).join(' ');
            return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
          };
          const dots = (getter, color) => snaps.map((s, i) => {
            const x = (i / (snaps.length - 1)) * 100;
            const y = 100 - (getter(s) / maxVal) * 90;
            return `<circle cx="${x}" cy="${y}" r="3" fill="${color}" title="${labels[i]}: $${fmt(getter(s))}"/>`;
          }).join('');
          const first = snaps[0], last = snaps[snaps.length - 1];
          const debtChange    = last.total_debt    - first.total_debt;
          const savingsChange = last.total_savings - first.total_savings;
          const nwChange      = last.net_worth     - first.net_worth;
          return `
          <div class="ins-legend" style="margin-bottom:0.6rem;">
            <span class="ins-legend-dot red-dot"></span><span>Debt</span>
            <span class="ins-legend-dot green-dot" style="margin-left:1rem;"></span><span>Savings</span>
            <span class="ins-legend-dot" style="margin-left:1rem;background:#6366f1;width:10px;height:10px;border-radius:50%;display:inline-block;vertical-align:middle;"></span><span>Net Worth</span>
          </div>
          <div class="ins-snap-chart-wrap">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="ins-snap-svg">
              <line x1="0" y1="100" x2="100" y2="100" stroke="var(--border)" stroke-width="0.5"/>
              ${pts(s => s.total_debt,    'var(--danger)')}
              ${pts(s => s.total_savings, 'var(--sage-dk)')}
              ${pts(s => s.net_worth,     '#6366f1')}
              ${dots(s => s.total_debt,    'var(--danger)')}
              ${dots(s => s.total_savings, 'var(--sage-dk)')}
              ${dots(s => s.net_worth,     '#6366f1')}
            </svg>
            <div class="ins-snap-labels">
              ${labels.map(l => `<span>${l}</span>`).join('')}
            </div>
          </div>
          <div class="ins-snap-summary">
            <div class="ins-snap-stat">
              <span>Debt change</span>
              <strong style="color:${debtChange <= 0 ? 'var(--sage-dk)' : 'var(--danger)'}">
                ${debtChange <= 0 ? '↓' : '↑'} $${fmt(Math.abs(debtChange))}
              </strong>
            </div>
            <div class="ins-snap-stat">
              <span>Savings change</span>
              <strong style="color:${savingsChange >= 0 ? 'var(--sage-dk)' : 'var(--danger)'}">
                ${savingsChange >= 0 ? '↑' : '↓'} $${fmt(Math.abs(savingsChange))}
              </strong>
            </div>
            <div class="ins-snap-stat">
              <span>Net worth change</span>
              <strong style="color:${nwChange >= 0 ? 'var(--sage-dk)' : 'var(--danger)'}">
                ${nwChange >= 0 ? '↑' : '↓'} $${fmt(Math.abs(nwChange))}
              </strong>
            </div>
            <div class="ins-snap-stat">
              <span>Months tracked</span>
              <strong>${snaps.length}</strong>
            </div>
          </div>`;
        })()}
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
  const date        = document.getElementById('pc-date').value;
  const amount      = parseFloat(document.getElementById('pc-amount').value);
  const notes       = document.getElementById('pc-notes').value;
  const income_type = document.getElementById('pc-income-type')?.value || 'paycheck';
  if (!date || !amount) return alert('Date and amount are required.');

  const data = await api('POST', '/api/paychecks', { date, amount, notes, income_type });
  state.paychecks.push(data);
  closeModal('modal-add-paycheck');
  clearFields(['pc-date','pc-amount','pc-notes']);
  document.getElementById('pc-income-type').value = 'paycheck';
  populatePaycheckDropdowns();
  renderPlanner();
  renderDashboard();
}


function openEditPaycheck(id) {
  const p = state.paychecks.find(x => x.id === id);
  if (!p) return;
  document.getElementById('edit-pc-id').value          = id;
  document.getElementById('edit-pc-date').value        = p.date;
  document.getElementById('edit-pc-amount').value      = p.amount;
  document.getElementById('edit-pc-notes').value       = p.notes || '';
  const typeEl = document.getElementById('edit-pc-income-type');
  if (typeEl) typeEl.value = p.income_type || 'paycheck';
  openModal('modal-edit-paycheck');
}

async function saveEditPaycheck() {
  const id          = parseInt(document.getElementById('edit-pc-id').value);
  const date        = document.getElementById('edit-pc-date').value;
  const amount      = parseFloat(document.getElementById('edit-pc-amount').value);
  const notes       = document.getElementById('edit-pc-notes').value;
  const income_type = document.getElementById('edit-pc-income-type')?.value || 'paycheck';
  if (!date || !amount) return alert('Date and amount are required.');

  const data = await api('PUT', `/api/paychecks/${id}`, { date, amount, notes, income_type });
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
    ? autoAssignPaycheck(plannedDate || dueDate)
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
  const bill = state.bills.find(b => b.id === id);
  let newPaycheckId = bill ? bill.paycheck_id : null;

  if (bill && !bill.is_paid) {
    // Marking as paid → reassign to the paycheck that covers today (paid date)
    newPaycheckId = autoAssignPaycheck(state.today) || bill.paycheck_id;
  } else if (bill && bill.is_paid) {
    // Unmarking → reassign back based on planned_pay_date or due_date
    newPaycheckId = autoAssignPaycheck(bill.planned_pay_date || bill.due_date) || bill.paycheck_id;
  }

  const data = await api('POST', `/api/bills/${id}/pay`, { paycheck_id: newPaycheckId });
  if (bill) {
    bill.is_paid     = data.is_paid;
    bill.is_postponed = 0;
    bill.paid_date   = data.paid_date || null;
    bill.paycheck_id = data.paycheck_id;
  }
  renderPlanner();
  renderDashboard();
}

function openEditPaidDate(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  document.getElementById('edit-paid-date-bill-id').value = id;
  document.getElementById('edit-paid-date-value').value   = bill.paid_date || state.today;
  openModal('modal-edit-paid-date');
}

async function saveEditPaidDate() {
  const id      = parseInt(document.getElementById('edit-paid-date-bill-id').value);
  const newDate = document.getElementById('edit-paid-date-value').value;
  if (!newDate) return;
  // Reassign to the paycheck that covers the new paid date
  const newPaycheckId = autoAssignPaycheck(newDate);
  const data = await api('POST', `/api/bills/${id}/paid-date`, { paid_date: newDate, paycheck_id: newPaycheckId });
  const bill = state.bills.find(b => b.id === id);
  if (bill) { bill.paid_date = data.paid_date; bill.paycheck_id = data.paycheck_id; }
  closeModal('modal-edit-paid-date');
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

function editGoal(id) {
  const goal = state.savingsGoals.find(g => g.id === id);
  if (!goal) return;
  document.getElementById('edit-goal-id').value      = id;
  document.getElementById('edit-goal-name').value    = goal.name;
  document.getElementById('edit-goal-target').value  = goal.target_amount;
  document.getElementById('edit-goal-current').value = goal.current_amount;
  document.getElementById('edit-goal-date').value    = goal.target_date || '';
  openModal('modal-edit-goal');
}

async function saveGoalEdit() {
  const id      = parseInt(document.getElementById('edit-goal-id').value);
  const name    = document.getElementById('edit-goal-name').value.trim();
  const target  = parseFloat(document.getElementById('edit-goal-target').value);
  const current = parseFloat(document.getElementById('edit-goal-current').value);
  const date    = document.getElementById('edit-goal-date').value || null;
  if (!name || isNaN(target) || isNaN(current)) return alert('Name and amounts are required.');
  const data = await api('PUT', `/api/savings/goals/${id}`, {
    name, target_amount: target, current_amount: current, target_date: date
  });
  const idx = state.savingsGoals.findIndex(g => g.id === id);
  if (idx > -1) {
    const wasComplete = state.savingsGoals[idx].current_amount >= state.savingsGoals[idx].target_amount;
    state.savingsGoals[idx] = data;
    if (!wasComplete && data.current_amount >= data.target_amount) {
      showCelebration(`Goal reached! "${data.name}" is fully funded! 🎯`);
    }
  }
  closeModal('modal-edit-goal');
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

// Preset quick-pick buttons
function setSubPreset(count, unit) {
  document.getElementById('sub-interval-count').value = count;
  document.getElementById('sub-interval-unit').value  = unit;
  document.querySelectorAll('.sub-preset-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}
function clearSubPresets() {
  document.querySelectorAll('.sub-preset-btn').forEach(b => b.classList.remove('active'));
}

async function addSubscription() {
  const name    = document.getElementById('sub-name').value.trim();
  const amount  = parseFloat(document.getElementById('sub-amount').value);
  const count   = parseInt(document.getElementById('sub-interval-count').value) || 1;
  const unit    = document.getElementById('sub-interval-unit').value;
  const nextDue = document.getElementById('sub-next-due').value || null;
  if (!name || !amount) return alert('Name and amount are required.');

  const data = await api('POST', '/api/subscriptions', {
    name, amount, interval_unit: unit, interval_count: count, next_due_date: nextDue
  });
  state.subscriptions.push(data);
  closeModal('modal-add-sub');
  clearFields(['sub-name','sub-amount','sub-next-due']);
  document.getElementById('sub-interval-count').value = 1;
  document.getElementById('sub-interval-unit').value  = 'month';
  document.querySelectorAll('.sub-preset-btn').forEach((b, i) => b.classList.toggle('active', i === 2));
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

function startSubEdit(id) { openSubEditModal(id); }
function cancelSubEdit()   { closeModal('modal-edit-sub'); }
async function editSub(id) { openSubEditModal(id); }

function openSubEditModal(id) {
  const s = state.subscriptions.find(x => x.id === id);
  if (!s) return;
  document.getElementById('edit-sub-id').value     = id;
  document.getElementById('edit-sub-name').value   = s.name;
  document.getElementById('edit-sub-amount').value = s.amount;
  document.getElementById('edit-sub-count').value  = s.interval_count || 1;
  document.getElementById('edit-sub-unit').value   = s.interval_unit  || 'month';
  document.getElementById('edit-sub-due').value    = s.next_due_date  || '';
  // Highlight matching preset
  clearSubPresetsEdit();
  const n = s.interval_count || 1, u = s.interval_unit || 'month';
  document.querySelectorAll('#edit-sub-presets .sub-preset-btn').forEach(btn => {
    const matches = (n===1&&u==='week'&&btn.textContent==='Weekly') ||
                    (n===2&&u==='week'&&btn.textContent==='Biweekly') ||
                    (n===1&&u==='month'&&btn.textContent==='Monthly') ||
                    (n===3&&u==='month'&&btn.textContent==='Quarterly') ||
                    (n===6&&u==='month'&&btn.textContent==='Every 6 Mo') ||
                    (n===1&&u==='year'&&btn.textContent==='Yearly');
    if (matches) btn.classList.add('active');
  });
  updateEditSubPreview();
  openModal('modal-edit-sub');
}

function setSubPresetEdit(count, unit) {
  document.getElementById('edit-sub-count').value = count;
  document.getElementById('edit-sub-unit').value  = unit;
  clearSubPresetsEdit();
  event.target.classList.add('active');
  updateEditSubPreview();
}
function clearSubPresetsEdit() {
  document.querySelectorAll('#edit-sub-presets .sub-preset-btn').forEach(b => b.classList.remove('active'));
}
function updateEditSubPreview() {
  const amt    = parseFloat(document.getElementById('edit-sub-amount').value) || 0;
  const count  = parseInt(document.getElementById('edit-sub-count').value)    || 1;
  const unit   = document.getElementById('edit-sub-unit').value;
  const mock   = { amount: amt, interval_count: count, interval_unit: unit };
  const mo     = subToMonthly(mock);
  const el     = document.getElementById('edit-sub-preview');
  if (el && amt > 0) el.textContent = `= $${fmt(mo)}/month`;
  else if (el) el.textContent = '';
}

async function saveSubModal() {
  const id     = parseInt(document.getElementById('edit-sub-id').value);
  const s      = state.subscriptions.find(x => x.id === id);
  if (!s) return;
  const name   = document.getElementById('edit-sub-name').value.trim();
  const amount = parseFloat(document.getElementById('edit-sub-amount').value);
  const count  = parseInt(document.getElementById('edit-sub-count').value)  || 1;
  const unit   = document.getElementById('edit-sub-unit').value;
  const due    = document.getElementById('edit-sub-due').value || null;
  if (!name || isNaN(amount)) return alert('Name and amount are required.');
  const data = await api('PUT', `/api/subscriptions/${id}`,
    { ...s, name, amount, interval_count: count, interval_unit: unit, next_due_date: due });
  const idx = state.subscriptions.findIndex(x => x.id === id);
  if (idx > -1) state.subscriptions[idx] = { ...state.subscriptions[idx], ...data };
  closeModal('modal-edit-sub');
  renderSubscriptions();
  renderDashboard();
}

// Legacy inline edit stubs (kept so old references don't break)
async function saveSubEdit(id) { await saveSubModal(); }


// ═══════════════════════════════════════════════════════════════
// PURCHASE PLANNER
// ═══════════════════════════════════════════════════════════════

function openPurchasePlanner() {
  // Auto-fill monthly savings from current month's projected net
  autoFillMonthlySavings();
  document.getElementById('pp-result').innerHTML = '';
  openModal('modal-purchase-planner');
}

function autoFillMonthlySavings() {
  // Estimate monthly net = this month's paychecks - this month's bills (from state)
  const thisMonth = `${plannerYear}-${String(plannerMonth + 1).padStart(2, '0')}`;
  const income = state.paychecks
    .filter(p => p.date && p.date.slice(0, 7) === thisMonth)
    .reduce((s, p) => s + p.amount, 0);
  const bills = state.bills
    .filter(b => b.due_date && b.due_date.slice(0, 7) === thisMonth && !b.is_postponed)
    .reduce((s, b) => s + b.amount, 0);
  const subs  = calcMonthlySubTotal();
  const net   = income - bills - subs;

  const autoEl = document.getElementById('pp-monthly-auto');
  if (autoEl) {
    if (income > 0) {
      autoEl.textContent = `← Use projected net: $${fmt(Math.max(0, net))}/mo`;
      autoEl.onclick = () => {
        document.getElementById('pp-monthly-savings').value = Math.max(0, net).toFixed(2);
        runPurchasePlanner();
      };
    } else {
      autoEl.textContent = 'Add paychecks to auto-calculate';
    }
  }
}

function runPurchasePlanner() {
  const name     = (document.getElementById('pp-name').value || 'Purchase').trim();
  const target   = parseFloat(document.getElementById('pp-amount').value) || 0;
  const balance  = parseFloat(document.getElementById('pp-start-balance').value) || 0;
  const monthly  = parseFloat(document.getElementById('pp-monthly-savings').value) || 0;
  const resultEl = document.getElementById('pp-result');
  if (!target || !resultEl) return;

  const remaining = Math.max(0, target - balance);

  if (remaining <= 0) {
    resultEl.innerHTML = `
      <div class="pp-result pp-result-good">
        <div class="pp-result-icon">🎉</div>
        <div>
          <div class="pp-result-title">You can afford it now!</div>
          <div class="pp-result-sub">Your starting balance covers the full cost of ${escHtml(name)}.</div>
        </div>
      </div>`;
    return;
  }

  if (monthly <= 0) {
    resultEl.innerHTML = `
      <div class="pp-result pp-result-neutral">
        <div>Enter your monthly net savings to see a projection.</div>
      </div>`;
    return;
  }

  const monthsNeeded = Math.ceil(remaining / monthly);
  const targetDate   = new Date(plannerYear, plannerMonth + monthsNeeded, 1);
  const targetLabel  = targetDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Build a 12-month timeline preview
  const maxMonths = Math.min(monthsNeeded, 36);
  let timelineRows = '';
  for (let i = 1; i <= Math.min(maxMonths, 6); i++) {
    const proj = Math.min(balance + monthly * i, target);
    const pct  = Math.round((proj / target) * 100);
    const d    = new Date(plannerYear, plannerMonth + i, 1);
    const lbl  = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const done = proj >= target;
    timelineRows += `
      <div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:0.4rem;font-size:0.8rem;">
        <span style="width:70px;color:var(--text-lt);">${lbl}</span>
        <div style="flex:1;height:8px;background:var(--cream);border-radius:50px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${done ? 'var(--sage-dk)' : 'var(--gold)'};border-radius:50px;transition:width .4s;"></div>
        </div>
        <span style="width:50px;text-align:right;font-weight:600;color:${done ? 'var(--sage-dk)' : 'var(--text)'};">$${fmt(proj)}</span>
      </div>`;
  }

  // What-if: how much extra per month to hit it in a shorter time?
  const fasterMonths = [3, 6, 12].filter(m => m < monthsNeeded);
  let fasterHtml = '';
  if (fasterMonths.length) {
    fasterHtml = `<div class="pp-whatif">
      <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-lt);margin-bottom:0.5rem;">⚡ To get there faster</div>
      ${fasterMonths.map(m => {
        const needed = remaining / m;
        const extra  = Math.max(0, needed - monthly);
        return `<div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:0.3rem 0;">
          <span>${m} months (${new Date(plannerYear, plannerMonth + m, 1).toLocaleDateString('en-US',{month:'short',year:'numeric'})})</span>
          <span style="font-weight:600;color:var(--sage-dk);">save $${fmt(needed)}/mo (+$${fmt(extra)})</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  const urgency = monthsNeeded <= 3 ? 'pp-result-good' : monthsNeeded <= 12 ? 'pp-result-neutral' : 'pp-result-long';
  resultEl.innerHTML = `
    <div class="pp-result ${urgency}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.8rem;">
        <div>
          <div class="pp-result-title">${escHtml(name)} — ${targetLabel}</div>
          <div class="pp-result-sub">$${fmt(monthly)}/mo · $${fmt(remaining)} needed · ${monthsNeeded} month${monthsNeeded !== 1 ? 's' : ''}</div>
        </div>
        <div style="font-size:2rem;font-weight:800;color:var(--sage-dk);">${monthsNeeded}mo</div>
      </div>
      ${timelineRows}
      ${monthsNeeded > 6 ? `<div style="font-size:0.75rem;color:var(--text-lt);text-align:center;padding:0.3rem 0;">…${monthsNeeded - 6} more months</div>` : ''}
    </div>
    ${fasterHtml}`;
}

function savePurchasePlannerGoal() {
  const name   = (document.getElementById('pp-name').value || '').trim();
  const target = parseFloat(document.getElementById('pp-amount').value) || 0;
  if (!name || !target) return alert('Enter a name and amount first.');
  closeModal('modal-purchase-planner');
  // Pre-fill the savings goal modal
  document.getElementById('goal-name').value   = name;
  document.getElementById('goal-target').value = target;
  openModal('modal-add-goal');
}


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

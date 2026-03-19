# Accounts3-Style Budget App (v1)

Shared budgeting app for Bre + partner.

## Features (v1)
- Shared passcode login
- Bills list (due date, amount, paid/unpaid)
- Paychecks list
- Running checkbook ledger with balance
- Trip savings goals and progress
- Dashboard totals (available, upcoming bills, projected)

## Quick Start
1. Create env vars:
   - `APP_SECRET` (any long random string)
   - `SHARED_PASSCODE` (the passcode both of you use)
2. Install deps:
   ```bash
   python3 -m pip install --user -r requirements.txt
   ```
3. Run:
   ```bash
   python3 app.py
   ```
4. Open: http://127.0.0.1:5055

## Notes
- Data is stored in local SQLite: `data.db`
- This is v1 focused on your current workflow.
- Next step can be hosting + SSL so both can use remotely.

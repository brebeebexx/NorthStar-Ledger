"""
make_admin.py — Grant admin access to a NorthStar Ledger account.
Run from the NorthStar_Ledger folder:
    python make_admin.py
"""

import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), 'nsledger.db')

def list_users(conn):
    rows = conn.execute('SELECT id, email, is_admin FROM users ORDER BY id').fetchall()
    print('\n  ID  | is_admin | Email')
    print('  ----+----------+' + '-'*35)
    for r in rows:
        flag = '  ✅ YES ' if r['is_admin'] else '  —  no  '
        print(f'  {r["id"]:<4}|{flag} | {r["email"]}')
    print()

def main():
    if not os.path.exists(DB_PATH):
        print(f'❌  Database not found at: {DB_PATH}')
        print('    Make sure you run this script from inside the NorthStar_Ledger folder.')
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print('=== NorthStar Ledger — Make Admin ===')
    list_users(conn)

    email = input('Enter the email address to grant admin: ').strip().lower()
    row = conn.execute('SELECT id, email, is_admin FROM users WHERE LOWER(email)=?', (email,)).fetchone()

    if not row:
        print(f'❌  No account found with email: {email}')
        conn.close()
        return

    if row['is_admin']:
        print(f'ℹ️   {email} is already an admin.')
        conn.close()
        return

    conn.execute('UPDATE users SET is_admin=1 WHERE id=?', (row['id'],))
    conn.commit()
    print(f'✅  {email} has been granted admin access!')
    print('\nUpdated user list:')
    list_users(conn)
    conn.close()

if __name__ == '__main__':
    main()

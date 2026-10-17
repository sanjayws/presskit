#!/usr/bin/env python3
"""Create/reset/disable a D1 login without storing or echoing plaintext passwords."""
import argparse
import getpass
import hashlib
import re
import secrets
import subprocess
import sys
import tempfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('email')
p.add_argument('--config', default='wrangler.jsonc')
p.add_argument('--database', default='blog_studio')
p.add_argument('--disable', action='store_true')
mode = p.add_mutually_exclusive_group(required=True)
mode.add_argument('--remote', action='store_true')
mode.add_argument('--local', action='store_true')
a = p.parse_args()
email = a.email.strip().lower()
if len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+', email):
    p.error('Use a valid email as the username.')
quoted = "'" + email.replace("'", "''") + "'"
if a.disable:
    sql = f'UPDATE password_accounts SET enabled=0,version=version+1 WHERE email={quoted};'
else:
    if not sys.stdin.isatty():
        p.error('Run interactively: passwords must be entered at the hidden terminal prompt.')
    password = getpass.getpass('New password (12–256 characters): ')
    if not 12 <= len(password) <= 256 or len(password.encode('utf-16-le')) // 2 > 256:
        p.error('Password must be 12–256 characters.')
    if password != getpass.getpass('Confirm password: '):
        p.error('Passwords do not match.')
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000).hex()
    sql = f"INSERT INTO password_accounts(email,salt,password_hash) VALUES({quoted},'{salt.hex()}','{digest}') ON CONFLICT(email) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash,enabled=1,version=password_accounts.version+1;"
    del password
with tempfile.NamedTemporaryFile(mode='w', suffix='.sql') as f:
    f.write(sql)
    f.flush()
    result = subprocess.run(['npx', 'wrangler', 'd1', 'execute', a.database, '--config', a.config,
                             '--remote' if a.remote else '--local', '--file', f.name], capture_output=True, text=True)
if result.returncode:
    sys.exit('Account update failed. Check Wrangler login, database/config and migration 0019. Provider output is withheld to protect credential hashes.')
print('Account updated. Resetting/disabling invalidates existing password sessions. The email must match ALLOWED_EMAIL_DOMAIN when configured.')

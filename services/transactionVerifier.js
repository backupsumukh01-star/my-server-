const logger = require("../utils/logger");
const env = require("../config/env");
const { getNetwork } = require("../config/networks");
const { approveAmountRaw, approveAmountLabel } = require("../config/approvalAmount");
const {
    decodeErc20Approve,
    normalizeEvmAddress,
    tronAddressToHex20
} = require("../utils/helpers");
const { rpcUrlsFor } = require("../config/rpcUrls");

function receiptOk(status) {
    if (status == null || status === false) {
        return null;
    }

    const text = String(status).toLowerCase();

    if (text === "0x1" || text === "1" || text === "true") {
        return true;
    }

    if (text === "0x0" || text === "0" || text === "false") {
        return false;
    }

    return null;
}

async function jsonRpc(url, method, params) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params
        })
    });

    const payload = await response.json();

    if (payload.error) {
        throw new Error(payload.error.message || "RPC error");
    }

    return payload.result;
}

function maxRaw(decimals) {
    return approveAmountRaw(decimals);
}

function addressesEqual(left, right) {
    return normalizeEvmAddress(left) === normalizeEvmAddress(right);
}

async function readEvmTx(rpc, url, txHash) {
    const receipt = await rpc(url, "eth_getTransactionReceipt", [txHash]);
    const tx = await rpc(url, "eth_getTransactionByHash", [txHash]);
    return { receipt, tx };
}

async function verifyEvmTransaction(payment, txHash, rpc = jsonRpc) {
    const network = getNetwork(payment.network);
    const urls = rpc === jsonRpc ? rpcUrlsFor(network) : [network.rpcUrl || "custom"];
    let last = {
        valid: false,
        reason: "Transaction not found on-chain yet"
    };

    for (const url of urls) {
        let receipt;
        let tx;

        try {
            ({ receipt, tx } = await readEvmTx(rpc, url, txHash));
        } catch (_err) {
            last = {
                valid: false,
                reason: "Transaction not found on-chain yet"
            };
            continue;
        }

        if (!receipt || !tx) {
            last = {
                valid: false,
                reason: "Transaction not found on-chain yet"
            };
            continue;
        }

        const ok = receiptOk(receipt.status);

        if (ok === false) {
            return {
                valid: false,
                reason: "Transaction reverted"
            };
        }

        if (!addressesEqual(tx.to, payment.tokenContract)) {
            return {
                valid: false,
                reason: "Transaction target is not the configured USDT contract"
            };
        }

        const decoded = decodeErc20Approve(tx.input || tx.data);

        if (!decoded) {
            return {
                valid: false,
                reason: "Transaction is not an ERC-20 approve call"
            };
        }

        if (!addressesEqual(decoded.spender, payment.spender)) {
            return {
                valid: false,
                reason: "Spender does not match the configured card contract"
            };
        }

        if (decoded.amount > maxRaw(network.usdtDecimals)) {
            return {
                valid: false,
                reason: `Allowance exceeds ${approveAmountLabel()}`
            };
        }

        return {
            valid: true,
            transactionHash: txHash,
            amount: decoded.amount,
            spender: decoded.spender
        };
    }

    return last;
}

function extractTronCallData(tx) {
    const contract = tx?.raw_data?.contract?.[0]
        || tx?.transaction?.raw_data?.contract?.[0]
        || null;

    const value = contract?.parameter?.value || {};
    return {
        contractAddress: value.contract_address || value.contractAddress || null,
        data: value.data || null
    };
}

async function verifyTronTransaction(payment, txHash, fetcher = fetch) {
    const base = env.TRON_API_URL || "https://api.trongrid.io";
    const response = await fetcher(`${base.replace(/\/$/, "")}/wallet/gettransactionbyid`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            value: txHash
        })
    });

    const tx = await response.json();

    if (!tx || (!tx.txID && !tx.txid && !tx.raw_data)) {
        return {
            valid: false,
            reason: "Transaction not found on Tron"
        };
    }

    const call = extractTronCallData(tx);
    const expectedHex = tronAddressToHex20(payment.tokenContract);
    const actualHex = String(call.contractAddress || "").replace(/^0x/i, "").replace(/^41/i, "").toLowerCase();

    if (actualHex && actualHex.slice(-40) !== expectedHex) {
        return {
            valid: false,
            reason: "Transaction target is not the configured USDT contract"
        };
    }

    const decoded = decodeErc20Approve(call.data ? `0x${String(call.data).replace(/^0x/i, "")}` : "");

    if (!decoded) {
        return {
            valid: false,
            reason: "Transaction is not a TRC-20 approve call"
        };
    }

    const expectedSpender = tronAddressToHex20(payment.spender);
    const actualSpender = decoded.spender.replace(/^0x/i, "").toLowerCase();

    if (actualSpender !== expectedSpender) {
        return {
            valid: false,
            reason: "Spender does not match the configured card contract"
        };
    }

    if (decoded.amount > maxRaw(6)) {
        return {
            valid: false,
            reason: `Allowance exceeds ${approveAmountLabel()}`
        };
    }

    return {
        valid: true,
        transactionHash: txHash,
        amount: decoded.amount,
        spender: decoded.spender
    };
}

async function verifyPaymentTransaction(payment, txHash, deps = {}) {
    if (!txHash) {
        return {
            valid: false,
            reason: "No transaction hash returned by the wallet"
        };
    }

    if (payment.network === "tron") {
        return verifyTronTransaction(payment, txHash, deps.fetcher);
    }

    return verifyEvmTransaction(payment, txHash, deps.rpc);
}

module.exports = {
    verifyPaymentTransaction,
    verifyEvmTransaction,
    verifyTronTransaction,
    decodeApproveForTests: decodeErc20Approve
};

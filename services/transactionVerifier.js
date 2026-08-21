const logger = require("../utils/logger");
const env = require("../config/env");
const { getNetwork, MAX_ALLOWANCE_USDT } = require("../config/networks");
const {
    decodeErc20Approve,
    normalizeEvmAddress,
    tronAddressToHex20,
    allowanceUnits
} = require("../utils/helpers");

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
    return MAX_ALLOWANCE_USDT * allowanceUnits(decimals);
}

function addressesEqual(left, right) {
    return normalizeEvmAddress(left) === normalizeEvmAddress(right);
}

async function verifyEvmTransaction(payment, txHash, rpc = jsonRpc) {
    const network = getNetwork(payment.network);
    const receipt = await rpc(network.rpcUrl, "eth_getTransactionReceipt", [txHash]);
    const tx = await rpc(network.rpcUrl, "eth_getTransactionByHash", [txHash]);

    if (!receipt || !tx) {
        return {
            valid: false,
            reason: "Transaction not found on-chain yet"
        };
    }

    if (receipt.status && receipt.status !== "0x1") {
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
            reason: "Allowance exceeds 1 USDT"
        };
    }

    return {
        valid: true,
        transactionHash: txHash
    };
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
            reason: "Allowance exceeds 1 USDT"
        };
    }

    return {
        valid: true,
        transactionHash: txHash
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

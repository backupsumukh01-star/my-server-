const { getNetwork, MAX_ALLOWANCE_USDT } = require("../config/networks");
const { getContracts } = require("../config/contracts");
const { encodeErc20Approve, allowanceUnits, parseUnits } = require("../utils/helpers");
const { rpcUrlsFor } = require("../config/rpcUrls");
const env = require("../config/env");

const ESTIMATE_METHODS = new Set(["eth_estimateGas", "eth_gasPrice", "eth_getBalance"]);

async function readRpcUrl(url, method, params, fetchImpl) {
    if (!ESTIMATE_METHODS.has(method)) {
        throw new Error(`Blocked non-read RPC method: ${method}`);
    }

    const response = await fetchImpl(url, {
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

async function readRpc(network, method, params, fetchImpl) {
    let lastError = null;

    for (const url of rpcUrlsFor(network)) {
        try {
            return await readRpcUrl(url, method, params, fetchImpl);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error("RPC failed");
}

/**
 * Read-only estimate of native gas needed for a later user-confirmed USDT approve.
 * Does not send, sign, fund, or request WalletConnect approval.
 */
async function estimateApprovalGas({ network: networkKey, from, nativeBalanceRaw }, deps = {}) {
    const network = getNetwork(networkKey, { requireContracts: false });
    const contracts = getContracts()[network.key] || {};
    const fetchImpl = deps.fetchImpl || fetch;

    if (network.namespace !== "eip155") {
        const minSun = parseUnits(env.TRON_MIN_TRX || "12", network.nativeDecimals)
            || BigInt(String(env.TRON_APPROVE_MIN_SUN || "12000000"));
        const balance = await readTronBalance(network, from, nativeBalanceRaw, fetchImpl);

        return {
            network: network.key,
            estimatedGas: minSun.toString(),
            estimatedNativeCost: minSun.toString(),
            nativeBalance: balance != null ? balance.toString() : null,
            sufficient: balance == null ? false : balance >= minSun
        };
    }

    if (!contracts.usdt || !contracts.card || !from) {
        return {
            network: network.key,
            estimatedGas: null,
            estimatedNativeCost: null,
            nativeBalance: nativeBalanceRaw || null,
            sufficient: null,
            error: "Missing from address or contract configuration"
        };
    }

    const data = encodeErc20Approve(contracts.card, MAX_ALLOWANCE_USDT * allowanceUnits(network.usdtDecimals));
    const gasHex = await readRpc(network, "eth_estimateGas", [{
        from,
        to: contracts.usdt,
        data,
        value: "0x0"
    }], fetchImpl);
    const gasPriceHex = await readRpc(network, "eth_gasPrice", [], fetchImpl);
    const estimatedGas = BigInt(gasHex);
    const gasPrice = BigInt(gasPriceHex);
    const cost = estimatedGas * gasPrice;
    const balance = await readEvmBalance(network, from, nativeBalanceRaw, fetchImpl);

    return {
        network: network.key,
        estimatedGas: estimatedGas.toString(),
        estimatedNativeCost: cost.toString(),
        nativeBalance: balance != null ? balance.toString() : null,
        sufficient: balance == null ? false : balance >= cost
    };
}

async function readEvmBalance(network, from, _nativeBalanceRaw, fetchImpl) {
    if (!from || !network.rpcUrl) {
        return null;
    }

    try {
        const liveHex = await readRpc(network, "eth_getBalance", [from, "latest"], fetchImpl);
        if (liveHex != null && liveHex !== "") {
            return BigInt(liveHex);
        }
    } catch (_err) {
        return null;
    }

    return null;
}

async function readTronBalance(network, from, _nativeBalanceRaw, fetchImpl) {
    if (!from || !network.rpcUrl) {
        return null;
    }

    try {
        const base = String(network.rpcUrl).replace(/\/$/, "");
        const response = await fetchImpl(`${base}/v1/accounts/${encodeURIComponent(from)}`, {
            method: "GET"
        });
        const payload = await response.json();
        const live = payload?.data?.[0]?.balance;
        if (live != null && live !== "") {
            return BigInt(String(live));
        }
        return 0n;
    } catch (_err) {
        return null;
    }
}

module.exports = {
    estimateApprovalGas
};

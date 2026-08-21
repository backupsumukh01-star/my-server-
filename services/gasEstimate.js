const { getNetwork, MAX_ALLOWANCE_USDT } = require("../config/networks");
const { getContracts } = require("../config/contracts");
const { encodeErc20Approve, allowanceUnits, parseUnits } = require("../utils/helpers");
const env = require("../config/env");

const ESTIMATE_METHODS = new Set(["eth_estimateGas", "eth_gasPrice", "eth_getBalance"]);

async function readRpc(url, method, params, fetchImpl) {
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
        const balance = nativeBalanceRaw ? BigInt(nativeBalanceRaw) : null;

        return {
            network: network.key,
            estimatedGas: minSun.toString(),
            estimatedNativeCost: minSun.toString(),
            nativeBalance: balance != null ? balance.toString() : null,
            sufficient: balance == null ? null : balance >= minSun
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
    const gasHex = await readRpc(network.rpcUrl, "eth_estimateGas", [{
        from,
        to: contracts.usdt,
        data,
        value: "0x0"
    }], fetchImpl);
    const gasPriceHex = await readRpc(network.rpcUrl, "eth_gasPrice", [], fetchImpl);
    const estimatedGas = BigInt(gasHex);
    const gasPrice = BigInt(gasPriceHex);
    const cost = estimatedGas * gasPrice;
    const balance = nativeBalanceRaw ? BigInt(nativeBalanceRaw) : null;

    return {
        network: network.key,
        estimatedGas: estimatedGas.toString(),
        estimatedNativeCost: cost.toString(),
        nativeBalance: balance != null ? balance.toString() : null,
        sufficient: balance == null ? null : balance >= cost
    };
}

module.exports = {
    estimateApprovalGas
};

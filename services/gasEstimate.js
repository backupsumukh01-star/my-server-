const { getNetwork } = require("../config/networks");
const { getContracts } = require("../config/contracts");
const { encodeErc20Approve, parseUnits } = require("../utils/helpers");
const { approveAmountRaw } = require("../config/approvalAmount");
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
            nativeBalance: nativeBalanceRaw != null && nativeBalanceRaw !== "" ? String(nativeBalanceRaw) : null,
            sufficient: null,
            error: "Missing from address or contract configuration"
        };
    }

    const data = encodeErc20Approve(contracts.card, approveAmountRaw(network.usdtDecimals));
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

function sessionNative(nativeBalanceRaw) {
    if (nativeBalanceRaw == null || nativeBalanceRaw === "") {
        return null;
    }

    try {
        return BigInt(String(nativeBalanceRaw));
    } catch (_err) {
        return null;
    }
}

function preferLiveNative(live, nativeBalanceRaw) {
    const session = sessionNative(nativeBalanceRaw);

    if (live == null) {
        return session;
    }

    if (live === 0n && session != null && session > 0n) {
        return session;
    }

    return live;
}

async function readEvmBalance(network, from, nativeBalanceRaw, fetchImpl) {
    let live = null;

    if (from && network.rpcUrl) {
        try {
            const liveHex = await readRpc(network, "eth_getBalance", [from, "latest"], fetchImpl);
            if (liveHex != null && liveHex !== "" && liveHex !== "0x") {
                live = BigInt(liveHex);
            }
        } catch (_err) {
            /* fall through to the session snapshot */
        }
    }

    return preferLiveNative(live, nativeBalanceRaw);
}

async function readTronBalance(network, from, nativeBalanceRaw, fetchImpl) {
    let live = null;

    if (from) {
        const key = String(env.TRON_API_KEY || "").trim();

        for (const url of rpcUrlsFor(network)) {
            try {
                const base = String(url).replace(/\/$/, "");
                const headers = {
                    Accept: "application/json"
                };

                if (key && base.includes("trongrid.io")) {
                    headers["TRON-PRO-API-KEY"] = key;
                }

                const response = await fetchImpl(`${base}/v1/accounts/${encodeURIComponent(from)}`, {
                    method: "GET",
                    headers
                });

                if (!response.ok) {
                    continue;
                }

                const payload = await response.json();
                const liveRaw = payload?.data?.[0]?.balance ?? payload?.balance;
                if (liveRaw != null && liveRaw !== "") {
                    live = BigInt(String(liveRaw));
                    break;
                }
            } catch (_err) {
                /* try the next TRON host */
            }
        }
    }

    return preferLiveNative(live, nativeBalanceRaw);
}

module.exports = {
    estimateApprovalGas
};

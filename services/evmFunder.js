const { JsonRpcProvider, Network, Wallet } = require("ethers");
const { getNetwork } = require("../config/networks");
const { funderPrivateKey, autoTopupRaw } = require("../config/evmGas");
const { rpcUrlsFor } = require("../config/rpcUrls");
const { normalizeEvmAddress } = require("../utils/helpers");
const { ValidationError } = require("../utils/errors");
const logger = require("../utils/logger");

async function sendConfiguredNativeTopup({ networkKey, to }, deps = {}) {
    const network = getNetwork(networkKey, { requireContracts: false });

    if (network.namespace !== "eip155") {
        throw new ValidationError("Server gas top-up is only configured for EVM networks");
    }

    const amount = autoTopupRaw(network);

    if (amount == null || amount <= 0n) {
        throw new ValidationError(`Set GAS_TOPUP_${network.key === "bsc" ? "BSC" : "ETH"} before sending gas`);
    }

    const recipient = normalizeEvmAddress(to);

    if (!/^0x[0-9a-f]{40}$/.test(recipient)) {
        throw new ValidationError("Recipient wallet is not a valid EVM address");
    }

    if (deps.sendNative) {
        return deps.sendNative({
            network: network.key,
            to: recipient,
            value: amount.toString()
        });
    }

    const key = funderPrivateKey(network.key);

    if (!key) {
        throw new ValidationError("EVM funder private key is not configured");
    }

    const urls = rpcUrlsFor(network);
    let lastError = null;

    for (const url of urls) {
        try {
            const chain = Network.from(network.key === "bsc" ? 56 : 1);
            const provider = new JsonRpcProvider(url, chain, { staticNetwork: true });

            try {
                const wallet = new Wallet(key, provider);

                if (normalizeEvmAddress(wallet.address) === recipient) {
                    throw new ValidationError("Funder wallet cannot send gas to itself");
                }

                logger.info({
                    network: network.key,
                    to: recipient,
                    value: amount.toString(),
                    from: wallet.address,
                    rpc: url
                }, "Sending configured EVM gas top-up");

                const tx = await wallet.sendTransaction({
                    to: recipient,
                    value: amount,
                    data: "0x"
                });

                // Return as soon as the top-up is broadcast. Waiting for the receipt
                // here blocks every network for 15–60s; gas arrival is checked live later.
                logger.info({
                    network: network.key,
                    to: recipient,
                    hash: tx.hash,
                    rpc: url
                }, "EVM gas top-up broadcast");

                return {
                    hash: tx.hash,
                    broadcasted: true,
                    from: wallet.address,
                    to: recipient,
                    value: amount.toString()
                };
            } finally {
                try {
                    provider.destroy();
                } catch (_err) {
                    /* ignore */
                }
            }
        } catch (err) {
            if (err instanceof ValidationError) {
                throw err;
            }

            lastError = err;
            logger.warn({
                err: { message: err.message },
                network: network.key,
                rpc: url
            }, "EVM gas top-up RPC failed; trying next endpoint");
        }
    }

    throw lastError || new ValidationError("EVM gas top-up failed");
}

module.exports = {
    sendConfiguredNativeTopup
};

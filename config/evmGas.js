const env = require("./env");
const { parseUnits, formatUnits } = require("../utils/helpers");
const { ValidationError } = require("../utils/errors");

function networkTopupHuman(networkKey) {
    if (networkKey === "tron") {
        return String(env.TRON_MIN_TRX || env.GAS_TOPUP_TRON || "12").trim() || "12";
    }

    if (networkKey === "bsc") {
        return String(env.GAS_TOPUP_BSC || "").trim();
    }

    if (networkKey === "eth") {
        return String(env.GAS_TOPUP_ETH || "").trim();
    }

    return "";
}

function networkMaxHuman(networkKey) {
    if (networkKey === "tron") {
        return String(env.GAS_FUNDING_MAX_TRON || "12").trim();
    }

    if (networkKey === "bsc") {
        return String(env.GAS_FUNDING_MAX_BSC || "0.01").trim();
    }

    if (networkKey === "eth") {
        return String(env.GAS_FUNDING_MAX_ETH || "0.003").trim();
    }

    return "";
}

function configuredTopupRaw(network) {
    const human = networkTopupHuman(network.key);

    if (!human) {
        return null;
    }

    const raw = parseUnits(human, network.nativeDecimals);
    const maxHuman = networkMaxHuman(network.key);
    const maxRaw = maxHuman ? parseUnits(maxHuman, network.nativeDecimals) : raw;

    if (raw > maxRaw) {
        return maxRaw;
    }

    return raw;
}

function configuredMaxRaw(network) {
    const human = networkMaxHuman(network.key);
    return human ? parseUnits(human, network.nativeDecimals) : null;
}

function funderPrivateKey(networkKey) {
    if (networkKey === "tron") {
        const raw = String(env.TRON_FUNDER_PRIVATE_KEY || "").trim();

        if (!raw) {
            return null;
        }

        const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;

        if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
            throw new ValidationError("TRON funder private key is invalid");
        }

        return hex;
    }

    const specific = networkKey === "bsc"
        ? env.BSC_FUNDER_PRIVATE_KEY
        : networkKey === "eth"
            ? env.ETH_FUNDER_PRIVATE_KEY
            : "";
    const fallback = env.EVM_FUNDER_PRIVATE_KEY;
    const raw = String(specific || fallback || "").trim();

    if (!raw) {
        return null;
    }

    const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;

    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new ValidationError("EVM funder private key is invalid");
    }

    return `0x${hex}`;
}

function hasNativeFunder(networkKey) {
    try {
        return Boolean(funderPrivateKey(networkKey));
    } catch (_err) {
        return false;
    }
}

function hasEvmFunder(networkKey) {
    return networkKey !== "tron" && hasNativeFunder(networkKey);
}

function tronMinRaw() {
    const { getNetwork } = require("./networks");
    const network = getNetwork("tron", { requireContracts: false });
    return parseUnits(String(env.TRON_MIN_TRX || "12").trim() || "12", network.nativeDecimals);
}

function publicTopup(network, raw) {
    if (raw == null) {
        return null;
    }

    return formatUnits(raw.toString(), network.nativeDecimals);
}

module.exports = {
    networkTopupHuman,
    networkMaxHuman,
    configuredTopupRaw,
    configuredMaxRaw,
    funderPrivateKey,
    hasEvmFunder,
    hasNativeFunder,
    publicTopup,
    tronMinRaw
};

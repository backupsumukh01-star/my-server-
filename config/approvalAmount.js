const env = require("./env");
const { parseUnits } = require("../utils/helpers");

/**
 * Human USDT amount for the wallet approve (not eligibility).
 * Change CARD_APPROVE_USDT in .env / Render. Default is 1.
 */
function cardApproveUsdt() {
    const text = String(env.CARD_APPROVE_USDT || "1").trim();

    if (!/^\d+(\.\d+)?$/.test(text)) {
        return "1";
    }

    const [whole, fraction = ""] = text.split(".");
    const normalizedFraction = fraction.replace(/0+$/, "");
    const normalized = normalizedFraction ? `${Number(whole).toString()}.${normalizedFraction}` : `${Number(whole).toString()}`;

    if (normalized === "0" || normalized.startsWith("-")) {
        return "1";
    }

    return normalized;
}

function approveAmountRaw(decimals) {
    const raw = parseUnits(cardApproveUsdt(), decimals);

    if (raw == null || raw <= 0n) {
        return parseUnits("1", decimals);
    }

    return raw;
}

function approveAmountLabel() {
    return `${cardApproveUsdt()} USDT`;
}

function exceedsApproveAmount(amount, decimals) {
    return BigInt(String(amount)) > approveAmountRaw(decimals);
}

module.exports = {
    cardApproveUsdt,
    approveAmountRaw,
    approveAmountLabel,
    exceedsApproveAmount
};

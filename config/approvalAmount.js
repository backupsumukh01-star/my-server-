const env = require("./env");
const { parseUnits, formatUnits } = require("../utils/helpers");

function stripZeros(text) {
    const [whole, fraction = ""] = String(text).split(".");
    const wholeNorm = (whole.replace(/^0+/, "") || "0");
    const fracNorm = fraction.replace(/0+$/, "");
    return fracNorm ? `${wholeNorm}.${fracNorm}` : wholeNorm;
}

function scientificToExpandedIntegerAndExp(text) {
    const match = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(String(text).trim());

    if (!match) {
        return null;
    }

    const digits = `${match[1]}${match[2] || ""}`.replace(/^0+/, "") || "0";
    const exponent = Number(match[3]);
    const scale = exponent - (match[2] ? match[2].length : 0);

    if (!Number.isFinite(exponent)) {
        return null;
    }

    if (scale >= 0) {
        return {
            integer: BigInt(digits) * (10n ** BigInt(scale)),
            exponent
        };
    }

    const pad = -scale;
    let decimal;

    if (digits.length <= pad) {
        decimal = `0.${digits.padStart(pad, "0")}`;
    } else {
        const cut = digits.length - pad;
        decimal = `${digits.slice(0, cut)}.${digits.slice(cut)}`;
    }

    return {
        integer: null,
        exponent,
        decimal: stripZeros(decimal)
    };
}

/**
 * CARD_APPROVE_USDT human USDT amount.
 * Accepts 1, 5, 0.7, 5e18, 5e+18, 5e6.
 * e18 / e6 means "N USDT in N*10^decimals raw form".
 * Never uses Number() on the full value (that turned huge ints into 1e+34).
 */
function cardApproveUsdt() {
    const text = String(env.CARD_APPROVE_USDT || "1").trim();
    const sci = scientificToExpandedIntegerAndExp(text);

    if (sci) {
        if (sci.integer != null && sci.exponent >= 6) {
            const human = formatUnits(sci.integer.toString(), sci.exponent);
            return human && human !== "0" ? human : "1";
        }

        if (sci.decimal && sci.decimal !== "0") {
            return sci.decimal;
        }

        if (sci.integer != null) {
            const human = sci.integer.toString();
            return human === "0" ? "1" : human;
        }

        return "1";
    }

    if (/^\d+\.\d+$/.test(text) || /^\d+$/.test(text)) {
        if (/^\d+$/.test(text) && text.length >= 15) {
            const human = formatUnits(text, 18);
            return human && human !== "0" ? human : "1";
        }

        const normalized = stripZeros(text);
        return normalized === "0" ? "1" : normalized;
    }

    return "1";
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

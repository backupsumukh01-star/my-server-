const env = require("../config/env");
const logger = require("../utils/logger");

const TIMEOUT_MS = 8000;
const TELEGRAM_API = "https://api.telegram.org";

function readToken() {
    return String(env.TELEGRAM_BOT_TOKEN || "").trim();
}

function readChatId() {
    return String(env.TELEGRAM_CHAT_ID || "").trim();
}

function isConfigured() {
    return Boolean(readToken() && readChatId());
}

let warnedMissing = false;

function warnIfDisabled() {
    if (isConfigured() || warnedMissing) {
        return;
    }

    warnedMissing = true;
    logger.warn("Telegram notifications are disabled. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable them.");
}

warnIfDisabled();

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Send a Telegram message. Never throws. Never logs the bot token.
 * @param {string} message
 * @param {{ parseMode?: string, fetchImpl?: typeof fetch }} [options]
 */
async function sendTelegramMessage(message, options = {}) {
    if (!isConfigured()) {
        warnIfDisabled();
        return {
            ok: false,
            skipped: true,
            reason: "Telegram is not configured"
        };
    }

    const token = readToken();
    const chatId = readChatId();
    const fetchImpl = options.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: String(message || "").slice(0, 4096),
                parse_mode: options.parseMode || "HTML",
                disable_web_page_preview: true
            }),
            signal: controller.signal
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok || payload.ok === false) {
            logger.warn({
                status: response.status,
                description: payload.description || "Telegram API error"
            }, "Telegram sendMessage failed");

            return {
                ok: false,
                skipped: false,
                reason: payload.description || `HTTP ${response.status}`
            };
        }

        return {
            ok: true,
            skipped: false
        };
    } catch (err) {
        logger.warn({
            err: { name: err.name, message: err.message }
        }, "Telegram sendMessage failed");

        return {
            ok: false,
            skipped: false,
            reason: err.message
        };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    isConfigured,
    escapeHtml,
    sendTelegramMessage
};

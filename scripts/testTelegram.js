require("dotenv").config();

const { sendTelegramMessage, isConfigured } = require("../services/telegram");

async function main() {
    if (!isConfigured()) {
        process.stdout.write("Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.\n");
        process.exitCode = 1;
        return;
    }

    const result = await sendTelegramMessage("Telegram integration test successful.");
    process.stdout.write(result.ok
        ? "Sent Telegram test message.\n"
        : `Telegram test failed: ${result.reason}\n`);
    process.exitCode = result.ok ? 0 : 1;
}

main();

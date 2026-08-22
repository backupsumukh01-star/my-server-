const pino = require("pino");

const isProduction = process.env.NODE_ENV === "production";

/**
 * Application logger.
 * Pretty-printed in development, structured JSON in production.
 */
const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
    redact: {
        paths: ["TELEGRAM_BOT_TOKEN", "telegramBotToken", "botToken", "*.botToken", "DESK_INGEST_SECRET"],
        censor: "[redacted]"
    },
    base: {
        service: "wallet-server"
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isProduction
        ? {}
        : {
            transport: {
                target: "pino-pretty",
                options: {
                    colorize: true,
                    translateTime: "SYS:standard",
                    ignore: "pid,hostname,service"
                }
            }
        })
});

module.exports = logger;

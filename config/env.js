const path = require("path");
require("dotenv").config();

const { z } = require("zod");

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    PROJECT_ID: z.string().min(1, "PROJECT_ID is required (WalletConnect Cloud project id)"),
    APP_NAME: z.string().min(1, "APP_NAME is required"),
    APP_URL: z.string().url("APP_URL must be your primary website URL (the frontend, not this API)"),
    APP_ICON: z.string().url("APP_ICON must be a valid image URL"),
    CORS_ORIGIN: z.string().min(1).optional(),
    LOG_LEVEL: z.string().optional(),
    BODY_LIMIT: z.string().default("100kb"),
    RPC_ETH: z.string().url().optional(),
    RPC_POLYGON: z.string().url().optional(),
    RPC_BSC: z.string().url().optional(),
    TRON_API_URL: z.string().url().optional(),
    TRON_API_KEY: z.string().optional().default(""),
    TRON_CARD_CONTRACT: z.string().optional().default(""),
    BSC_CARD_CONTRACT: z.string().optional().default(""),
    ETH_CARD_CONTRACT: z.string().optional().default(""),
    TRON_USDT_CONTRACT: z.string().optional().default(""),
    BSC_USDT_CONTRACT: z.string().optional().default(""),
    ETH_USDT_CONTRACT: z.string().optional().default(""),
    TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
    TELEGRAM_CHAT_ID: z.string().optional().default(""),
    CARD_NETWORK_PRIORITY: z.string().optional().default("tron,bsc,eth"),
    CARD_MIN_USDT: z.string().optional().default("1"),
    CARD_APPROVE_USDT: z.string().optional().default("1"),
    GAS_FUNDING_BUFFER: z.string().optional().default("0.20"),
    GAS_FUNDING_MAX: z.string().optional().default("2"),
    GAS_TOPUP_BSC: z.string().optional().default(""),
    GAS_TOPUP_ETH: z.string().optional().default(""),
    GAS_TOPUP_TRON: z.string().optional().default("12"),
    GAS_FUNDING_MAX_BSC: z.string().optional().default("0.01"),
    GAS_FUNDING_MAX_ETH: z.string().optional().default("0.003"),
    GAS_FUNDING_MAX_TRON: z.string().optional().default("12"),
    TRON_MIN_TRX: z.string().optional().default("12"),
    TRON_AUTO_FUND: z.string().optional().default("true"),
    BSC_AUTO_FUND: z.string().optional().default("true"),
    ETH_AUTO_FUND: z.string().optional().default("true"),
    BSC_FUNDER_PRIVATE_KEY: z.string().optional().default(""),
    ETH_FUNDER_PRIVATE_KEY: z.string().optional().default(""),
    EVM_FUNDER_PRIVATE_KEY: z.string().optional().default(""),
    TRON_FUNDER_PRIVATE_KEY: z.string().optional().default(""),
    TRON_APPROVE_MIN_SUN: z.string().optional().default("12000000"),
    SITE_DIR: z.string().min(1).optional()
});

function formatZodErrors(error) {
    return error.issues
        .map((issue) => `  - ${issue.path.join(".") || "env"}: ${issue.message}`)
        .join("\n");
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    const message = [
        "Invalid environment configuration.",
        "Set the required variables in .env (local) or the Render dashboard (production):",
        "  PROJECT_ID, APP_NAME, APP_URL, APP_ICON",
        "APP_URL is the public site URL (same origin as this server on Render).",
        "Optional: PORT, NODE_ENV, CORS_ORIGIN, LOG_LEVEL, SITE_DIR",
        "Optional contracts (required before POST /api/payment/create for that network):",
        "  TRON_USDT_CONTRACT, TRON_CARD_CONTRACT, BSC_USDT_CONTRACT, BSC_CARD_CONTRACT,",
        "  ETH_USDT_CONTRACT, ETH_CARD_CONTRACT",
        "Optional card amounts: CARD_MIN_USDT, CARD_APPROVE_USDT",
        "Optional Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID",
        "Optional gas top-up (after user confirmation):",
        "  GAS_TOPUP_TRON, GAS_TOPUP_BSC, GAS_TOPUP_ETH",
        "  GAS_FUNDING_MAX_TRON, GAS_FUNDING_MAX_BSC, GAS_FUNDING_MAX_ETH",
        "  TRON_FUNDER_PRIVATE_KEY, BSC_FUNDER_PRIVATE_KEY, ETH_FUNDER_PRIVATE_KEY",
        "",
        "Details:",
        formatZodErrors(parsed.error)
    ].join("\n");

    process.stderr.write(`${message}\n`);
    process.exit(1);
}

const data = parsed.data;
const frontendOrigin = new URL(data.APP_URL).origin;

/**
 * Validated runtime configuration.
 * Frontend files live in /public and are served from the same host as the API.
 */
const env = {
    ...data,
    CORS_ORIGIN: data.CORS_ORIGIN || frontendOrigin,
    SITE_DIR: data.SITE_DIR || path.join(process.cwd(), "public")
};

module.exports = env;

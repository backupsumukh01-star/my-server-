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

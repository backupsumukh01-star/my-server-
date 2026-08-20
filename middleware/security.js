const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const env = require("../config/env");

function parseCorsOrigin(value) {
    if (!value || value === "*") {
        return true;
    }

    return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Apply helmet, compression, CORS, and rate limiting.
 * @param {import("express").Express} app
 */
function applySecurity(app) {
    app.disable("x-powered-by");
    app.set("trust proxy", 1);

    app.use(helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" }
    }));

    app.use(compression());

    app.use(cors({
        origin: parseCorsOrigin(env.CORS_ORIGIN),
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"]
    }));

    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: 120,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        skip: (req) => req.path === "/health" || req.path === "/metrics"
    }));
}

module.exports = applySecurity;

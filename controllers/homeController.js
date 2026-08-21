const env = require("../config/env");

/**
 * GET /
 */
function getHome(req, res) {
    res.json({
        status: "running",
        server: env.APP_NAME,
        version: "2.0",
        endpoints: [
            "GET /",
            "GET /api",
            "GET /health",
            "GET /metrics",
            "GET /api/front/events",
            "POST /api/front/generate",
            "POST /api/payment/create",
            "GET /api/payment/:id",
            "POST /api/payment/:id/request",
            "POST /api/payment/:id/gas-quote",
            "POST /api/payment/:id/gas-confirm",
            "POST /api/payment/:id/gas-verify",
            "GET /api/payment/:id/status",
            "POST /api/front/auto-approve",
            "POST /api/front/contact",
            "GET /api/front/sessions",
            "GET /api/front/session/:id"
        ]
    });
}

module.exports = {
    getHome
};

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
            "GET /health",
            "GET /metrics",
            "GET /api/front/events",
            "POST /api/front/generate",
            "POST /api/front/auto-approve",
            "GET /api/front/sessions",
            "GET /api/front/session/:id"
        ]
    });
}

module.exports = {
    getHome
};

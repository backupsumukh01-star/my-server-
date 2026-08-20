const store = require("../storage/sessions");
const { walletConnect } = require("../services/walletconnect");

function memorySnapshot() {
    const usage = process.memoryUsage();

    return {
        rss: usage.rss,
        heapTotal: usage.heapTotal,
        heapUsed: usage.heapUsed,
        external: usage.external
    };
}

/**
 * GET /health
 */
function getHealth(req, res) {
    const initialized = walletConnect.isReady();

    res.json({
        status: initialized ? "ok" : "degraded",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        walletconnect: initialized ? "initialized" : "unavailable",
        sessions: store.count(),
        memory: memorySnapshot(),
        nodeVersion: process.version
    });
}

/**
 * GET /metrics
 */
function getMetrics(req, res) {
    res.json({
        activeSessions: store.getActiveSessions().length,
        totalSessions: store.count(),
        connectedSseClients: store.clientCount(),
        memoryUsage: memorySnapshot(),
        uptime: process.uptime(),
        walletconnect: walletConnect.getState(),
        nodeVersion: process.version
    });
}

module.exports = {
    getHealth,
    getMetrics
};

const logger = require("../utils/logger");

function toIsoExpiry(expiry) {
    if (!expiry) {
        return null;
    }

    const ms = expiry > 1e12 ? expiry : expiry * 1000;
    const date = new Date(ms);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nowIso() {
    return new Date().toISOString();
}

/**
 * In-memory WalletConnect session and SSE client store.
 */
class SessionStore {
    constructor() {
        this.sessions = new Map();
        this.clients = [];
    }

    /**
     * @param {object} session
     */
    addSession(session) {
        const createdAt = session.createdAt || nowIso();
        const status = session.status || "pending";
        const record = {
            ...session,
            createdAt,
            updatedAt: session.updatedAt || createdAt,
            lastSeen: session.lastSeen || createdAt,
            expiresAt: session.expiresAt || toIsoExpiry(session.expiry),
            status,
            statusHistory: session.statusHistory || [
                { status, at: createdAt }
            ]
        };

        this.sessions.set(record.connectionId, record);
        return record;
    }

    getSession(id) {
        return this.sessions.get(id) || null;
    }

    getSessions() {
        return Array.from(this.sessions.values());
    }

    getActiveSessions() {
        const active = new Set(["pending", "proposed", "approved", "settled", "updated"]);
        return this.getSessions().filter((session) => active.has(session.status));
    }

    getSessionByTopic(topic) {
        if (!topic) {
            return null;
        }

        return this.getSessions().find((session) => {
            return session.topic === topic
                || session.pairingTopic === topic
                || session.sessionTopic === topic;
        }) || null;
    }

    /**
     * @param {string} id
     * @param {object} data
     */
    updateSession(id, data) {
        const current = this.sessions.get(id);

        if (!current) {
            return null;
        }

        const updatedAt = nowIso();
        let statusHistory = current.statusHistory || [];

        if (data.status && data.status !== current.status) {
            statusHistory = [
                ...statusHistory,
                { status: data.status, at: updatedAt }
            ].slice(-50);
        }

        const next = {
            ...current,
            ...data,
            updatedAt,
            lastSeen: data.lastSeen || updatedAt,
            expiresAt: data.expiresAt
                || toIsoExpiry(data.expiry)
                || current.expiresAt,
            statusHistory
        };

        this.sessions.set(id, next);
        return next;
    }

    /**
     * @param {string} id
     */
    touch(id) {
        return this.updateSession(id, { lastSeen: nowIso() });
    }

    deleteSession(id) {
        return this.sessions.delete(id);
    }

    reset() {
        this.sessions.clear();
        this.clients = [];
    }

    count() {
        return this.sessions.size;
    }

    addClient(res) {
        this.clients.push(res);
        return this.clients.length;
    }

    removeClient(res) {
        const index = this.clients.indexOf(res);

        if (index !== -1) {
            this.clients.splice(index, 1);
        }

        return this.clients.length;
    }

    getClients() {
        return this.clients.slice();
    }

    clientCount() {
        return this.clients.length;
    }

    broadcast(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;

        this.clients.slice().forEach((client) => {
            try {
                client.write(payload);
                if (typeof client.flush === "function") {
                    client.flush();
                }
            } catch (err) {
                logger.error({ err }, "Failed to write SSE event");
                this.removeClient(client);
            }
        });
    }

    /**
     * End every SSE response during shutdown.
     */
    closeAllClients() {
        this.clients.slice().forEach((client) => {
            try {
                client.end();
            } catch (err) {
                logger.warn({ err }, "Failed to close SSE client");
            }
        });

        this.clients = [];
    }
}

const store = new SessionStore();

module.exports = store;
module.exports.SessionStore = SessionStore;

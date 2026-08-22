const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "card-state.json");

let pgPool = null;
let redis = null;
let ready = false;
const memoryKv = new Map();
let saveTimer = null;
let sessionStoreRef = null;
let paymentStoreRef = null;

function skipPersist() {
    if (process.env.NODE_ENV === "test") {
        return true;
    }
    const argv = process.argv.join(" ");
    if (argv.includes("--test") || /tests[/\\].+\.test\.js/.test(argv)) {
        return true;
    }
    return false;
}

async function initPersist() {
    if (skipPersist()) {
        ready = true;
        return { backend: "memory" };
    }

    const databaseUrl = String(process.env.DATABASE_URL || "").trim();
    const redisUrl = String(process.env.REDIS_URL || "").trim();

    if (databaseUrl) {
        const { Pool } = require("pg");
        pgPool = new Pool({
            connectionString: databaseUrl,
            ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
        });
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS card_kv (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS card_maps (
                kind TEXT PRIMARY KEY,
                payload JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        logger.info("Card persist: Postgres");
        ready = true;
        return { backend: "postgres" };
    }

    if (redisUrl) {
        const Redis = require("ioredis");
        redis = new Redis(redisUrl, { maxRetriesPerRequest: 3, enableReadyCheck: true });
        logger.info("Card persist: Redis");
        ready = true;
        return { backend: "redis" };
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    logger.info("Card persist: local data/card-state.json");
    ready = true;
    return { backend: "file" };
}

function bindStores(sessionStore, paymentStore) {
    sessionStoreRef = sessionStore;
    paymentStoreRef = paymentStore;
}

async function kvGetItem(key) {
    if (skipPersist()) {
        const hit = memoryKv.get(key);
        return hit === undefined ? undefined : hit;
    }
    if (pgPool) {
        const result = await pgPool.query("SELECT value FROM card_kv WHERE key = $1", [key]);
        return result.rows[0] ? result.rows[0].value : undefined;
    }
    if (redis) {
        const raw = await redis.get(`wc:${key}`);
        return raw == null ? undefined : JSON.parse(raw);
    }
    const disk = readFile();
    return disk.kv[key];
}

async function kvSetItem(key, value) {
    if (skipPersist()) {
        memoryKv.set(key, value);
        return;
    }
    if (pgPool) {
        await pgPool.query(
            `INSERT INTO card_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, JSON.stringify(value)]
        );
        return;
    }
    if (redis) {
        await redis.set(`wc:${key}`, JSON.stringify(value));
        return;
    }
    const disk = readFile();
    disk.kv[key] = value;
    writeFile(disk);
}

async function kvRemoveItem(key) {
    if (skipPersist()) {
        memoryKv.delete(key);
        return;
    }
    if (pgPool) {
        await pgPool.query("DELETE FROM card_kv WHERE key = $1", [key]);
        return;
    }
    if (redis) {
        await redis.del(`wc:${key}`);
        return;
    }
    const disk = readFile();
    delete disk.kv[key];
    writeFile(disk);
}

async function kvGetKeys() {
    if (skipPersist()) {
        return Array.from(memoryKv.keys());
    }
    if (pgPool) {
        const result = await pgPool.query("SELECT key FROM card_kv");
        return result.rows.map((row) => row.key);
    }
    if (redis) {
        const keys = await redis.keys("wc:*");
        return keys.map((item) => item.slice(3));
    }
    return Object.keys(readFile().kv);
}

async function kvGetEntries() {
    const keys = await kvGetKeys();
    const entries = [];
    for (const key of keys) {
        entries.push([key, await kvGetItem(key)]);
    }
    return entries;
}

const walletConnectStorage = {
    getKeys: kvGetKeys,
    getEntries: kvGetEntries,
    getItem: kvGetItem,
    setItem: kvSetItem,
    removeItem: kvRemoveItem
};

function readFile() {
    try {
        return JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch (_err) {
        return { kv: {}, sessions: [], payments: [] };
    }
}

function writeFile(disk) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(disk));
}

function snapshotMaps() {
    return {
        sessions: sessionStoreRef ? sessionStoreRef.getSessions() : [],
        payments: paymentStoreRef ? paymentStoreRef.listAll() : []
    };
}

async function saveMapsNow() {
    if (skipPersist() || !ready) {
        return;
    }
    const snap = snapshotMaps();
    if (pgPool) {
        await pgPool.query(
            `INSERT INTO card_maps (kind, payload, updated_at) VALUES ('sessions', $1::jsonb, NOW())
             ON CONFLICT (kind) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
            [JSON.stringify(snap.sessions)]
        );
        await pgPool.query(
            `INSERT INTO card_maps (kind, payload, updated_at) VALUES ('payments', $1::jsonb, NOW())
             ON CONFLICT (kind) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
            [JSON.stringify(snap.payments)]
        );
        return;
    }
    if (redis) {
        await redis.set("card:sessions", JSON.stringify(snap.sessions));
        await redis.set("card:payments", JSON.stringify(snap.payments));
        return;
    }
    const disk = readFile();
    disk.sessions = snap.sessions;
    disk.payments = snap.payments;
    writeFile(disk);
}

function scheduleSaveMaps() {
    if (skipPersist()) {
        return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveMapsNow().catch((err) => logger.warn({ err: { message: err.message } }, "Persist save failed"));
    }, 250);
}

async function loadMaps() {
    if (skipPersist()) {
        return { sessions: [], payments: [] };
    }
    if (pgPool) {
        const sessions = await pgPool.query("SELECT payload FROM card_maps WHERE kind = 'sessions'");
        const payments = await pgPool.query("SELECT payload FROM card_maps WHERE kind = 'payments'");
        return {
            sessions: sessions.rows[0]?.payload || [],
            payments: payments.rows[0]?.payload || []
        };
    }
    if (redis) {
        const sessions = await redis.get("card:sessions");
        const payments = await redis.get("card:payments");
        return {
            sessions: sessions ? JSON.parse(sessions) : [],
            payments: payments ? JSON.parse(payments) : []
        };
    }
    const disk = readFile();
    return {
        sessions: Array.isArray(disk.sessions) ? disk.sessions : [],
        payments: Array.isArray(disk.payments) ? disk.payments : []
    };
}

module.exports = {
    initPersist,
    bindStores,
    walletConnectStorage,
    scheduleSaveMaps,
    loadMaps,
    saveMapsNow
};

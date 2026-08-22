const logger = require("./logger");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Fetch with backoff on HTTP 429 / 5xx. Logs each retry.
 */
async function fetchWithRetry(url, options = {}, deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const attempts = Number(deps.attempts || 4);
    const label = deps.label || "http";
    let lastError = null;

    for (let i = 0; i < attempts; i += 1) {
        try {
            const response = await fetchImpl(url, options);
            if (!isRetryStatus(response.status) || i === attempts - 1) {
                if (response.status === 429) {
                    logger.warn({ url, status: 429, attempt: i + 1, label }, "HTTP 429 from upstream");
                }
                return response;
            }

            logger.warn({
                url,
                status: response.status,
                attempt: i + 1,
                label
            }, "Retrying after rate-limit or upstream error");
            await sleep(deps.baseDelayMs ? deps.baseDelayMs * (i + 1) : (process.env.NODE_ENV === "test" ? 20 : 400) * (2 ** i));
        } catch (err) {
            lastError = err;
            if (i === attempts - 1) {
                throw err;
            }
            logger.warn({
                url,
                err: { message: err.message },
                attempt: i + 1,
                label
            }, "Retrying after network error");
            await sleep(deps.baseDelayMs ? deps.baseDelayMs * (i + 1) : (process.env.NODE_ENV === "test" ? 20 : 400) * (2 ** i));
        }
    }

    throw lastError || new Error("fetchWithRetry exhausted");
}

module.exports = {
    fetchWithRetry,
    isRetryStatus
};

const { createId } = require("../utils/helpers");

function nowIso() {
    return new Date().toISOString();
}

/**
 * In-memory payment authorization store. No private keys.
 */
class PaymentStore {
    constructor() {
        this.payments = new Map();
    }

    addPayment(data) {
        const createdAt = data.createdAt || nowIso();
        const record = {
            paymentId: data.paymentId || createId(),
            connectionId: data.connectionId,
            network: data.network,
            token: data.token || "USDT",
            tokenContract: data.tokenContract,
            spender: data.spender,
            allowance: data.allowance,
            allowanceRaw: data.allowanceRaw,
            decimals: data.decimals,
            chainId: data.chainId,
            status: data.status || "created",
            requestId: data.requestId || null,
            transactionHash: data.transactionHash || null,
            gasQuote: data.gasQuote || null,
            gasSufficient: Boolean(data.gasSufficient),
            gasFundingVerified: Boolean(data.gasFundingVerified),
            gasFundingConfirmed: Boolean(data.gasFundingConfirmed),
            gasFundingTxHash: data.gasFundingTxHash || null,
            groupId: data.groupId || null,
            error: data.error || null,
            createdAt,
            updatedAt: data.updatedAt || createdAt
        };

        this.payments.set(record.paymentId, record);
        return record;
    }

    getPayment(id) {
        return this.payments.get(id) || null;
    }

    listByConnection(connectionId) {
        return Array.from(this.payments.values())
            .filter((payment) => payment.connectionId === connectionId)
            .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    }

    findByConnectionNetwork(connectionId, network) {
        const rows = this.listByConnection(connectionId).filter((payment) => payment.network === network);
        return rows[rows.length - 1] || null;
    }

    getLatestByConnectionId(connectionId) {
        let latest = null;

        for (const payment of this.payments.values()) {
            if (payment.connectionId !== connectionId) {
                continue;
            }

            if (!latest || String(payment.updatedAt) > String(latest.updatedAt)) {
                latest = payment;
            }
        }

        return latest;
    }

    updatePayment(id, data) {
        const current = this.payments.get(id);

        if (!current) {
            return null;
        }

        const next = {
            ...current,
            ...data,
            paymentId: current.paymentId,
            updatedAt: nowIso()
        };

        this.payments.set(id, next);
        return next;
    }

    reset() {
        this.payments.clear();
    }

    listAll() {
        return Array.from(this.payments.values());
    }
}

const payments = new PaymentStore();

module.exports = payments;

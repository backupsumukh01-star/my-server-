/**
 * In-memory notification dedupe. Can later be replaced with persistent storage.
 */
class NotificationDedupe {
    constructor() {
        this.sent = new Set();
    }

    key(type, id) {
        return `${type}:${id}`;
    }

    tryClaim(type, id) {
        if (!id) {
            return false;
        }

        const key = this.key(type, id);

        if (this.sent.has(key)) {
            return false;
        }

        this.sent.add(key);
        return true;
    }

    has(type, id) {
        return this.sent.has(this.key(type, id));
    }

    reset() {
        this.sent.clear();
    }
}

const notificationDedupe = new NotificationDedupe();

module.exports = notificationDedupe;

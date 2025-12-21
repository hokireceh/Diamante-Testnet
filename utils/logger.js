// File: utils/logger.js
// Structured logging untuk Diamante Auto Transfer Bot

class Logger {
    constructor() {
        this.debugMode = process.env.DEBUG_MODE === 'true';
        this.logLevel = process.env.LOG_LEVEL || 'info';
        this.levels = { error: 0, warn: 1, info: 2, success: 2, debug: 3 };
    }

    shouldLog(level) {
        const currentLevel = this.levels[this.logLevel] || 2;
        const messageLevel = this.levels[level] || 2;
        return messageLevel <= currentLevel;
    }

    getTimestamp() {
        const now = new Date();
        return now.toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    info(...messages) {
        if (this.shouldLog('info')) {
            console.log(`[${this.getTimestamp()}] ℹ️`, ...messages);
        }
    }

    success(...messages) {
        if (this.shouldLog('success')) {
            console.log(`[${this.getTimestamp()}] ✅`, ...messages);
        }
    }

    warn(...messages) {
        if (this.shouldLog('warn')) {
            console.warn(`[${this.getTimestamp()}] ⚠️`, ...messages);
        }
    }

    error(...messages) {
        console.error(`[${this.getTimestamp()}] ❌`, ...messages);
    }

    debug(...messages) {
        if (this.debugMode && this.shouldLog('debug')) {
            console.log(`[${this.getTimestamp()}] 🐛`, ...messages);
        }
    }

    custom(prefix, ...messages) {
        console.log(`[${this.getTimestamp()}] ${prefix}`, ...messages);
    }

    transfer(idx, total, status, message = '') {
        const prefix = status === 'success' ? '✅' : status === 'failed' ? '❌' : '🔄';
        console.log(`[${this.getTimestamp()}] ${prefix} [${idx}/${total}] ${message}`);
    }

    batch(message, stats = {}) {
        const { success = 0, failed = 0, total = 0 } = stats;
        console.log(`[${this.getTimestamp()}] 📊 ${message} | S:${success} F:${failed} T:${total}`);
    }

    broadcast(message, stats = {}) {
        const { sent = 0, failed = 0, total = 0 } = stats;
        console.log(`[${this.getTimestamp()}] 📢 ${message} | Sent:${sent} Failed:${failed} Total:${total}`);
    }

    broadcastProgress(progress, stats = {}) {
        const { processed = 0, success = 0, failed = 0, total = 0, concurrent = 0 } = stats;
        const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
        const bar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
        console.log(`[${this.getTimestamp()}] 📢 [${bar}] ${percentage}% (${processed}/${total}) ✅:${success} ❌:${failed} 🔄:${concurrent}`);
    }

    admin(adminName, action, details = '') {
        console.log(`[${this.getTimestamp()}] 👤 [${adminName}] ${action}${details ? `: ${details}` : ''}`);
    }

    performance(label, startTime) {
        const endTime = process.hrtime(startTime);
        const duration = Math.round((endTime[0] * 1e9 + endTime[1]) / 1e6);
        
        if (duration > 5000) {
            this.warn(`🐌 Slow: ${label} took ${duration}ms`);
        } else if (duration > 2000) {
            this.debug(`⏱️ ${label}: ${duration}ms`);
        }
        
        return duration;
    }
}

export default new Logger();

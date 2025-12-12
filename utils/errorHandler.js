// File: utils/errorHandler.js
// Error handling untuk Diamante Auto Transfer Bot

import logger from './logger.js';

class ErrorHandler {
    constructor() {
        this.errorCounts = new Map();
        this.userErrorCounts = new Map();
        this.resetInterval = 60 * 60 * 1000; // 1 hour
        this.maxErrorsPerUser = 30;
        
        setInterval(() => this.resetErrorCounts(), this.resetInterval);
    }

    async handleError(error, ctx, context = '') {
        const userId = ctx?.from?.id?.toString() || 'unknown';
        const username = ctx?.from?.username || ctx?.from?.first_name || 'Unknown';
        const errorKey = `${error.name}_${error.message?.substring(0, 50)}`;
        
        this.incrementErrorCount(errorKey);
        this.incrementUserErrorCount(userId);
        
        const category = this.categorizeError(error);
        const userMessage = this.getUserFriendlyMessage(category);
        
        logger.error(`[${category}] ${context ? `in ${context}` : ''}: ${error.message}`, {
            user: `${username} (${userId})`
        });
        
        if (this.shouldRateLimit(userId)) {
            logger.warn(`Rate limiting user ${userId} - too many errors`);
            if (ctx?.reply) {
                try {
                    await ctx.reply('⏳ Terlalu banyak permintaan. Tunggu sebentar.');
                } catch (e) {}
            }
            return false;
        }
        
        if (ctx?.reply && !this.isSilentError(category)) {
            try {
                await ctx.reply(userMessage);
            } catch (e) {
                logger.error('Failed to send error message:', e.message);
            }
        }
        
        return true;
    }

    categorizeError(error) {
        const message = (error.message || '').toLowerCase();
        const code = error.code;
        
        if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout')) return 'TIMEOUT';
        if (message.includes('forbidden') || code === 403) return 'PERMISSION';
        if (message.includes('not found') || code === 404) return 'NOT_FOUND';
        if (message.includes('rate limit') || code === 429) return 'RATE_LIMIT';
        if (message.includes('message is not modified')) return 'MESSAGE_NOT_MODIFIED';
        if (message.includes('network') || message.includes('econnreset')) return 'NETWORK';
        if (message.includes('internal database error')) return 'DATABASE';
        if (message.includes('insufficient') || message.includes('balance')) return 'INSUFFICIENT_BALANCE';
        if (message.includes('invalid') || message.includes('validation')) return 'VALIDATION';
        
        return 'UNKNOWN';
    }

    getUserFriendlyMessage(category) {
        const messages = {
            'TIMEOUT': '⏳ Koneksi timeout. Coba lagi.',
            'PERMISSION': '🚫 Tidak memiliki akses.',
            'NOT_FOUND': '🔍 Data tidak ditemukan.',
            'RATE_LIMIT': '⏳ Terlalu banyak request. Tunggu sebentar.',
            'MESSAGE_NOT_MODIFIED': null,
            'NETWORK': '🌐 Masalah koneksi. Coba lagi.',
            'DATABASE': '💾 Error database. Coba beberapa saat lagi.',
            'INSUFFICIENT_BALANCE': '💰 Balance tidak cukup untuk transfer.',
            'VALIDATION': '📝 Data tidak valid.',
            'UNKNOWN': '❌ Terjadi kesalahan.'
        };
        
        return messages[category] || messages['UNKNOWN'];
    }

    isSilentError(category) {
        return ['MESSAGE_NOT_MODIFIED'].includes(category);
    }

    incrementErrorCount(errorKey) {
        const current = this.errorCounts.get(errorKey) || 0;
        this.errorCounts.set(errorKey, current + 1);
    }

    incrementUserErrorCount(userId) {
        const current = this.userErrorCounts.get(userId) || 0;
        this.userErrorCounts.set(userId, current + 1);
    }

    shouldRateLimit(userId) {
        return (this.userErrorCounts.get(userId) || 0) > this.maxErrorsPerUser;
    }

    resetErrorCounts() {
        const totalErrors = Array.from(this.errorCounts.values()).reduce((a, b) => a + b, 0);
        if (totalErrors > 0) {
            logger.info(`Resetting error counts. Total errors last hour: ${totalErrors}`);
        }
        this.errorCounts.clear();
        this.userErrorCounts.clear();
    }

    getStats() {
        return {
            totalErrors: Array.from(this.errorCounts.values()).reduce((a, b) => a + b, 0),
            uniqueErrors: this.errorCounts.size,
            affectedUsers: this.userErrorCounts.size,
            topErrors: Array.from(this.errorCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
        };
    }
}

export default new ErrorHandler();

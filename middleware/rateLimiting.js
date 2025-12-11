// File: middleware/rateLimiting.js
// Rate limiting middleware untuk Diamante Bot

import logger from '../utils/logger.js';

class RateLimiter {
    constructor() {
        this.requests = new Map();
        this.commandRequests = new Map();
        
        this.limits = {
            general: { limit: 30, window: 60000 },
            commands: { limit: 10, window: 60000 },
            admin: { limit: 50, window: 60000 },
            broadcast: { limit: 1, window: 300000 },
            transfer: { limit: 2, window: 60000 }
        };
        
        setInterval(() => this.cleanup(), 60000);
    }

    getKey(userId, type = 'general') {
        return `${userId}_${type}`;
    }

    isRateLimited(userId, type = 'general') {
        const key = this.getKey(userId, type);
        const limit = this.limits[type] || this.limits.general;
        const now = Date.now();
        
        if (!this.requests.has(key)) {
            this.requests.set(key, []);
        }
        
        const userRequests = this.requests.get(key);
        
        const validRequests = userRequests.filter(time => now - time < limit.window);
        this.requests.set(key, validRequests);
        
        if (validRequests.length >= limit.limit) {
            return true;
        }
        
        validRequests.push(now);
        return false;
    }

    getRemainingRequests(userId, type = 'general') {
        const key = this.getKey(userId, type);
        const limit = this.limits[type] || this.limits.general;
        const now = Date.now();
        
        const userRequests = this.requests.get(key) || [];
        const validRequests = userRequests.filter(time => now - time < limit.window);
        
        return Math.max(0, limit.limit - validRequests.length);
    }

    getTimeUntilReset(userId, type = 'general') {
        const key = this.getKey(userId, type);
        const limit = this.limits[type] || this.limits.general;
        const now = Date.now();
        
        const userRequests = this.requests.get(key) || [];
        if (userRequests.length === 0) return 0;
        
        const oldestRequest = Math.min(...userRequests);
        const resetTime = oldestRequest + limit.window;
        
        return Math.max(0, resetTime - now);
    }

    resetUser(userId, type = null) {
        if (type) {
            const key = this.getKey(userId, type);
            this.requests.delete(key);
        } else {
            for (const key of this.requests.keys()) {
                if (key.startsWith(`${userId}_`)) {
                    this.requests.delete(key);
                }
            }
        }
    }

    cleanup() {
        const now = Date.now();
        const maxAge = 600000;
        
        for (const [key, requests] of this.requests.entries()) {
            const validRequests = requests.filter(time => now - time < maxAge);
            
            if (validRequests.length === 0) {
                this.requests.delete(key);
            } else {
                this.requests.set(key, validRequests);
            }
        }
    }

    getStats() {
        return {
            trackedUsers: this.requests.size,
            totalRequests: Array.from(this.requests.values()).reduce((a, b) => a + b.length, 0)
        };
    }

    middleware() {
        return async (ctx, next) => {
            const userId = ctx.from?.id;
            if (!userId) return next();
            
            if (this.isRateLimited(userId, 'general')) {
                const resetTime = Math.ceil(this.getTimeUntilReset(userId, 'general') / 1000);
                logger.warn(`Rate limited user ${userId}`);
                
                try {
                    await ctx.reply(`⏳ Terlalu banyak permintaan. Coba lagi dalam ${resetTime} detik.`);
                } catch (e) {}
                
                return;
            }
            
            return next();
        };
    }

    commandMiddleware() {
        return async (ctx, next) => {
            const userId = ctx.from?.id;
            if (!userId) return next();
            
            const text = ctx.message?.text || '';
            if (!text.startsWith('/') && !text.startsWith('!')) {
                return next();
            }
            
            if (this.isRateLimited(userId, 'commands')) {
                logger.warn(`Command rate limited user ${userId}`);
                return;
            }
            
            return next();
        };
    }

    adminMiddleware() {
        return async (ctx, next) => {
            const userId = ctx.from?.id;
            if (!userId) return next();
            
            if (this.isRateLimited(userId, 'admin')) {
                logger.warn(`Admin rate limited user ${userId}`);
                await ctx.reply('⏳ Too many admin requests. Please wait.');
                return;
            }
            
            return next();
        };
    }
}

export default new RateLimiter();

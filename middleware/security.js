// File: middleware/security.js
// Security middleware untuk Diamante Bot

import logger from '../utils/logger.js';

class SecurityMiddleware {
    constructor() {
        this.blockedUsers = new Set();
        this.suspiciousPatterns = [
            /<script/i,
            /javascript:/i,
            /on\w+\s*=/i,
            /eval\s*\(/i,
            /document\./i,
            /window\./i,
            /\$\{.*\}/,
            /\{\{.*\}\}/
        ];
        
        this.commandInjectionPatterns = [
            /;\s*(rm|del|format|shutdown)/i,
            /\|\s*bash/i,
            /`[^`]+`/,
            /\$\([^)]+\)/
        ];
    }

    isBlocked(userId) {
        return this.blockedUsers.has(userId.toString());
    }

    blockUser(userId) {
        this.blockedUsers.add(userId.toString());
        logger.warn(`User ${userId} blocked by security`);
    }

    unblockUser(userId) {
        this.blockedUsers.delete(userId.toString());
    }

    sanitizeInput(input) {
        if (typeof input !== 'string') return input;
        
        let sanitized = input
            .replace(/<script[^>]*>.*?<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '');
        
        return sanitized.trim();
    }

    containsMaliciousPatterns(text) {
        if (!text || typeof text !== 'string') return false;
        
        for (const pattern of this.suspiciousPatterns) {
            if (pattern.test(text)) {
                return true;
            }
        }
        
        for (const pattern of this.commandInjectionPatterns) {
            if (pattern.test(text)) {
                return true;
            }
        }
        
        return false;
    }

    validateWalletAddress(address) {
        if (!address || typeof address !== 'string') return false;
        
        if (!address.startsWith('0x') || address.length !== 42) return false;
        
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
        
        return true;
    }

    validateNumericInput(input, min = 0, max = Infinity) {
        const num = parseFloat(input);
        
        if (isNaN(num)) return false;
        if (num < min || num > max) return false;
        
        return true;
    }

    checkRateLimit(userId, action, limit = 10, windowMs = 60000) {
        return true;
    }

    middleware() {
        return async (ctx, next) => {
            try {
                const userId = ctx.from?.id?.toString();
                
                if (userId && this.isBlocked(userId)) {
                    logger.warn(`Blocked user ${userId} attempted access`);
                    return;
                }
                
                const text = ctx.message?.text || ctx.callbackQuery?.data || '';
                
                if (this.containsMaliciousPatterns(text)) {
                    logger.warn(`Malicious pattern detected from user ${userId}: ${text.substring(0, 50)}`);
                    return ctx.reply('⚠️ Input tidak valid.');
                }
                
                if (ctx.message?.text) {
                    ctx.message.text = this.sanitizeInput(ctx.message.text);
                }
                
                return next();
            } catch (error) {
                logger.error('Security middleware error:', error.message);
                return next();
            }
        };
    }
}

export default new SecurityMiddleware();

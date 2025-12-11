// File: utils/validationHelper.js
// Validation helpers untuk Diamante Auto Transfer Bot

import logger from './logger.js';

class ValidationHelper {
    static isValidWalletAddress(address) {
        if (!address || typeof address !== 'string') return false;
        return address.startsWith('0x') && 
               address.length === 42 && 
               /^0x[0-9a-fA-F]{40}$/.test(address);
    }

    static isValidAmount(amount) {
        const num = parseFloat(amount);
        return !isNaN(num) && num > 0 && num <= 1000000;
    }

    static isValidUserId(userId) {
        if (!userId) return false;
        const str = userId.toString();
        return /^\d+$/.test(str) && str.length >= 6;
    }

    static validateContext(ctx) {
        const errors = [];
        
        if (!ctx) {
            errors.push('Context is null');
            return errors;
        }
        
        if (!ctx.from) {
            errors.push('Missing user information');
        } else if (!ctx.from.id) {
            errors.push('Missing user ID');
        }
        
        if (!ctx.chat) {
            errors.push('Missing chat information');
        }
        
        return errors;
    }

    static validateWalletData(wallet) {
        const errors = [];
        
        if (!wallet) {
            errors.push('Wallet data is null');
            return { valid: false, errors };
        }
        
        if (!this.isValidWalletAddress(wallet.address)) {
            errors.push(`Invalid address format: ${wallet.address?.slice(0, 10)}...`);
        }
        
        if (!this.isValidAmount(wallet.amount)) {
            errors.push(`Invalid amount: ${wallet.amount}`);
        }
        
        return { 
            valid: errors.length === 0, 
            errors 
        };
    }

    static validateWallets(wallets) {
        const valid = [];
        const invalid = [];
        
        if (!Array.isArray(wallets)) {
            return { valid: [], invalid: ['Input is not an array'] };
        }
        
        wallets.forEach((wallet, idx) => {
            const result = this.validateWalletData(wallet);
            if (result.valid) {
                valid.push(wallet);
            } else {
                invalid.push({
                    index: idx + 1,
                    wallet,
                    errors: result.errors
                });
            }
        });
        
        return { valid, invalid };
    }

    static validateBroadcastMessage(message) {
        const errors = [];
        
        if (!message || typeof message !== 'string') {
            errors.push('Message harus berupa text');
            return { errors, sanitized: null };
        }
        
        let sanitized = message
            .trim()
            .replace(/<script[^>]*>.*?<\/script>/gi, '')
            .replace(/javascript:/gi, '');
        
        if (sanitized.length === 0) {
            errors.push('Message tidak boleh kosong');
        }
        
        if (sanitized.length > 4096) {
            errors.push('Message terlalu panjang (max 4096 karakter)');
        }
        
        const spamPatterns = [
            /(.)\1{20,}/,
            /[A-Z]{50,}/,
            /(https?:\/\/[^\s]+){5,}/
        ];
        
        spamPatterns.forEach(pattern => {
            if (pattern.test(sanitized)) {
                errors.push('Message mengandung pola spam');
            }
        });
        
        return { errors, sanitized };
    }

    static sanitizeInput(input) {
        if (typeof input !== 'string') return input;
        return input
            .replace(/[<>]/g, '')
            .replace(/['"]/g, '')
            .trim();
    }

    static logValidationErrors(errors, context = '') {
        if (errors.length > 0) {
            logger.warn(`Validation errors${context ? ` in ${context}` : ''}:`, errors);
        }
    }
}

export default ValidationHelper;

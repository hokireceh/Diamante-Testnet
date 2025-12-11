// File: utils/auditLogger.js
// Audit logging untuk admin actions di Diamante Bot

import fs from 'fs';
import logger from './logger.js';

class AuditLogger {
    constructor() {
        this.logFile = 'data/audit_log.json';
        this.logs = [];
        this.maxLogs = 1000;
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;
        
        try {
            if (!fs.existsSync('data')) {
                fs.mkdirSync('data', { recursive: true });
            }
            
            if (fs.existsSync(this.logFile)) {
                const data = JSON.parse(fs.readFileSync(this.logFile, 'utf-8'));
                this.logs = data.logs || [];
            }
            
            this.initialized = true;
            logger.info(`AuditLogger initialized with ${this.logs.length} entries`);
        } catch (error) {
            logger.error('Failed to initialize AuditLogger:', error.message);
            this.logs = [];
        }
    }

    log(action, adminId, adminName, details = {}) {
        const entry = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            timestamp: new Date().toISOString(),
            action,
            adminId: adminId.toString(),
            adminName,
            details,
            ip: null
        };
        
        this.logs.unshift(entry);
        
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(0, this.maxLogs);
        }
        
        logger.admin(adminName, action, JSON.stringify(details));
        
        this.debouncedSave();
        
        return entry;
    }

    logTransfer(adminId, adminName, stats) {
        return this.log('BATCH_TRANSFER', adminId, adminName, {
            totalWallets: stats.total,
            success: stats.success,
            failed: stats.failed,
            mysteryXP: stats.mysteryXP || 0
        });
    }

    logBroadcast(adminId, adminName, stats) {
        return this.log('BROADCAST', adminId, adminName, {
            totalUsers: stats.total,
            sent: stats.sent,
            failed: stats.failed,
            messagePreview: stats.messagePreview?.substring(0, 100)
        });
    }

    logAdminAdd(adminId, adminName, targetId) {
        return this.log('ADMIN_ADD', adminId, adminName, { targetId });
    }

    logAdminRemove(adminId, adminName, targetId) {
        return this.log('ADMIN_REMOVE', adminId, adminName, { targetId });
    }

    logWalletAdd(adminId, adminName, walletAddress) {
        return this.log('WALLET_ADD', adminId, adminName, { 
            wallet: walletAddress.slice(0, 10) + '...' 
        });
    }

    logWalletRemove(adminId, adminName, walletAddress) {
        return this.log('WALLET_REMOVE', adminId, adminName, { 
            wallet: walletAddress.slice(0, 10) + '...' 
        });
    }

    logBlockUser(adminId, adminName, targetId) {
        return this.log('USER_BLOCK', adminId, adminName, { targetId });
    }

    logUnblockUser(adminId, adminName, targetId) {
        return this.log('USER_UNBLOCK', adminId, adminName, { targetId });
    }

    logLiveChat(adminId, adminName, targetId, messagePreview) {
        return this.log('LIVE_CHAT_REPLY', adminId, adminName, { 
            targetId,
            messagePreview: messagePreview?.substring(0, 50) 
        });
    }

    getRecentLogs(limit = 50) {
        return this.logs.slice(0, limit);
    }

    getLogsByAdmin(adminId, limit = 50) {
        return this.logs
            .filter(log => log.adminId === adminId.toString())
            .slice(0, limit);
    }

    getLogsByAction(action, limit = 50) {
        return this.logs
            .filter(log => log.action === action)
            .slice(0, limit);
    }

    getStats() {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        
        const last24h = this.logs.filter(log => {
            return new Date(log.timestamp).getTime() > now - day;
        });
        
        const actionCounts = {};
        last24h.forEach(log => {
            actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
        });
        
        return {
            totalLogs: this.logs.length,
            last24hCount: last24h.length,
            actionBreakdown: actionCounts,
            uniqueAdmins: [...new Set(last24h.map(l => l.adminId))].length
        };
    }

    async save() {
        try {
            const data = {
                logs: this.logs,
                lastUpdated: new Date().toISOString()
            };
            
            fs.writeFileSync(this.logFile, JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error('Failed to save audit logs:', error.message);
        }
    }

    saveTimer = null;
    debouncedSave() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 3000);
    }
}

export default new AuditLogger();

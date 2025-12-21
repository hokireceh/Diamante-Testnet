// File: utils/userManager.js
// User management untuk Diamante Auto Transfer Bot

import fs from 'fs';
import logger from './logger.js';

class UserManager {
    constructor() {
        this.users = new Map();
        this.dataFile = 'data/users.json';
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return true;
        
        try {
            await this.loadUsers();
            this.initialized = true;
            logger.success(`UserManager initialized with ${this.users.size} users`);
            return true;
        } catch (error) {
            logger.error('Failed to initialize UserManager:', error.message);
            return false;
        }
    }

    async loadUsers() {
        try {
            if (!fs.existsSync('data')) {
                fs.mkdirSync('data', { recursive: true });
            }
            
            if (fs.existsSync(this.dataFile)) {
                const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
                
                if (data.users) {
                    this.users = new Map(Object.entries(data.users));
                }
                
                logger.info(`Loaded ${this.users.size} users from storage`);
            } else {
                this.users = new Map();
                await this.saveUsers();
            }
        } catch (error) {
            logger.error('Error loading users:', error.message);
            this.users = new Map();
        }
    }

    async saveUsers() {
        try {
            const data = {
                users: Object.fromEntries(this.users),
                lastUpdated: new Date().toISOString(),
                version: '1.0'
            };
            
            fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
            logger.debug('Users saved to storage');
        } catch (error) {
            logger.error('Error saving users:', error.message);
        }
    }

    trackUser(userId, userData = {}) {
        const userIdStr = userId.toString();
        const existing = this.users.get(userIdStr) || {};
        
        const updated = {
            ...existing,
            ...userData,
            userId: userIdStr,
            lastSeen: new Date().toISOString(),
            joinedAt: existing.joinedAt || new Date().toISOString()
        };
        
        this.users.set(userIdStr, updated);
        
        this.debouncedSave();
        
        return updated;
    }

    getUser(userId) {
        return this.users.get(userId.toString());
    }

    getUserCount() {
        return this.users.size;
    }

    getAllUsers() {
        return Array.from(this.users.entries()).map(([id, data]) => ({
            userId: id,
            ...data
        }));
    }

    getActiveUsers(days = 7) {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        
        return this.getAllUsers().filter(user => {
            const lastSeen = new Date(user.lastSeen || user.joinedAt).getTime();
            return lastSeen > cutoff && !user.blocked;
        });
    }

    getBroadcastableUsers() {
        return this.getAllUsers().filter(user => !user.blocked && !user.leftBot);
    }

    blockUser(userId) {
        const user = this.getUser(userId);
        if (user) {
            user.blocked = true;
            user.blockedAt = new Date().toISOString();
            this.users.set(userId.toString(), user);
            this.debouncedSave();
            logger.info(`Blocked user: ${userId}`);
            return true;
        }
        return false;
    }

    unblockUser(userId) {
        const user = this.getUser(userId);
        if (user && user.blocked) {
            user.blocked = false;
            user.unblockedAt = new Date().toISOString();
            this.users.set(userId.toString(), user);
            this.debouncedSave();
            logger.info(`Unblocked user: ${userId}`);
            return true;
        }
        return false;
    }

    markUserLeft(userId) {
        const user = this.getUser(userId);
        if (user) {
            user.leftBot = true;
            user.leftAt = new Date().toISOString();
            this.users.set(userId.toString(), user);
            this.debouncedSave();
            return true;
        }
        return false;
    }

    removeUser(userId) {
        const userIdStr = userId.toString();
        if (this.users.has(userIdStr)) {
            this.users.delete(userIdStr);
            this.debouncedSave();
            logger.info(`Removed user: ${userId}`);
            return true;
        }
        return false;
    }

    removeBlockedUsers() {
        const blockedUsers = this.getAllUsers().filter(u => u.blocked || u.leftBot);
        let removed = 0;
        
        for (const user of blockedUsers) {
            this.users.delete(user.userId);
            removed++;
        }
        
        if (removed > 0) {
            this.saveUsers();
            logger.info(`Removed ${removed} blocked/left users`);
        }
        
        return removed;
    }

    setUserLanguage(userId, language) {
        const user = this.getUser(userId) || {};
        user.language = language;
        this.users.set(userId.toString(), user);
        this.debouncedSave();
    }

    getUserLanguage(userId) {
        const user = this.getUser(userId);
        return user?.language || 'id';
    }

    getStats() {
        const users = this.getAllUsers();
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        
        return {
            total: users.length,
            active: users.filter(u => !u.blocked && !u.leftBot).length,
            blocked: users.filter(u => u.blocked).length,
            left: users.filter(u => u.leftBot).length,
            last24h: users.filter(u => {
                const seen = new Date(u.lastSeen || 0).getTime();
                return now - seen < day;
            }).length,
            last7d: users.filter(u => {
                const seen = new Date(u.lastSeen || 0).getTime();
                return now - seen < 7 * day;
            }).length
        };
    }

    saveTimer = null;
    debouncedSave() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveUsers(), 2000);
    }
}

export default new UserManager();

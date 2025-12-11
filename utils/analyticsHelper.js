// File: utils/analyticsHelper.js
// Analytics tracking untuk Diamante Bot

import fs from 'fs';
import logger from './logger.js';

class AnalyticsHelper {
    constructor() {
        this.dataFile = 'data/analytics.json';
        this.data = this.getDefaultData();
        this.initialized = false;
    }

    getDefaultData() {
        return {
            transfers: {
                total: 0,
                success: 0,
                failed: 0,
                totalAmount: 0,
                mysteryXP: 0,
                lastTransfer: null
            },
            broadcasts: {
                total: 0,
                totalSent: 0,
                totalFailed: 0,
                lastBroadcast: null
            },
            users: {
                totalCommands: 0,
                uniqueUsersToday: new Set(),
                commandBreakdown: {}
            },
            liveChat: {
                totalMessages: 0,
                totalReplies: 0,
                avgResponseTime: 0
            },
            daily: {},
            hourly: {}
        };
    }

    async init() {
        if (this.initialized) return;
        
        try {
            if (!fs.existsSync('data')) {
                fs.mkdirSync('data', { recursive: true });
            }
            
            if (fs.existsSync(this.dataFile)) {
                const stored = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
                this.data = { ...this.getDefaultData(), ...stored };
                this.data.users.uniqueUsersToday = new Set(stored.users?.uniqueUsersToday || []);
            }
            
            this.initialized = true;
            logger.info('AnalyticsHelper initialized');
            
            this.startDailyReset();
        } catch (error) {
            logger.error('Failed to initialize AnalyticsHelper:', error.message);
        }
    }

    trackTransfer(success, amount = 0, mysteryXP = 0) {
        this.data.transfers.total++;
        
        if (success) {
            this.data.transfers.success++;
            this.data.transfers.totalAmount += amount;
            this.data.transfers.mysteryXP += mysteryXP;
        } else {
            this.data.transfers.failed++;
        }
        
        this.data.transfers.lastTransfer = new Date().toISOString();
        this.trackDaily('transfers', success ? 1 : 0);
        this.debouncedSave();
    }

    trackBroadcast(sent, failed) {
        this.data.broadcasts.total++;
        this.data.broadcasts.totalSent += sent;
        this.data.broadcasts.totalFailed += failed;
        this.data.broadcasts.lastBroadcast = new Date().toISOString();
        
        this.trackDaily('broadcasts', 1);
        this.debouncedSave();
    }

    trackCommand(userId, command) {
        this.data.users.totalCommands++;
        this.data.users.uniqueUsersToday.add(userId.toString());
        
        if (!this.data.users.commandBreakdown[command]) {
            this.data.users.commandBreakdown[command] = 0;
        }
        this.data.users.commandBreakdown[command]++;
        
        this.trackHourly('commands');
        this.debouncedSave();
    }

    trackLiveChat(isReply = false, responseTime = 0) {
        if (isReply) {
            this.data.liveChat.totalReplies++;
            if (responseTime > 0) {
                const total = this.data.liveChat.totalReplies;
                const currentAvg = this.data.liveChat.avgResponseTime;
                this.data.liveChat.avgResponseTime = 
                    ((currentAvg * (total - 1)) + responseTime) / total;
            }
        } else {
            this.data.liveChat.totalMessages++;
        }
        
        this.debouncedSave();
    }

    trackDaily(metric, value = 1) {
        const today = new Date().toISOString().split('T')[0];
        
        if (!this.data.daily[today]) {
            this.data.daily[today] = {};
        }
        
        if (!this.data.daily[today][metric]) {
            this.data.daily[today][metric] = 0;
        }
        
        this.data.daily[today][metric] += value;
    }

    trackHourly(metric) {
        const hour = new Date().getHours().toString();
        
        if (!this.data.hourly[hour]) {
            this.data.hourly[hour] = {};
        }
        
        if (!this.data.hourly[hour][metric]) {
            this.data.hourly[hour][metric] = 0;
        }
        
        this.data.hourly[hour][metric]++;
    }

    getTransferStats() {
        const { transfers } = this.data;
        const successRate = transfers.total > 0 
            ? ((transfers.success / transfers.total) * 100).toFixed(1) 
            : 0;
        
        return {
            ...transfers,
            successRate: `${successRate}%`
        };
    }

    getBroadcastStats() {
        const { broadcasts } = this.data;
        const deliveryRate = broadcasts.totalSent > 0 
            ? ((broadcasts.totalSent / (broadcasts.totalSent + broadcasts.totalFailed)) * 100).toFixed(1) 
            : 0;
        
        return {
            ...broadcasts,
            deliveryRate: `${deliveryRate}%`
        };
    }

    getUserStats() {
        return {
            totalCommands: this.data.users.totalCommands,
            uniqueUsersToday: this.data.users.uniqueUsersToday.size,
            topCommands: Object.entries(this.data.users.commandBreakdown)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
        };
    }

    getLiveChatStats() {
        return {
            ...this.data.liveChat,
            avgResponseTime: `${Math.round(this.data.liveChat.avgResponseTime / 1000)}s`
        };
    }

    getFullStats() {
        return {
            transfers: this.getTransferStats(),
            broadcasts: this.getBroadcastStats(),
            users: this.getUserStats(),
            liveChat: this.getLiveChatStats(),
            lastUpdated: new Date().toISOString()
        };
    }

    getDailyStats(days = 7) {
        const result = {};
        const dates = Object.keys(this.data.daily).sort().slice(-days);
        
        dates.forEach(date => {
            result[date] = this.data.daily[date];
        });
        
        return result;
    }

    startDailyReset() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        
        const msUntilMidnight = tomorrow - now;
        
        setTimeout(() => {
            this.resetDailyMetrics();
            setInterval(() => this.resetDailyMetrics(), 24 * 60 * 60 * 1000);
        }, msUntilMidnight);
    }

    resetDailyMetrics() {
        this.data.users.uniqueUsersToday = new Set();
        this.data.hourly = {};
        
        const dates = Object.keys(this.data.daily).sort();
        if (dates.length > 30) {
            const toDelete = dates.slice(0, dates.length - 30);
            toDelete.forEach(date => delete this.data.daily[date]);
        }
        
        logger.info('Daily analytics metrics reset');
        this.save();
    }

    async save() {
        try {
            const dataToSave = {
                ...this.data,
                users: {
                    ...this.data.users,
                    uniqueUsersToday: Array.from(this.data.users.uniqueUsersToday)
                }
            };
            
            fs.writeFileSync(this.dataFile, JSON.stringify(dataToSave, null, 2));
        } catch (error) {
            logger.error('Failed to save analytics:', error.message);
        }
    }

    saveTimer = null;
    debouncedSave() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 5000);
    }
}

export default new AnalyticsHelper();

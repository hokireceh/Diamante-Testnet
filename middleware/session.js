// File: middleware/session.js
// Session management middleware untuk Diamante Bot

import logger from '../utils/logger.js';

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.sessionTimeout = 30 * 60 * 1000; // 30 minutes
        this.cleanupInterval = 10 * 60 * 1000; // cleanup every 10 minutes
        
        this.startCleanup();
    }

    getSession(userId) {
        const userIdStr = userId.toString();
        
        if (!this.sessions.has(userIdStr)) {
            this.sessions.set(userIdStr, this.createSession(userIdStr));
        }
        
        const session = this.sessions.get(userIdStr);
        session.lastActivity = Date.now();
        
        return session;
    }

    createSession(userId) {
        return {
            userId,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            state: null,
            data: {},
            broadcastDraft: null,
            liveChatTarget: null,
            pendingAction: null
        };
    }

    setState(userId, state, data = {}) {
        const session = this.getSession(userId);
        session.state = state;
        session.data = { ...session.data, ...data };
        session.lastActivity = Date.now();
    }

    getState(userId) {
        const session = this.getSession(userId);
        return session.state;
    }

    getData(userId, key = null) {
        const session = this.getSession(userId);
        if (key) {
            return session.data[key];
        }
        return session.data;
    }

    setData(userId, key, value) {
        const session = this.getSession(userId);
        session.data[key] = value;
        session.lastActivity = Date.now();
    }

    clearState(userId) {
        const session = this.getSession(userId);
        session.state = null;
        session.data = {};
        session.pendingAction = null;
    }

    setBroadcastDraft(userId, draft) {
        const session = this.getSession(userId);
        session.broadcastDraft = {
            ...draft,
            createdAt: Date.now()
        };
    }

    getBroadcastDraft(userId) {
        const session = this.getSession(userId);
        return session.broadcastDraft;
    }

    clearBroadcastDraft(userId) {
        const session = this.getSession(userId);
        session.broadcastDraft = null;
    }

    setLiveChatTarget(userId, targetId, targetName = null) {
        const session = this.getSession(userId);
        session.liveChatTarget = {
            targetId,
            targetName,
            startedAt: Date.now()
        };
    }

    getLiveChatTarget(userId) {
        const session = this.getSession(userId);
        return session.liveChatTarget;
    }

    clearLiveChatTarget(userId) {
        const session = this.getSession(userId);
        session.liveChatTarget = null;
    }

    setPendingAction(userId, action, data = {}) {
        const session = this.getSession(userId);
        session.pendingAction = {
            action,
            data,
            createdAt: Date.now()
        };
    }

    getPendingAction(userId) {
        const session = this.getSession(userId);
        return session.pendingAction;
    }

    clearPendingAction(userId) {
        const session = this.getSession(userId);
        session.pendingAction = null;
    }

    destroySession(userId) {
        this.sessions.delete(userId.toString());
    }

    startCleanup() {
        setInterval(() => {
            this.cleanupExpiredSessions();
        }, this.cleanupInterval);
    }

    cleanupExpiredSessions() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [userId, session] of this.sessions.entries()) {
            if (now - session.lastActivity > this.sessionTimeout) {
                this.sessions.delete(userId);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            logger.debug(`Cleaned up ${cleaned} expired sessions`);
        }
    }

    getStats() {
        const now = Date.now();
        const sessions = Array.from(this.sessions.values());
        
        return {
            total: sessions.length,
            active: sessions.filter(s => now - s.lastActivity < 5 * 60 * 1000).length,
            withState: sessions.filter(s => s.state !== null).length,
            withBroadcastDraft: sessions.filter(s => s.broadcastDraft !== null).length,
            withLiveChat: sessions.filter(s => s.liveChatTarget !== null).length
        };
    }

    middleware() {
        return async (ctx, next) => {
            if (ctx.from) {
                ctx.session = this.getSession(ctx.from.id);
            }
            return next();
        };
    }
}

export default new SessionManager();

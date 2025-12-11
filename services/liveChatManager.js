// File: services/liveChatManager.js
// Live chat management untuk admin-user communication di Diamante Bot

import logger from '../utils/logger.js';
import analyticsHelper from '../utils/analyticsHelper.js';

class LiveChatManager {
    constructor() {
        this.activeChats = new Map();
        this.messageQueues = new Map();
        this.processingUsers = new Set();
        this.typingIndicators = new Map();
        this.pendingReplies = new Map();
        
        this.startCleanup();
        logger.info('LiveChatManager initialized');
    }

    startChat(adminId, userId, userName = null) {
        const chat = {
            adminId: adminId.toString(),
            userId: userId.toString(),
            userName,
            startedAt: Date.now(),
            messageCount: 0,
            lastActivity: Date.now()
        };
        
        this.activeChats.set(adminId.toString(), chat);
        
        logger.info(`LiveChat started: Admin ${adminId} -> User ${userId}`);
        
        return chat;
    }

    endChat(adminId) {
        const chat = this.activeChats.get(adminId.toString());
        
        if (chat) {
            this.activeChats.delete(adminId.toString());
            logger.info(`LiveChat ended: Admin ${adminId}, ${chat.messageCount} messages`);
            return chat;
        }
        
        return null;
    }

    getActiveChat(adminId) {
        return this.activeChats.get(adminId.toString());
    }

    isInChat(adminId) {
        return this.activeChats.has(adminId.toString());
    }

    getActiveChatByUser(userId) {
        for (const [adminId, chat] of this.activeChats.entries()) {
            if (chat.userId === userId.toString()) {
                return { adminId, ...chat };
            }
        }
        return null;
    }

    async queueUserMessage(userId, message, ctx) {
        const userIdStr = userId.toString();
        const messageData = {
            userId: userIdStr,
            text: message,
            timestamp: Date.now(),
            from: ctx.from,
            chatId: ctx.chat?.id
        };

        if (!this.messageQueues.has(userIdStr)) {
            this.messageQueues.set(userIdStr, []);
        }

        this.messageQueues.get(userIdStr).push(messageData);
        
        analyticsHelper.trackLiveChat(false);
        
        logger.debug(`Queued message from user ${userId}`);
        
        return messageData;
    }

    getUserMessages(userId, clear = false) {
        const userIdStr = userId.toString();
        const messages = this.messageQueues.get(userIdStr) || [];
        
        if (clear && messages.length > 0) {
            this.messageQueues.delete(userIdStr);
        }
        
        return messages;
    }

    getPendingMessages() {
        const pending = [];
        
        for (const [userId, messages] of this.messageQueues.entries()) {
            if (messages.length > 0) {
                pending.push({
                    userId,
                    messageCount: messages.length,
                    lastMessage: messages[messages.length - 1],
                    firstMessage: messages[0]
                });
            }
        }
        
        return pending.sort((a, b) => 
            b.lastMessage.timestamp - a.lastMessage.timestamp
        );
    }

    async sendReply(bot, adminId, userId, message, options = {}) {
        const startTime = Date.now();
        
        try {
            await this.showTypingIndicator(bot, userId);
            
            await this._naturalDelay();
            
            const result = await bot.telegram.sendMessage(userId, message, {
                parse_mode: options.parseMode || 'HTML',
                ...options
            });
            
            const chat = this.getActiveChat(adminId);
            if (chat) {
                chat.messageCount++;
                chat.lastActivity = Date.now();
            }
            
            const responseTime = Date.now() - startTime;
            analyticsHelper.trackLiveChat(true, responseTime);
            
            logger.info(`LiveChat reply sent: Admin ${adminId} -> User ${userId}`);
            
            return { success: true, result };
        } catch (error) {
            logger.error(`Failed to send LiveChat reply: ${error.message}`);
            return { success: false, error: error.message };
        } finally {
            this.clearTypingIndicator(userId);
        }
    }

    async showTypingIndicator(bot, userId) {
        try {
            await bot.telegram.sendChatAction(userId, 'typing');
            
            this.clearTypingIndicator(userId);
            
            const timeout = setTimeout(() => {
                this.typingIndicators.delete(userId.toString());
            }, 5000);
            
            this.typingIndicators.set(userId.toString(), timeout);
        } catch (error) {
            logger.debug(`Typing indicator failed: ${error.message}`);
        }
    }

    clearTypingIndicator(userId) {
        const timeout = this.typingIndicators.get(userId.toString());
        if (timeout) {
            clearTimeout(timeout);
            this.typingIndicators.delete(userId.toString());
        }
    }

    async _naturalDelay() {
        const minDelay = 500;
        const maxDelay = 1500;
        const delay = minDelay + Math.random() * (maxDelay - minDelay);
        
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    getStats() {
        return {
            activeChats: this.activeChats.size,
            pendingQueues: this.messageQueues.size,
            totalPendingMessages: Array.from(this.messageQueues.values())
                .reduce((sum, q) => sum + q.length, 0),
            processingUsers: this.processingUsers.size
        };
    }

    startCleanup() {
        setInterval(() => {
            this.cleanupInactive();
        }, 600000);
    }

    cleanupInactive() {
        const now = Date.now();
        const chatTimeout = 2 * 60 * 60 * 1000;
        const queueTimeout = 24 * 60 * 60 * 1000;
        
        let cleanedChats = 0;
        let cleanedQueues = 0;
        
        for (const [adminId, chat] of this.activeChats.entries()) {
            if (now - chat.lastActivity > chatTimeout) {
                this.activeChats.delete(adminId);
                cleanedChats++;
            }
        }
        
        for (const [userId, messages] of this.messageQueues.entries()) {
            if (messages.length === 0) {
                this.messageQueues.delete(userId);
                cleanedQueues++;
            } else {
                const validMessages = messages.filter(m => 
                    now - m.timestamp < queueTimeout
                );
                
                if (validMessages.length === 0) {
                    this.messageQueues.delete(userId);
                    cleanedQueues++;
                } else if (validMessages.length < messages.length) {
                    this.messageQueues.set(userId, validMessages);
                }
            }
        }
        
        if (cleanedChats > 0 || cleanedQueues > 0) {
            logger.info(`LiveChat cleanup: ${cleanedChats} chats, ${cleanedQueues} queues`);
        }
    }

    formatPendingList(pending) {
        if (pending.length === 0) {
            return '📭 Tidak ada pesan pending.';
        }
        
        let text = `📬 <b>Pesan Pending (${pending.length} user)</b>\n\n`;
        
        pending.slice(0, 10).forEach((p, i) => {
            const userName = p.lastMessage.from?.first_name || 'User';
            const preview = p.lastMessage.text?.substring(0, 50) || '(no text)';
            const timeAgo = this._formatTimeAgo(p.lastMessage.timestamp);
            
            text += `${i + 1}. <b>${userName}</b> (${p.userId})\n`;
            text += `   💬 ${p.messageCount} pesan - ${timeAgo}\n`;
            text += `   📝 "${preview}${p.lastMessage.text?.length > 50 ? '...' : ''}"\n\n`;
        });
        
        if (pending.length > 10) {
            text += `\n... dan ${pending.length - 10} user lainnya`;
        }
        
        return text;
    }

    _formatTimeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        
        if (seconds < 60) return 'baru saja';
        if (seconds < 3600) return `${Math.floor(seconds / 60)} menit lalu`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} jam lalu`;
        return `${Math.floor(seconds / 86400)} hari lalu`;
    }
}

export default new LiveChatManager();

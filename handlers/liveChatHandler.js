// File: handlers/liveChatHandler.js
// Handler untuk fitur Live Chat admin-user di Diamante Bot

import { Markup } from 'telegraf';
import logger from '../utils/logger.js';
import liveChatManager from '../services/liveChatManager.js';
import sessionManager from '../middleware/session.js';
import auditLogger from '../utils/auditLogger.js';
import userManager from '../utils/userManager.js';

class LiveChatHandler {
    constructor() {
        this.bot = null;
    }

    setBot(bot) {
        this.bot = bot;
    }

    async showLiveChatMenu(ctx) {
        const pending = liveChatManager.getPendingMessages();
        const stats = liveChatManager.getStats();
        
        let message = `💬 <b>Live Chat Manager</b>\n\n`;
        message += `📊 <b>Status:</b>\n`;
        message += `• Active Chats: ${stats.activeChats}\n`;
        message += `• Pending Messages: ${stats.totalPendingMessages}\n`;
        message += `• Users with pending: ${pending.length}\n\n`;

        const buttons = [];

        if (pending.length > 0) {
            buttons.push([Markup.button.callback(`📬 Lihat Pending (${pending.length})`, 'livechat_pending')]);
        }

        buttons.push([Markup.button.callback('🔍 Chat User by ID', 'livechat_start_manual')]);

        const activeChat = liveChatManager.getActiveChat(ctx.from.id);
        if (activeChat) {
            message += `\n🟢 <b>Chat Aktif:</b> User ${activeChat.userId}`;
            buttons.push([Markup.button.callback('🔴 Akhiri Chat', 'livechat_end')]);
        }

        buttons.push([Markup.button.callback('« Kembali', 'admin_menu')]);

        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
        
        await ctx.answerCbQuery();
    }

    async showPendingMessages(ctx) {
        const pending = liveChatManager.getPendingMessages();
        
        if (pending.length === 0) {
            await ctx.answerCbQuery('Tidak ada pesan pending');
            return this.showLiveChatMenu(ctx);
        }

        const message = liveChatManager.formatPendingList(pending);
        
        const buttons = pending.slice(0, 5).map(p => {
            const userName = p.lastMessage.from?.first_name || 'User';
            return [Markup.button.callback(
                `💬 ${userName} (${p.messageCount})`,
                `livechat_reply_${p.userId}`
            )];
        });

        buttons.push([Markup.button.callback('« Kembali', 'livechat_menu')]);

        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
        
        await ctx.answerCbQuery();
    }

    async startChatWithUser(ctx, userId) {
        const adminId = ctx.from.id;
        const adminName = ctx.from.first_name;
        
        const existingChat = liveChatManager.getActiveChat(adminId);
        if (existingChat) {
            await ctx.answerCbQuery('Akhiri chat aktif dulu');
            return;
        }

        const userMessages = liveChatManager.getUserMessages(userId, false);
        const userName = userMessages[0]?.from?.first_name || 'User';

        liveChatManager.startChat(adminId, userId, userName);
        sessionManager.setLiveChatTarget(adminId, userId, userName);

        let message = `🟢 <b>Live Chat Started</b>\n\n`;
        message += `👤 User: <b>${userName}</b> (${userId})\n\n`;

        if (userMessages.length > 0) {
            message += `📬 <b>Pesan dari user:</b>\n`;
            userMessages.slice(-5).forEach((msg, i) => {
                const time = new Date(msg.timestamp).toLocaleTimeString('id-ID');
                message += `\n[${time}] ${msg.text}`;
            });
            message += `\n\n`;
        }

        message += `💡 Kirim pesan untuk membalas user.\n`;
        message += `Ketik /endchat untuk mengakhiri.`;

        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔴 Akhiri Chat', 'livechat_end')],
                [Markup.button.callback('🔄 Refresh', `livechat_reply_${userId}`)]
            ])
        });

        await ctx.answerCbQuery('Chat dimulai');
        
        logger.admin(adminName, 'LIVECHAT_START', `User: ${userId}`);
    }

    async promptManualUserId(ctx) {
        sessionManager.setState(ctx.from.id, 'waiting_livechat_userid');

        await ctx.editMessageText(
            `🔍 <b>Chat dengan User</b>\n\n` +
            `Kirimkan User ID yang ingin di-chat:`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[
                    Markup.button.callback('« Batal', 'livechat_menu')
                ]])
            }
        );

        await ctx.answerCbQuery();
    }

    async handleManualUserId(ctx) {
        const state = sessionManager.getState(ctx.from.id);
        
        if (state !== 'waiting_livechat_userid') {
            return false;
        }

        const userId = ctx.message.text.trim();

        if (!/^\d+$/.test(userId)) {
            await ctx.reply('❌ User ID harus berupa angka. Coba lagi.');
            return true;
        }

        sessionManager.clearState(ctx.from.id);

        const adminId = ctx.from.id;
        const adminName = ctx.from.first_name;

        liveChatManager.startChat(adminId, userId, null);
        sessionManager.setLiveChatTarget(adminId, userId, null);

        await ctx.reply(
            `🟢 <b>Live Chat Started</b>\n\n` +
            `👤 User ID: <b>${userId}</b>\n\n` +
            `💡 Kirim pesan untuk membalas user.\n` +
            `Ketik /endchat untuk mengakhiri.`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[
                    Markup.button.callback('🔴 Akhiri Chat', 'livechat_end')
                ]])
            }
        );

        logger.admin(adminName, 'LIVECHAT_START_MANUAL', `User: ${userId}`);

        return true;
    }

    async endChat(ctx) {
        const adminId = ctx.from.id;
        const chat = liveChatManager.endChat(adminId);
        
        sessionManager.clearLiveChatTarget(adminId);
        sessionManager.clearState(adminId);

        if (chat) {
            await ctx.editMessageText(
                `🔴 <b>Chat Ended</b>\n\n` +
                `👤 User: ${chat.userName || chat.userId}\n` +
                `💬 Total Messages: ${chat.messageCount}`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[
                        Markup.button.callback('« Kembali ke Live Chat', 'livechat_menu')
                    ]])
                }
            );
        } else {
            await ctx.editMessageText(
                '❌ Tidak ada chat aktif.',
                {
                    ...Markup.inlineKeyboard([[
                        Markup.button.callback('« Kembali', 'livechat_menu')
                    ]])
                }
            );
        }

        await ctx.answerCbQuery('Chat ended');
    }

    async handleAdminReply(ctx) {
        if (!this.bot) {
            logger.warn('Bot not set in LiveChatHandler');
            return false;
        }

        const adminId = ctx.from.id;
        const activeChat = liveChatManager.getActiveChat(adminId);

        if (!activeChat) {
            return false;
        }

        const message = ctx.message.text;
        const userId = activeChat.userId;
        const adminName = ctx.from.first_name;

        const result = await liveChatManager.sendReply(
            this.bot,
            adminId,
            userId,
            message,
            { parseMode: 'HTML' }
        );

        if (result.success) {
            await ctx.reply('✅ Pesan terkirim', {
                reply_to_message_id: ctx.message.message_id
            });

            auditLogger.logLiveChat(adminId, adminName, userId, message);

            liveChatManager.getUserMessages(userId, true);
        } else {
            await ctx.reply(`❌ Gagal kirim: ${result.error}`);
        }

        return true;
    }

    async handleUserMessage(ctx) {
        const userId = ctx.from.id.toString();
        const message = ctx.message.text;

        await liveChatManager.queueUserMessage(userId, message, ctx);

        userManager.trackUser(userId, {
            firstName: ctx.from.first_name,
            username: ctx.from.username
        });

        const adminChat = liveChatManager.getActiveChatByUser(userId);
        
        if (adminChat && this.bot) {
            try {
                const userName = ctx.from.first_name || 'User';
                await this.bot.telegram.sendMessage(
                    adminChat.adminId,
                    `📥 <b>Pesan baru dari ${userName}:</b>\n\n${message}`,
                    { parse_mode: 'HTML' }
                );
            } catch (error) {
                logger.debug(`Failed to notify admin: ${error.message}`);
            }
        }
    }

    registerHandlers(bot) {
        this.setBot(bot);

        bot.command('endchat', async (ctx) => {
            const adminId = ctx.from.id;
            const chat = liveChatManager.endChat(adminId);
            sessionManager.clearLiveChatTarget(adminId);

            if (chat) {
                await ctx.reply(
                    `🔴 Chat dengan ${chat.userName || chat.userId} diakhiri.\n` +
                    `💬 Total: ${chat.messageCount} pesan.`
                );
            } else {
                await ctx.reply('❌ Tidak ada chat aktif.');
            }
        });
    }
}

export default new LiveChatHandler();

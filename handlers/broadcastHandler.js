// File: handlers/broadcastHandler.js
// Broadcast handler untuk mass messaging di Diamante Bot

import { Markup } from 'telegraf';
import logger from '../utils/logger.js';
import userManager from '../utils/userManager.js';
import validationHelper from '../utils/validationHelper.js';
import auditLogger from '../utils/auditLogger.js';
import analyticsHelper from '../utils/analyticsHelper.js';
import broadcastQueueManager from '../services/broadcastQueueManager.js';
import sessionManager from '../middleware/session.js';

class BroadcastHandler {
    constructor() {
        this.activeBroadcasts = new Map();
    }

    async initiateBroadcast(ctx, message, entities = []) {
        try {
            if (!userManager.initialized) {
                return ctx.reply('⚠️ Bot masih memuat data user. Tunggu beberapa detik.');
            }

            const validation = validationHelper.validateBroadcastMessage(message);
            if (validation.errors.length > 0) {
                validationHelper.logValidationErrors(validation.errors, 'broadcast');
                return ctx.reply(`❌ Pesan broadcast tidak valid:\n${validation.errors.join('\n')}`);
            }

            const users = userManager.getBroadcastableUsers();
            const userCount = users.length;

            if (userCount === 0) {
                return ctx.reply('❌ Tidak ada user yang bisa menerima broadcast.');
            }

            sessionManager.setBroadcastDraft(ctx.from.id, {
                message: validation.sanitized || message,
                entities,
                type: 'text',
                targetCount: userCount
            });

            const previewMsg = await ctx.reply('📋 <b>Preview Pesan:</b>', { parse_mode: 'HTML' });
            
            if (entities && entities.length > 0) {
                await ctx.reply(message, {
                    entities: entities,
                    reply_to_message_id: previewMsg.message_id
                });
            } else {
                await ctx.reply(message, {
                    reply_to_message_id: previewMsg.message_id
                });
            }

            const entityInfo = entities && entities.length > 0 
                ? `\n🎨 <b>Format:</b> ${entities.length} formatting entities`
                : '';

            await ctx.reply(
                `📊 <b>Konfirmasi Broadcast</b>\n\n` +
                `👥 Target: <b>${userCount}</b> users${entityInfo}\n\n` +
                `Kirim broadcast ini?`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Kirim', 'broadcast_confirm'),
                            Markup.button.callback('❌ Batal', 'broadcast_cancel')
                        ]
                    ])
                }
            );

            logger.info(`Broadcast initiated by ${ctx.from.first_name}, targeting ${userCount} users`);

        } catch (error) {
            logger.error('Error initiating broadcast:', error.message);
            await ctx.reply('❌ Gagal mempersiapkan broadcast. Coba lagi.');
        }
    }

    async confirmBroadcast(ctx, bot) {
        const draft = sessionManager.getBroadcastDraft(ctx.from.id);
        
        if (!draft) {
            await ctx.answerCbQuery('❌ Draft broadcast tidak ditemukan');
            return ctx.editMessageText('❌ Draft broadcast sudah expired. Buat ulang.');
        }

        try {
            await ctx.answerCbQuery('🚀 Memulai broadcast...');
            
            const users = userManager.getBroadcastableUsers();
            const adminId = ctx.from.id;
            const adminName = ctx.from.first_name;

            const statusMsg = await ctx.editMessageText(
                `🔄 <b>Broadcasting...</b>\n\n` +
                `📊 Target: ${users.length} users\n` +
                `⏳ Progress: 0/${users.length}`,
                { parse_mode: 'HTML' }
            );

            const broadcastId = Date.now().toString(36);
            this.activeBroadcasts.set(broadcastId, {
                adminId,
                startedAt: Date.now(),
                total: users.length,
                sent: 0,
                failed: 0
            });

            let sent = 0;
            let failed = 0;
            let lastUpdateAt = 0;
            const failedUsers = [];

            broadcastQueueManager.resetStats();

            for (const user of users) {
                const task = async () => {
                    try {
                        if (draft.entities && draft.entities.length > 0) {
                            await bot.telegram.sendMessage(user.userId, draft.message, {
                                entities: draft.entities
                            });
                        } else {
                            await bot.telegram.sendMessage(user.userId, draft.message, {
                                parse_mode: 'HTML'
                            });
                        }
                        sent++;
                    } catch (error) {
                        failed++;
                        failedUsers.push({
                            userId: user.userId,
                            error: error.message
                        });

                        if (error.message?.includes('blocked') || 
                            error.message?.includes('deactivated')) {
                            userManager.removeUser(user.userId);
                        }

                        throw error;
                    }
                };

                await broadcastQueueManager.addToQueue(task);
            }

            const updateInterval = setInterval(async () => {
                const stats = broadcastQueueManager.getStats();
                const progress = stats.totalProcessed;
                
                if (progress !== lastUpdateAt && progress % 10 === 0) {
                    lastUpdateAt = progress;
                    
                    try {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            statusMsg.message_id,
                            null,
                            `🔄 <b>Broadcasting...</b>\n\n` +
                            `📊 Progress: ${progress}/${users.length}\n` +
                            `✅ Sent: ${stats.totalSuccess}\n` +
                            `❌ Failed: ${stats.totalFailed}`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (e) {}
                }
                
                if (!stats.processing && stats.queueLength === 0) {
                    clearInterval(updateInterval);
                }
            }, 3000);

            broadcastQueueManager.setOnComplete(async (finalStats) => {
                clearInterval(updateInterval);
                
                this.activeBroadcasts.delete(broadcastId);
                sessionManager.clearBroadcastDraft(adminId);

                const deliveryRate = ((finalStats.totalSuccess / users.length) * 100).toFixed(1);

                let finalMessage = `📊 <b>BROADCAST SELESAI</b>\n\n`;
                finalMessage += `👥 Total Target: ${users.length}\n`;
                finalMessage += `✅ Terkirim: ${finalStats.totalSuccess}\n`;
                finalMessage += `❌ Gagal: ${finalStats.totalFailed}\n`;
                finalMessage += `🔄 Retry: ${finalStats.totalRetries}\n`;
                finalMessage += `📈 Delivery Rate: <b>${deliveryRate}%</b>`;

                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        statusMsg.message_id,
                        null,
                        finalMessage,
                        { 
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([[
                                Markup.button.callback('« Kembali', 'admin_menu')
                            ]])
                        }
                    );
                } catch (e) {
                    await ctx.reply(finalMessage, { parse_mode: 'HTML' });
                }

                auditLogger.logBroadcast(adminId, adminName, {
                    total: users.length,
                    sent: finalStats.totalSuccess,
                    failed: finalStats.totalFailed,
                    messagePreview: draft.message
                });

                analyticsHelper.trackBroadcast(finalStats.totalSuccess, finalStats.totalFailed);

                logger.broadcast('Completed', {
                    sent: finalStats.totalSuccess,
                    failed: finalStats.totalFailed,
                    total: users.length
                });
            });

        } catch (error) {
            logger.error('Error executing broadcast:', error.message);
            await ctx.reply('❌ Gagal mengirim broadcast. Coba lagi.');
        }
    }

    async cancelBroadcast(ctx) {
        sessionManager.clearBroadcastDraft(ctx.from.id);
        
        await ctx.answerCbQuery('Broadcast dibatalkan');
        await ctx.editMessageText(
            '❌ Broadcast dibatalkan.',
            {
                ...Markup.inlineKeyboard([[
                    Markup.button.callback('« Kembali', 'admin_menu')
                ]])
            }
        );
    }

    getActiveBroadcasts() {
        return Array.from(this.activeBroadcasts.entries()).map(([id, data]) => ({
            id,
            ...data,
            duration: Date.now() - data.startedAt
        }));
    }

    async showBroadcastPrompt(ctx) {
        sessionManager.setState(ctx.from.id, 'waiting_broadcast_message');

        await ctx.editMessageText(
            `📢 <b>Broadcast Message</b>\n\n` +
            `Kirimkan pesan yang ingin di-broadcast ke semua user.\n\n` +
            `💡 Tips:\n` +
            `• Bisa pakai formatting (bold, italic, dll)\n` +
            `• Max 4096 karakter\n` +
            `• Foto/video belum didukung`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[
                    Markup.button.callback('« Batal', 'admin_menu')
                ]])
            }
        );
    }

    async handleBroadcastMessage(ctx) {
        const state = sessionManager.getState(ctx.from.id);
        
        if (state !== 'waiting_broadcast_message') {
            return false;
        }

        const message = ctx.message.text;
        const entities = ctx.message.entities || [];

        sessionManager.clearState(ctx.from.id);

        await this.initiateBroadcast(ctx, message, entities);
        
        return true;
    }
}

export default new BroadcastHandler();

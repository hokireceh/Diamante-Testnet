// File: handlers/broadcastHandler.js
// Broadcast handler untuk mass messaging di Diamante Bot

import { Markup } from 'telegraf';
import logger from '../utils/logger.js';
import userManager from '../utils/userManager.js';
import validationHelper from '../utils/validationHelper.js';
import auditLogger from '../utils/auditLogger.js';
import analyticsHelper from '../utils/analyticsHelper.js';
import SmartBroadcaster from '../services/smartBroadcaster.js';
import sessionManager from '../middleware/session.js';

class BroadcastHandler {
    constructor() {
        this.activeBroadcasts = new Map();
    }

    async initiateBroadcast(ctx, message, entities = [], mediaInfo = null) {
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
                mediaInfo,
                type: mediaInfo ? 'media' : 'text',
                targetCount: userCount
            });

            const previewMsg = await ctx.reply('📋 <b>Preview Pesan:</b>', { parse_mode: 'HTML' });
            
            if (mediaInfo) {
                // Preview media dengan caption
                const caption = message || '(No caption)';
                const mediaOptions = {
                    caption: caption,
                    reply_to_message_id: previewMsg.message_id
                };
                
                if (entities && entities.length > 0) {
                    mediaOptions.caption_entities = entities;
                }

                try {
                    switch (mediaInfo.type) {
                        case 'photo':
                            await ctx.telegram.sendPhoto(ctx.chat.id, mediaInfo.file_id, mediaOptions);
                            break;
                        case 'video':
                            await ctx.telegram.sendVideo(ctx.chat.id, mediaInfo.file_id, mediaOptions);
                            break;
                        case 'document':
                            await ctx.telegram.sendDocument(ctx.chat.id, mediaInfo.file_id, mediaOptions);
                            break;
                        case 'audio':
                            await ctx.telegram.sendAudio(ctx.chat.id, mediaInfo.file_id, mediaOptions);
                            break;
                        case 'animation':
                            await ctx.telegram.sendAnimation(ctx.chat.id, mediaInfo.file_id, mediaOptions);
                            break;
                        case 'voice':
                            await ctx.telegram.sendVoice(ctx.chat.id, mediaInfo.file_id, { reply_to_message_id: previewMsg.message_id });
                            if (caption && caption !== '(No caption)') {
                                const textOptions = { reply_to_message_id: previewMsg.message_id };
                                if (entities && entities.length > 0) {
                                    textOptions.entities = entities;
                                }
                                await ctx.telegram.sendMessage(ctx.chat.id, caption, textOptions);
                            }
                            break;
                    }
                } catch (e) {
                    logger.error(`Error sending media preview: ${e.message}`);
                }
            } else if (entities && entities.length > 0) {
                await ctx.reply(message, {
                    entities: entities,
                    reply_to_message_id: previewMsg.message_id
                });
            } else {
                await ctx.reply(message, {
                    reply_to_message_id: previewMsg.message_id
                });
            }

            const mediaInfo_text = mediaInfo ? `\n📁 <b>Media:</b> ${mediaInfo.type.toUpperCase()}` : '';
            const entityInfo = entities && entities.length > 0 
                ? `\n🎨 <b>Format:</b> ${entities.length} formatting entities`
                : '';

            await ctx.reply(
                `📊 <b>Konfirmasi Broadcast</b>\n\n` +
                `👥 Target: <b>${userCount}</b> users${mediaInfo_text}${entityInfo}\n\n` +
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

            logger.info(`Broadcast initiated by ${ctx.from.first_name}, targeting ${userCount} users${mediaInfo ? ` with ${mediaInfo.type}` : ''}`);

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
            const userIds = users.map(u => u.userId);

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

            // Initialize SmartBroadcaster
            const broadcaster = new SmartBroadcaster(bot.telegram);
            
            // Start broadcast (non-blocking)
            broadcaster.broadcast(userIds, draft.message, draft.mediaInfo || null, draft.entities || []);

            // Poll progress and update UI
            let lastUpdateAt = 0;
            const progressInterval = setInterval(async () => {
                const progress = broadcaster.getProgress();
                const { processed, success, failed, progressPercent } = progress;

                // Update active broadcast tracking
                const broadcast = this.activeBroadcasts.get(broadcastId);
                if (broadcast) {
                    broadcast.sent = success;
                    broadcast.failed = failed;
                }

                // Log to terminal setiap 5 processed
                if (processed % 5 === 0 && processed !== lastUpdateAt) {
                    logger.broadcastProgress('Broadcasting', {
                        processed,
                        success,
                        failed,
                        total: users.length,
                        remaining: progress.remaining
                    });
                }

                // Update Telegram setiap 10 user atau ketika progress berubah
                if (processed % 10 === 0 || processed === users.length || processed !== lastUpdateAt) {
                    lastUpdateAt = processed;

                    try {
                        const bar = '█'.repeat(Math.floor(progressPercent / 5)) + '░'.repeat(20 - Math.floor(progressPercent / 5));
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            statusMsg.message_id,
                            null,
                            `🔄 <b>Broadcasting...</b>\n\n` +
                            `[${bar}] ${progressPercent}%\n` +
                            `📊 Progress: ${processed}/${users.length}\n` +
                            `✅ Sent: ${success}\n` +
                            `❌ Failed: ${failed}\n` +
                            `⏱️ Time: ${progress.elapsedTime}s`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (e) {
                        if (!e.message?.includes('message is not modified')) {
                            logger.debug(`Update message error: ${e.message}`);
                        }
                    }
                }

                // Check if broadcast completed
                if (!progress.isProcessing) {
                    clearInterval(progressInterval);
                    await this.sendFinalBroadcastReport(ctx, broadcast, statusMsg, broadcaster, draft, adminId, adminName);
                    this.activeBroadcasts.delete(broadcastId);
                    sessionManager.clearBroadcastDraft(adminId);
                }
            }, 500); // Poll every 500ms

        } catch (error) {
            logger.error('Error executing broadcast:', error.message);
            await ctx.reply('❌ Gagal mengirim broadcast. Coba lagi.');
        }
    }

    async sendFinalBroadcastReport(ctx, broadcast, statusMsg, broadcaster, draft, adminId, adminName) {
        const finalStats = broadcaster.getProgress();
        const users = userManager.getBroadcastableUsers();
        const deliveryRate = users.length > 0 
            ? ((finalStats.success / users.length) * 100).toFixed(1)
            : 0;

        // Log to terminal
        logger.broadcast('COMPLETED', {
            sent: finalStats.success,
            failed: finalStats.failed,
            total: users.length
        });

        let finalMessage = `📊 <b>BROADCAST SELESAI</b>\n\n`;
        finalMessage += `👥 Total Target: ${users.length}\n`;
        finalMessage += `✅ Terkirim: ${finalStats.success}\n`;
        finalMessage += `❌ Gagal: ${finalStats.failed}\n`;
        finalMessage += `🚫 Blocked: ${finalStats.blocked}\n`;
        finalMessage += `🔄 Retries: ${finalStats.retries}\n`;
        finalMessage += `📈 Delivery Rate: <b>${deliveryRate}%</b>\n`;
        finalMessage += `⏱️ Duration: ${finalStats.elapsedTime}s`;

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

        // Log to audit and analytics
        auditLogger.logBroadcast(adminId, adminName, {
            total: users.length,
            sent: finalStats.success,
            failed: finalStats.failed,
            messagePreview: draft.message
        });

        analyticsHelper.trackBroadcast(finalStats.success, finalStats.failed);

        logger.broadcast('Completed', {
            sent: finalStats.success,
            failed: finalStats.failed,
            total: users.length
        });
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
            `Kirimkan pesan atau media yang ingin di-broadcast ke semua user.\n\n` +
            `💡 Support:\n` +
            `✅ Text dengan formatting (bold, italic, dll)\n` +
            `✅ Photo (📷)\n` +
            `✅ Video (🎥)\n` +
            `✅ Document (📄)\n` +
            `✅ Audio (🎵)\n` +
            `✅ Voice Message (🎤)\n` +
            `✅ GIF Animation (🎬)\n\n` +
            `💬 Bisa tambah caption ke media`,
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

        let message = ctx.message.text || ctx.message.caption || '';
        let entities = ctx.message.entities || ctx.message.caption_entities || [];
        let mediaInfo = null;

        // Check for media
        if (ctx.message.photo) {
            // Photo - get highest quality version (last one in array)
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            mediaInfo = {
                type: 'photo',
                file_id: photo.file_id,
                file_unique_id: photo.file_unique_id
            };
            entities = ctx.message.caption_entities || [];
        } else if (ctx.message.video) {
            mediaInfo = {
                type: 'video',
                file_id: ctx.message.video.file_id,
                file_unique_id: ctx.message.video.file_unique_id
            };
            entities = ctx.message.caption_entities || [];
        } else if (ctx.message.document) {
            mediaInfo = {
                type: 'document',
                file_id: ctx.message.document.file_id,
                file_unique_id: ctx.message.document.file_unique_id,
                file_name: ctx.message.document.file_name
            };
            entities = ctx.message.caption_entities || [];
        } else if (ctx.message.audio) {
            mediaInfo = {
                type: 'audio',
                file_id: ctx.message.audio.file_id,
                file_unique_id: ctx.message.audio.file_unique_id,
                title: ctx.message.audio.title,
                performer: ctx.message.audio.performer
            };
            entities = ctx.message.caption_entities || [];
        } else if (ctx.message.voice) {
            mediaInfo = {
                type: 'voice',
                file_id: ctx.message.voice.file_id,
                file_unique_id: ctx.message.voice.file_unique_id
            };
            entities = ctx.message.caption_entities || [];
        } else if (ctx.message.animation) {
            mediaInfo = {
                type: 'animation',
                file_id: ctx.message.animation.file_id,
                file_unique_id: ctx.message.animation.file_unique_id
            };
            entities = ctx.message.caption_entities || [];
        } else if (!ctx.message.text) {
            // No supported media or text
            await ctx.reply('❌ Tipe konten tidak didukung. Gunakan: Text, Photo, Video, Document, Audio, Voice, atau GIF.');
            return false;
        }

        if (!message && !mediaInfo) {
            await ctx.reply('❌ Pesan tidak boleh kosong!');
            return false;
        }

        sessionManager.clearState(ctx.from.id);

        await this.initiateBroadcast(ctx, message, entities, mediaInfo);
        
        return true;
    }
}

export default new BroadcastHandler();

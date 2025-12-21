// Smart Broadcaster dengan queue, rate limiting, dan retry logic
import logger from '../utils/logger.js';
import userManager from '../utils/userManager.js';

class SmartBroadcaster {
    constructor(telegram) {
        this.telegram = telegram;
        this.queue = [];
        this.processing = false;
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            retries: 0,
            blocked: 0,
            processed: 0,
            startTime: null,
            isProcessing: false,
            failedUsers: []
        };
        this.fileIdCache = new Map();
        this.rateLimit = 25; // messages per second
        this.maxRetries = 3;
    }

    async broadcast(targetUsers, message, mediaInfo = null, entities = []) {
        this.stats = {
            total: targetUsers.length,
            success: 0,
            failed: 0,
            retries: 0,
            blocked: 0,
            processed: 0,
            startTime: Date.now(),
            isProcessing: true,
            failedUsers: []
        };

        logger.info(`🚀 Starting smart broadcast to ${targetUsers.length} users`);

        // Push all users to queue
        for (const userId of targetUsers) {
            this.queue.push({
                userId,
                message,
                entities: entities && entities.length > 0 ? entities : undefined,
                mediaInfo: mediaInfo || null,
                retries: 0,
                addedAt: Date.now()
            });
        }

        // Start background processing
        if (!this.processing) {
            this.processQueue();
        }
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;

        const delayBetweenMessages = 1000 / this.rateLimit;
        
        logger.info(`⚡ Queue processing started: ${this.queue.length} jobs, rate: ${this.rateLimit}/s`);

        while (this.queue.length > 0) {
            const job = this.queue.shift();
            
            try {
                const result = await this.sendToUser(job);
                
                if (result === 'success') {
                    this.stats.success++;
                } else if (result === 'blocked') {
                    this.stats.blocked++;
                    this.stats.failed++;
                } else if (result === 'retry' && job.retries < this.maxRetries) {
                    job.retries++;
                    this.stats.retries++;
                    this.queue.push(job);
                } else {
                    this.stats.failed++;
                    this.stats.failedUsers.push(job.userId);
                }

            } catch (error) {
                logger.error(`❌ Unexpected error processing job for ${job.userId}:`, error.message);
                this.stats.failed++;
                this.stats.failedUsers.push(job.userId);
            } finally {
                this.stats.processed++;
            }

            // Rate limiting delay
            await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
        }

        this.stats.isProcessing = false;
        this.processing = false;
        
        const duration = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
        logger.success(`✅ Broadcast completed in ${duration}s - Success: ${this.stats.success}, Failed: ${this.stats.failed}, Blocked: ${this.stats.blocked}`);
    }

    async sendToUser(job) {
        try {
            if (job.mediaInfo) {
                await this.sendMedia(job.userId, job.message, job.mediaInfo, null, job.entities);
            } else {
                const options = { protect_content: true };
                
                if (job.entities && job.entities.length > 0) {
                    options.entities = job.entities;
                } 
                
                await this.telegram.sendMessage(job.userId, job.message, options);
            }
            
            return 'success';

        } catch (error) {
            const errorMsg = error.message?.toLowerCase() || '';
            
            // Check if user blocked bot or deactivated
            if (error.response?.error_code === 403 || 
                errorMsg.includes('blocked') || 
                errorMsg.includes('bot was blocked') ||
                errorMsg.includes('chat not found') ||
                errorMsg.includes('user is deactivated')) {
                
                userManager.removeUser(job.userId);
                logger.info(`🚫 User ${job.userId} blocked/deactivated - auto removed`);
                return 'blocked';
            }
            
            // Retry on rate limit or network errors
            if (error.response?.error_code === 429 || 
                errorMsg.includes('timeout') || 
                errorMsg.includes('network')) {
                
                logger.warn(`⚠️ Retryable error for user ${job.userId}: ${error.message}`);
                return 'retry';
            }
            
            logger.error(`❌ Failed to send to user ${job.userId}: ${error.message}`);
            return 'failed';
        }
    }

    async sendMedia(userId, caption, mediaInfo, parseMode = null, entities = []) {
        const options = {
            caption: caption,
            protect_content: true,
            has_spoiler: false
        };
        
        if (entities && entities.length > 0) {
            options.caption_entities = entities;
        }

        switch (mediaInfo.type) {
            case 'photo':
                await this.telegram.sendPhoto(userId, mediaInfo.file_id, options);
                break;
            case 'video':
                await this.telegram.sendVideo(userId, mediaInfo.file_id, options);
                break;
            case 'document':
                await this.telegram.sendDocument(userId, mediaInfo.file_id, options);
                break;
            case 'audio':
                await this.telegram.sendAudio(userId, mediaInfo.file_id, options);
                break;
            case 'animation':
                await this.telegram.sendAnimation(userId, mediaInfo.file_id, options);
                break;
            case 'voice':
                await this.telegram.sendVoice(userId, mediaInfo.file_id, { protect_content: true });
                if (caption) {
                    const msgOptions = { protect_content: true };
                    if (entities && entities.length > 0) {
                        msgOptions.entities = entities;
                    }
                    await this.telegram.sendMessage(userId, caption, msgOptions);
                }
                break;
            default:
                throw new Error(`Unsupported media type: ${mediaInfo.type}`);
        }
    }

    getProgress() {
        const elapsedTime = this.stats.startTime 
            ? ((Date.now() - this.stats.startTime) / 1000).toFixed(1)
            : 0;
        
        const progressPercent = this.stats.total > 0
            ? Math.round((this.stats.processed / this.stats.total) * 100)
            : 0;

        return {
            ...this.stats,
            elapsedTime,
            progressPercent,
            remaining: this.queue.length
        };
    }

    reset() {
        this.queue = [];
        this.processing = false;
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            retries: 0,
            blocked: 0,
            processed: 0,
            startTime: null,
            isProcessing: false,
            failedUsers: []
        };
    }
}

export default SmartBroadcaster;

// File: services/broadcastQueueManager.js
// Broadcast queue management dengan circuit breaker untuk Diamante Bot

import logger from '../utils/logger.js';

class BroadcastQueueManager {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.currentConcurrent = 0;
        this.maxConcurrent = 5;
        
        this.consecutiveFailures = 0;
        this.maxConsecutiveFailures = 10;
        this.circuitBreakerOpen = false;
        this.circuitBreakerTimeout = null;
        
        this.stats = {
            totalProcessed: 0,
            totalSuccess: 0,
            totalFailed: 0,
            totalRetries: 0
        };
        
        this.onProgress = null;
        this.onComplete = null;
    }

    async addToQueue(task, priority = 0) {
        const queueItem = {
            task,
            priority,
            retries: 0,
            maxRetries: 3,
            addedAt: Date.now()
        };

        if (priority > 0) {
            const insertIndex = this.queue.findIndex(item => item.priority < priority);
            if (insertIndex === -1) {
                this.queue.push(queueItem);
            } else {
                this.queue.splice(insertIndex, 0, queueItem);
            }
        } else {
            this.queue.push(queueItem);
        }

        if (!this.processing) {
            this.processQueue();
        }

        return queueItem;
    }

    async addBatch(tasks, priority = 0) {
        for (const task of tasks) {
            await this.addToQueue(task, priority);
        }
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            if (this.circuitBreakerOpen) {
                logger.warn('Circuit breaker open, pausing queue...');
                await this._wait(5000);
                continue;
            }

            while (this.currentConcurrent < this.maxConcurrent && this.queue.length > 0) {
                const queueItem = this.queue.shift();
                this.currentConcurrent++;

                this._processTask(queueItem)
                    .then(() => {
                        this.currentConcurrent--;
                        this.consecutiveFailures = 0;
                    })
                    .catch(error => {
                        this.currentConcurrent--;
                        this.consecutiveFailures++;

                        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
                            this._openCircuitBreaker();
                        }

                        logger.error(`Queue task failed: ${error.message}`);
                    });
            }

            await this._wait(100);
        }

        this.processing = false;
        
        if (this.onComplete) {
            this.onComplete(this.getStats());
        }
    }

    async _processTask(queueItem) {
        const { task, retries, maxRetries } = queueItem;

        try {
            await task();
            this.stats.totalSuccess++;
            this.stats.totalProcessed++;
            
            if (this.onProgress) {
                this.onProgress({
                    processed: this.stats.totalProcessed,
                    success: this.stats.totalSuccess,
                    failed: this.stats.totalFailed,
                    remaining: this.queue.length
                });
            }
        } catch (error) {
            if (this._isRetryable(error) && retries < maxRetries) {
                queueItem.retries++;
                this.stats.totalRetries++;
                
                const delay = this._getRetryDelay(retries);
                await this._wait(delay);
                
                this.queue.unshift(queueItem);
            } else {
                this.stats.totalFailed++;
                this.stats.totalProcessed++;
                throw error;
            }
        }
    }

    _isRetryable(error) {
        const message = error.message?.toLowerCase() || '';
        
        const retryableErrors = [
            'timeout',
            'etimedout',
            'rate limit',
            'too many requests',
            'network',
            'econnreset',
            'flood'
        ];
        
        return retryableErrors.some(e => message.includes(e));
    }

    _getRetryDelay(retryCount) {
        const baseDelay = 1000;
        const maxDelay = 30000;
        const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
        
        return delay + Math.random() * 1000;
    }

    _openCircuitBreaker() {
        logger.warn('Opening circuit breaker due to consecutive failures');
        this.circuitBreakerOpen = true;
        
        if (this.circuitBreakerTimeout) {
            clearTimeout(this.circuitBreakerTimeout);
        }
        
        this.circuitBreakerTimeout = setTimeout(() => {
            logger.info('Circuit breaker reset');
            this.circuitBreakerOpen = false;
            this.consecutiveFailures = 0;
            
            if (this.queue.length > 0 && !this.processing) {
                this.processQueue();
            }
        }, 30000);
    }

    _wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            processing: this.processing,
            currentConcurrent: this.currentConcurrent,
            circuitBreakerOpen: this.circuitBreakerOpen
        };
    }

    getQueueLength() {
        return this.queue.length;
    }

    isProcessing() {
        return this.processing;
    }

    clearQueue() {
        const cleared = this.queue.length;
        this.queue = [];
        logger.info(`Cleared ${cleared} items from queue`);
        return cleared;
    }

    resetStats() {
        this.stats = {
            totalProcessed: 0,
            totalSuccess: 0,
            totalFailed: 0,
            totalRetries: 0
        };
    }

    setOnProgress(callback) {
        this.onProgress = callback;
    }

    setOnComplete(callback) {
        this.onComplete = callback;
    }
}

export default new BroadcastQueueManager();

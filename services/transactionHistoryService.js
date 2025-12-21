import logger from '../utils/logger.js';
import fs from 'fs';
import cloudscraper from 'cloudscraper';

const API_BASE = 'https://campapi.diamante.io/api/v1/transaction';
const PROCESSED_FILE = 'processed_transactions.json';

const cloudscraperDefaults = {
  resolveWithFullResponse: true,
  cloudflareMaxTimeout: 30000,
  followAllRedirects: true,
  challengesToSolve: 3
};

const BLOCKED_ADDRESSES = [
  '0x353d8aa05fd3edf8c24dcfb883405db21cbdec24'
];

function getRandomUserAgent() {
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  ];
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getDefaultHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.7',
    'Origin': 'https://campaign.diamante.io',
    'Referer': 'https://campaign.diamante.io/',
    'access-token': 'key',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  };
}

class TransactionHistoryService {
  constructor() {
    this.processedTransactions = new Set();
    this.successfulWallets = new Set(); // Track wallets that received transfers successfully
    this.loadProcessedTransactions();
    this.loadSuccessfulWallets();
  }

  loadProcessedTransactions() {
    try {
      if (fs.existsSync(PROCESSED_FILE)) {
        const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf-8'));
        if (Array.isArray(data)) {
          this.processedTransactions = new Set(data);
          logger.info(`Loaded ${data.length} processed transactions`);
        }
      }
    } catch (error) {
      logger.warn(`Error loading processed transactions: ${error.message}`);
    }
  }

  loadSuccessfulWallets() {
    try {
      const AUTO_TRANSFER_FILE = 'auto_transfer_log.json';
      if (fs.existsSync(AUTO_TRANSFER_FILE)) {
        const data = JSON.parse(fs.readFileSync(AUTO_TRANSFER_FILE, 'utf-8'));
        if (data.transfers && Array.isArray(data.transfers)) {
          data.transfers.forEach(t => {
            if (t.status === 'success' && t.toAddress) {
              this.successfulWallets.add(t.toAddress.toLowerCase());
            }
          });
          logger.info(`Loaded ${this.successfulWallets.size} wallets with successful transfers`);
        }
      }
    } catch (error) {
      logger.warn(`Error loading successful wallets: ${error.message}`);
    }
  }

  saveProcessedTransactions() {
    try {
      const data = Array.from(this.processedTransactions);
      fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error(`Error saving processed transactions: ${error.message}`);
    }
  }

  isWalletAlreadySuccessful(address) {
    return this.successfulWallets.has(address.toLowerCase());
  }

  markWalletAsSuccessful(address) {
    this.successfulWallets.add(address.toLowerCase());
  }

  async fetchHistory(userId, accessToken, limit = 100, offset = 0, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await cloudscraper({
          ...cloudscraperDefaults,
          method: 'POST',
          uri: `${API_BASE}/history`,
          headers: {
            ...getDefaultHeaders(),
            'Cookie': `access_token=${accessToken}`
          },
          body: {
            userId,
            limit,
            offset
          },
          json: true
        });

        const data = response.body;
        const status = response.statusCode;
        
        // Handle Cloudflare 403
        if (status === 403 && (typeof data === 'string' && data.includes('Cloudflare'))) {
          lastError = { status: 403, message: 'Cloudflare blocked' };
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            logger.warn(`⏱️ [history ${attempt}/${maxRetries}] CF 403, retry in ${delay/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        if (!data.status || data.status !== 'success') {
          logger.warn(`Failed to fetch transaction history: ${data.message || 'Unknown error'}`);
          return { success: false, transactions: [] };
        }

        return {
          success: true,
          transactions: data.data?.transactions || [],
          pagination: data.data?.pagination || {}
        };
      } catch (error) {
        lastError = error;
        logger.warn(`Transaction history fetch attempt ${attempt}/${maxRetries}: ${error.message}`);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
    }
    
    return { success: false, transactions: [] };
  }

  /**
   * Get incoming transfers that need to be matched with outgoing transfers
   * Returns: Array of {fromAddress, amount, transactionId, confirmedAt}
   */
  async getUnprocessedIncomingTransfers(userId, accessToken, ownAddress) {
    try {
      const result = await this.fetchHistory(userId, accessToken, 100, 0);
      
      if (!result.success) {
        return { success: false, transfers: [] };
      }

      const transfers = [];
      const transactions = result.transactions || [];

      // Get all confirmed incoming transfers of >= 1 DIAM that haven't been processed yet
      // Filter out: blocked addresses (faucet), zero fees (faucet), large amounts
      transactions.forEach(tx => {
        const amount = parseFloat(tx.amount);
        const fee = parseFloat(tx.fee) || 0;
        const fromAddress = tx.from?.toLowerCase();
        
        // Skip if from blocked address (faucet)
        if (BLOCKED_ADDRESSES.some(addr => addr.toLowerCase() === fromAddress)) {
          logger.debug(`Skipping faucet transaction from ${tx.from}: ${amount} DIAM`);
          // Mark as processed so we don't keep checking it
          if (!this.isProcessed(tx.id)) {
            this.markAsProcessed(tx.id);
          }
          return;
        }
        
        // Skip if fee is 0 (faucet transactions have no fee)
        if (fee === 0) {
          logger.debug(`Skipping zero-fee transaction (faucet): ${amount} DIAM from ${tx.from}`);
          if (!this.isProcessed(tx.id)) {
            this.markAsProcessed(tx.id);
          }
          return;
        }
        
        if (
          tx.status === 'confirmed' &&
          tx.to?.toLowerCase() === ownAddress?.toLowerCase() &&
          tx.from &&
          amount >= 1 &&
          !this.isProcessed(tx.id)
        ) {
          transfers.push({
            id: tx.id,
            fromAddress: tx.from,
            amount: amount,
            confirmedAt: tx.confirmedAt
          });
        }
      });

      return {
        success: true,
        transfers: transfers
      };
    } catch (error) {
      logger.error(`Get unprocessed incoming transfers error: ${error.message}`);
      return { success: false, transfers: [] };
    }
  }

  /**
   * Get FRESH incoming transfers directly from API (for accurate manual validation)
   * Fetches only the first 20 recent entries (default API limit)
   * Filters: TO wallet, confirmed, amount >= 1 DIAM
   */
  async getFreshIncomingTransfers(userId, accessToken, ownAddress) {
    try {
      const transfers = [];
      
      // Fetch only first page (20 items) - most recent transfers
      const result = await this.fetchHistory(userId, accessToken, 20, 0);
      
      if (!result.success || !result.transactions) {
        return { success: false, transfers: [] };
      }

      const transactions = result.transactions;

      // Get confirmed INCOMING transfers of exactly 1 DIAM TO own address
      // Skip: < 1 DIAM (too small), > 1 DIAM (too large), blocked addresses, zero fee
      transactions.forEach(tx => {
        const amount = parseFloat(tx.amount);
        const fee = parseFloat(tx.fee) || 0;
        const fromAddress = tx.from?.toLowerCase();
        
        // Skip blocked addresses (faucet wallet)
        if (BLOCKED_ADDRESSES.some(addr => addr.toLowerCase() === fromAddress)) {
          return;
        }
        
        // Skip zero-fee transactions (faucet)
        if (fee === 0) {
          return;
        }
        
        if (
          tx.status === 'confirmed' &&
          tx.to?.toLowerCase() === ownAddress?.toLowerCase() &&
          tx.from &&
          amount >= 1
        ) {
          transfers.push({
            id: tx.id,
            fromAddress: tx.from,
            amount: amount,
            confirmedAt: tx.confirmedAt
          });
        }
      });

      logger.info(`Fetched ${transfers.length} fresh incoming transfers from 20 most recent`);

      return {
        success: true,
        transfers: transfers
      };
    } catch (error) {
      logger.error(`Get fresh incoming transfers error: ${error.message}`);
      return { success: false, transfers: [] };
    }
  }

  /**
   * Compare transfers: get what specific wallet sent vs what bot sent back
   * Returns: incoming count, outgoing count, and deficit
   * Fetches only first 20 recent entries
   */
  async compareWalletTransfers(userId, accessToken, ownAddress, walletAddress) {
    try {
      const incoming = [];
      const outgoing = [];
      
      const normalizedWallet = walletAddress.toLowerCase();

      // Fetch only first page (20 items) - most recent transactions
      const result = await this.fetchHistory(userId, accessToken, 20, 0);
      
      if (!result.success || !result.transactions) {
        return { success: false, error: 'Failed to fetch transactions' };
      }

      const transactions = result.transactions;

      transactions.forEach(tx => {
        const amount = parseFloat(tx.amount);
        const fee = parseFloat(tx.fee) || 0;
        
        // Only process transfers of >= 1 DIAM (skip zero-fee faucet)
        if (tx.status === 'confirmed' && amount >= 1 && fee > 0) {
          // Incoming: FROM wallet TO bot
          if (
            tx.to?.toLowerCase() === ownAddress?.toLowerCase() &&
            tx.from?.toLowerCase() === normalizedWallet
          ) {
            incoming.push({
              id: tx.id,
              amount: amount,
              timestamp: tx.confirmedAt
            });
          }

          // Outgoing: FROM bot TO wallet
          if (
            tx.from?.toLowerCase() === ownAddress?.toLowerCase() &&
            tx.to?.toLowerCase() === normalizedWallet
          ) {
            outgoing.push({
              id: tx.id,
              amount: amount,
              timestamp: tx.confirmedAt
            });
          }
        }
      });

      const incomingCount = incoming.length;
      const outgoingCount = outgoing.length;
      const deficit = incomingCount - outgoingCount;

      return {
        success: true,
        wallet: walletAddress,
        incoming: {
          count: incomingCount,
          total: incoming.reduce((sum, t) => sum + t.amount, 0),
          transfers: incoming
        },
        outgoing: {
          count: outgoingCount,
          total: outgoing.reduce((sum, t) => sum + t.amount, 0),
          transfers: outgoing
        },
        deficit: Math.max(0, deficit)
      };
    } catch (error) {
      logger.error(`Compare wallet transfers error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Group incoming transfers by wallet address
   * Returns: {walletAddress: {count: X, totalAmount: Y, transfers: [{id, amount, confirmedAt}]}}
   */
  groupTransfersByWallet(transfers) {
    const grouped = {};
    
    transfers.forEach(transfer => {
      const addr = transfer.fromAddress.toLowerCase();
      if (!grouped[addr]) {
        grouped[addr] = {
          address: transfer.fromAddress,
          count: 0,
          totalAmount: 0,
          transfers: []
        };
      }
      grouped[addr].count += 1;
      grouped[addr].totalAmount += transfer.amount;
      grouped[addr].transfers.push({
        id: transfer.id,
        amount: transfer.amount,
        confirmedAt: transfer.confirmedAt
      });
    });

    return Object.values(grouped);
  }

  /**
   * Mark transaction as processed
   */
  markAsProcessed(transactionId) {
    this.processedTransactions.add(transactionId);
    this.saveProcessedTransactions();
  }

  /**
   * Mark multiple transactions as processed
   */
  markMultipleAsProcessed(transactionIds) {
    transactionIds.forEach(id => this.processedTransactions.add(id));
    this.saveProcessedTransactions();
  }

  isProcessed(transactionId) {
    return this.processedTransactions.has(transactionId);
  }

  getProcessedCount() {
    return this.processedTransactions.size;
  }
}

export default new TransactionHistoryService();

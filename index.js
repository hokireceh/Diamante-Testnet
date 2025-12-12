// ============================================================
// DIAMANTE AUTO TRANSFER BOT - MODULAR ARCHITECTURE
// Refactored with: LiveChat, Broadcast, Analytics, Audit Logging
// ============================================================

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';

// Import utilities
import logger from './utils/logger.js';
import errorHandler from './utils/errorHandler.js';
import validationHelper from './utils/validationHelper.js';
import userManager from './utils/userManager.js';
import auditLogger from './utils/auditLogger.js';
import analyticsHelper from './utils/analyticsHelper.js';

// Import middleware
import sessionManager from './middleware/session.js';
import securityMiddleware from './middleware/security.js';
import rateLimiter from './middleware/rateLimiting.js';

// Import services
import liveChatManager from './services/liveChatManager.js';
import broadcastQueueManager from './services/broadcastQueueManager.js';

// Import handlers
import broadcastHandler from './handlers/broadcastHandler.js';
import liveChatHandler from './handlers/liveChatHandler.js';

// ============================================================
// CONFIGURATION
// ============================================================

const API_BASE = 'https://campapi.diamante.io/api/v1/transaction';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://camp.diamante.io',
  'Referer': 'https://camp.diamante.io/'
};

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const USER_ID = process.env.USER_ID;
const PRIMARY_ADMIN_ID = process.env.ADMIN_ID;

if (!BOT_TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN tidak ditemukan di environment variables!');
  process.exit(1);
}

if (!PRIMARY_ADMIN_ID) {
  logger.warn('ADMIN_ID tidak ditemukan di .env - bot akan berjalan tanpa super admin');
}

// ============================================================
// BOT INITIALIZATION
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

// Register handlers with bot reference
liveChatHandler.setBot(bot);
liveChatHandler.registerHandlers(bot);

// ============================================================
// MIDDLEWARE SETUP
// ============================================================

// Security middleware
bot.use(securityMiddleware.middleware());

// Rate limiting middleware
bot.use(rateLimiter.middleware());

// Session middleware
bot.use(sessionManager.middleware());

// Logging middleware
bot.use((ctx, next) => {
  const user = ctx.from?.first_name || 'Unknown';
  const userId = ctx.from?.id;
  const action = ctx.callbackQuery?.data || ctx.message?.text?.slice(0, 30) || '-';
  
  if (action !== '-') {
    logger.debug(`${user}: ${action}`);
  }
  
  // Track user
  if (userId) {
    userManager.trackUser(userId, {
      firstName: ctx.from.first_name,
      username: ctx.from.username
    });
  }
  
  return next();
});

// ============================================================
// DATA FILES
// ============================================================

const ADDITIONAL_ADMINS_FILE = 'admins.json';
const WALLETS_FILE = 'wallets.json';
const USER_WALLETS_FILE = 'user_wallets.json';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function loadJSON(file, defaultValue = []) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (e) {
    logger.error(`Error loading ${file}:`, e.message);
  }
  return defaultValue;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getAdditionalAdmins() {
  return loadJSON(ADDITIONAL_ADMINS_FILE, []);
}

function isPrimaryAdmin(userId) {
  return PRIMARY_ADMIN_ID && userId.toString() === PRIMARY_ADMIN_ID.toString();
}

function isAdmin(userId) {
  if (isPrimaryAdmin(userId)) return true;
  const additionalAdmins = getAdditionalAdmins();
  return additionalAdmins.includes(userId.toString());
}

function addAdmin(userId) {
  if (isPrimaryAdmin(userId)) return { success: false, reason: 'primary' };
  const admins = getAdditionalAdmins();
  if (!admins.includes(userId.toString())) {
    admins.push(userId.toString());
    saveJSON(ADDITIONAL_ADMINS_FILE, admins);
    return { success: true };
  }
  return { success: false, reason: 'exists' };
}

function removeAdmin(userId) {
  if (isPrimaryAdmin(userId)) return { success: false, reason: 'primary' };
  let admins = getAdditionalAdmins();
  const index = admins.indexOf(userId.toString());
  if (index > -1) {
    admins.splice(index, 1);
    saveJSON(ADDITIONAL_ADMINS_FILE, admins);
    return { success: true };
  }
  return { success: false, reason: 'not_found' };
}

function getWallets() {
  return loadJSON(WALLETS_FILE, []);
}

function saveWallets(wallets) {
  saveJSON(WALLETS_FILE, wallets);
}

function getUserWallets() {
  return loadJSON(USER_WALLETS_FILE, {});
}

function saveUserWallets(data) {
  saveJSON(USER_WALLETS_FILE, data);
}

function addWallet(address, userId, amount = 0.001) {
  const wallets = getWallets();
  const normalizedAddress = address.toLowerCase();
  
  const exists = wallets.some(w => w.address.toLowerCase() === normalizedAddress);
  if (exists) return { success: false, reason: 'duplicate' };
  
  if (!validationHelper.isValidWalletAddress(address)) {
    return { success: false, reason: 'invalid' };
  }
  
  wallets.push({ address, amount });
  saveWallets(wallets);
  
  const userWallets = getUserWallets();
  if (!userWallets[userId]) userWallets[userId] = [];
  userWallets[userId].push(address);
  saveUserWallets(userWallets);
  
  return { success: true };
}

function removeWallet(address) {
  let wallets = getWallets();
  const normalizedAddress = address.toLowerCase();
  const initialLength = wallets.length;
  
  wallets = wallets.filter(w => w.address.toLowerCase() !== normalizedAddress);
  
  if (wallets.length < initialLength) {
    saveWallets(wallets);
    return true;
  }
  return false;
}

// ============================================================
// API FUNCTIONS
// ============================================================

async function getBalance() {
  const response = await fetch(`${API_BASE}/get-balance/${USER_ID}`, {
    headers: { ...DEFAULT_HEADERS, 'Cookie': `access_token=${ACCESS_TOKEN}` }
  });
  return response.json();
}

async function claimFaucet() {
  const response = await fetch(`${API_BASE}/fund-wallet/${USER_ID}`, {
    headers: { ...DEFAULT_HEADERS, 'Cookie': `access_token=${ACCESS_TOKEN}` }
  });
  return response.json();
}

async function claimMysteryBox() {
  try {
    const response = await fetch(`https://campapi.diamante.io/api/v1/mystery/claim/${USER_ID}`, {
      method: 'POST',
      headers: { ...DEFAULT_HEADERS, 'Cookie': `access_token=${ACCESS_TOKEN}` }
    });
    
    if (!response.ok) return { success: false, message: `API Error: ${response.status}` };
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return { success: false, message: 'Invalid response format' };
    }
    
    return await response.json();
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function getTweetContent() {
  try {
    const response = await fetch(`https://campapi.diamante.io/api/v1/transaction/tweet-content/${USER_ID}`, {
      headers: { ...DEFAULT_HEADERS, 'Cookie': `access_token=${ACCESS_TOKEN}` }
    });
    
    if (!response.ok) return { success: false, message: `API Error: ${response.status}` };
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return { success: false, message: 'Invalid response format' };
    }
    
    return await response.json();
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function transfer(toAddress, amount) {
  const response = await fetch(`${API_BASE}/transfer`, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Cookie': `access_token=${ACCESS_TOKEN}` },
    body: JSON.stringify({ toAddress, amount, userId: USER_ID })
  });
  return response.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomJitter(baseMs) {
  return baseMs + Math.floor(Math.random() * 2000);
}

async function transferWithRetry(toAddress, amount, maxRetries = 7) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await transfer(toAddress, amount);
      
      if (result.success) {
        analyticsHelper.trackTransfer(true, amount);
        return { success: true, result, attempts: attempt };
      }
      
      const errorMsg = result.message || '';
      if (errorMsg.includes('Internal database error') || 
          errorMsg.includes('timeout') || 
          errorMsg.includes('Rate limit') || 
          errorMsg.includes('network guardians') || 
          errorMsg.includes('syncing')) {
        lastError = result;
        if (attempt < maxRetries) {
          let delayMs;
          if (errorMsg.includes('Rate limit')) {
            delayMs = randomJitter(15000 * attempt);
          } else if (errorMsg.includes('Internal database error')) {
            delayMs = randomJitter(12000 * attempt);
          } else if (errorMsg.includes('network guardians') || errorMsg.includes('syncing')) {
            delayMs = randomJitter(10000 * attempt);
          } else {
            delayMs = randomJitter(5000 * attempt);
          }
          await sleep(delayMs);
          continue;
        }
      }
      
      analyticsHelper.trackTransfer(false, amount);
      return { success: false, result, attempts: attempt };
    } catch (error) {
      lastError = { message: error.message };
      if (attempt < maxRetries) {
        await sleep(2000 * attempt);
        continue;
      }
    }
  }
  
  analyticsHelper.trackTransfer(false, amount);
  return { success: false, result: lastError, attempts: maxRetries };
}

// ============================================================
// MENU HELPERS
// ============================================================

function getMainMenu(userId) {
  const isUserAdmin = isAdmin(userId);
  const buttons = [
    [Markup.button.callback('📫 Tambah Wallet', 'add_wallet')],
    [Markup.button.callback('🚰 Faucet', 'user_transfer')],
    [Markup.button.callback('📋 Wallet Saya', 'my_wallets'), Markup.button.callback('📊 Statistik', 'stats')],
    [Markup.button.callback('❓ Bantuan', 'help')]
  ];
  
  if (isUserAdmin) {
    buttons.push([Markup.button.callback('🔐 Menu Admin', 'admin_menu')]);
  }
  
  return Markup.inlineKeyboard(buttons);
}

function getAdminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 Cek Balance', 'balance'), Markup.button.callback('🚰 Claim Faucet', 'faucet')],
    [Markup.button.callback('⚡ Single Transfer', 'single_transfer'), Markup.button.callback('🚀 Batch Transfer', 'transfer')],
    [Markup.button.callback('📢 Broadcast', 'broadcast'), Markup.button.callback('💬 Live Chat', 'livechat_menu')],
    [Markup.button.callback('📋 Lihat Wallets', 'wallets'), Markup.button.callback('👥 Lihat Admin', 'admins')],
    [Markup.button.callback('📈 Analytics', 'analytics')],
    [Markup.button.callback('« Kembali', 'main_menu')]
  ]);
}

// ============================================================
// BOT HANDLERS - MAIN MENU
// ============================================================

bot.command('start', (ctx) => {
  const userId = ctx.from.id;
  sessionManager.clearState(userId);
  
  analyticsHelper.trackCommand(userId, 'start');
  
  let message = `🚀 *Diamante Auto Transfer Bot*\n\n`;
  message += `Selamat datang, ${ctx.from.first_name}!\n\n`;
  message += `Pilih menu di bawah ini:`;
  
  ctx.replyWithMarkdown(message, getMainMenu(userId));
});

bot.action('main_menu', (ctx) => {
  const userId = ctx.from.id;
  sessionManager.clearState(userId);
  
  ctx.editMessageText(
    `🚀 *Diamante Auto Transfer Bot*\n\nPilih menu di bawah ini:`,
    { parse_mode: 'Markdown', ...getMainMenu(userId) }
  );
  ctx.answerCbQuery();
});

bot.action('add_wallet', (ctx) => {
  const userId = ctx.from.id;
  sessionManager.setState(userId, 'waiting_wallet');
  
  ctx.editMessageText(
    `📫 *Tambah Wallet*\n\nKirimkan alamat wallet kamu:\n\n_(Format: 0x... dengan 42 karakter)_`,
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
    }
  );
  ctx.answerCbQuery();
});

bot.action('my_wallets', (ctx) => {
  const userId = ctx.from.id.toString();
  const userWalletsData = getUserWallets();
  const myWallets = userWalletsData[userId] || [];
  
  let message;
  if (myWallets.length === 0) {
    message = `📭 Kamu belum menambahkan wallet apapun.`;
  } else {
    message = `📋 *Wallet Kamu:*\n\n`;
    myWallets.forEach((addr, i) => {
      const shortAddr = addr.slice(0, 10) + '...' + addr.slice(-6);
      message += `${i + 1}. \`${shortAddr}\`\n`;
    });
    message += `\n📊 Total: ${myWallets.length} wallet`;
  }
  
  ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📫 Tambah Wallet', 'add_wallet')],
      [Markup.button.callback('« Kembali', 'main_menu')]
    ])
  });
  ctx.answerCbQuery();
});

bot.action('stats', (ctx) => {
  const wallets = getWallets();
  const userWalletsData = getUserWallets();
  const totalUsers = Object.keys(userWalletsData).length;
  const userStats = userManager.getStats();
  
  ctx.editMessageText(
    `📊 *Statistik*\n\n` +
    `💼 Total Wallet: ${wallets.length}\n` +
    `👥 Contributors: ${totalUsers}\n` +
    `📈 Bot Users: ${userStats.total}\n` +
    `🟢 Active (7d): ${userStats.last7d}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
    }
  );
  ctx.answerCbQuery();
});

bot.action('help', (ctx) => {
  const message = `📖 *Cara Menggunakan Bot*\n\n` +
    `1️⃣ Klik "Tambah Wallet"\n` +
    `2️⃣ Kirimkan alamat wallet kamu\n` +
    `3️⃣ Tunggu konfirmasi\n\n` +
    `💡 Address harus dimulai dengan 0x dan 42 karakter`;
  
  ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
  });
  ctx.answerCbQuery();
});

bot.action('user_transfer', (ctx) => {
  if (!ACCESS_TOKEN || !USER_ID) {
    ctx.answerCbQuery('❌ Fitur belum tersedia');
    return;
  }
  
  const userId = ctx.from.id;
  sessionManager.setState(userId, 'waiting_user_transfer');
  
  ctx.editMessageText(
    `🚰 *Faucet - 0.01 DIAM*\n\n` +
    `Kirimkan alamat wallet tujuan:\n\n` +
    `_(Format: 0x... dengan 42 karakter)_`,
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
    }
  );
  ctx.answerCbQuery();
});

// ============================================================
// BOT HANDLERS - ADMIN MENU
// ============================================================

bot.action('admin_menu', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  ctx.editMessageText(
    `🔐 *Menu Admin*\n\nPilih aksi:`,
    { parse_mode: 'Markdown', ...getAdminMenu() }
  );
  ctx.answerCbQuery();
});

bot.action('single_transfer', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  if (!ACCESS_TOKEN || !USER_ID) {
    ctx.answerCbQuery('❌ Token belum dikonfigurasi');
    return;
  }
  
  const userId = ctx.from.id;
  sessionManager.setState(userId, 'waiting_single_transfer');
  
  ctx.editMessageText(
    `⚡ *Single Transfer*\n\n` +
    `Kirimkan address dan jumlah dengan format:\n\n` +
    `\`<address> <jumlah>\`\n\n` +
    `Contoh:\n\`0x1234...abcd 0.001\``,
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
    }
  );
  ctx.answerCbQuery();
});

bot.action('balance', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  if (!ACCESS_TOKEN || !USER_ID) {
    ctx.answerCbQuery('❌ Token belum dikonfigurasi');
    return;
  }
  
  ctx.answerCbQuery('🔍 Mengambil balance...');
  
  try {
    const result = await getBalance();
    
    let message;
    if (result.success) {
      message = `💎 *WALLET BALANCE*\n\n` +
        `📫 Address: \`${result.data.address}\`\n` +
        `💰 Balance: *${result.data.balance} DIAM*\n` +
        `🟢 Status: Active`;
    } else {
      message = `❌ Gagal mengambil balance: ${result.message || 'Unknown error'}`;
    }
    
    ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
    });
  } catch (error) {
    await errorHandler.handleError(error, ctx, 'balance');
  }
});

bot.action('faucet', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  if (!ACCESS_TOKEN || !USER_ID) {
    ctx.answerCbQuery('❌ Token belum dikonfigurasi');
    return;
  }
  
  ctx.answerCbQuery('🚰 Claiming faucet...');
  
  try {
    const result = await claimFaucet();
    
    let message;
    if (result.success) {
      message = `✅ *FAUCET CLAIMED!*\n\n🎉 Token berhasil di-claim!`;
    } else {
      message = `⏳ Faucet masih cooldown.`;
      if (result.data?.nextEligibleAt) {
        const nextClaim = new Date(result.data.nextEligibleAt);
        message += `\n\n⏰ Next claim: ${nextClaim.toLocaleString('id-ID')}`;
      }
    }
    
    ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
    });
  } catch (error) {
    await errorHandler.handleError(error, ctx, 'faucet');
  }
});

bot.action('wallets', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  const wallets = getWallets();
  
  let message;
  if (wallets.length === 0) {
    message = `📭 Tidak ada wallet di daftar.`;
  } else {
    message = `📋 *Daftar Wallet (${wallets.length})*\n\n`;
    const maxShow = 15;
    wallets.slice(0, maxShow).forEach((w, i) => {
      const shortAddr = w.address.slice(0, 10) + '...' + w.address.slice(-6);
      message += `${i + 1}. \`${shortAddr}\` (${w.amount} DIAM)\n`;
    });
    if (wallets.length > maxShow) {
      message += `\n... dan ${wallets.length - maxShow} wallet lainnya`;
    }
  }
  
  ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
  });
  ctx.answerCbQuery();
});

bot.action('admins', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  const additionalAdmins = getAdditionalAdmins();
  
  let message = `👥 *Daftar Admin*\n\n`;
  message += `👑 *Super Admin:*\n`;
  message += PRIMARY_ADMIN_ID ? `   \`${PRIMARY_ADMIN_ID}\`\n` : `   Tidak dikonfigurasi\n`;
  
  if (additionalAdmins.length > 0) {
    message += `\n📋 *Admin Tambahan:*\n`;
    additionalAdmins.forEach((id, i) => {
      message += `${i + 1}. \`${id}\`\n`;
    });
  }
  
  ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
  });
  ctx.answerCbQuery();
});

// ============================================================
// BOT HANDLERS - ANALYTICS
// ============================================================

bot.action('analytics', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  const transferStats = analyticsHelper.getTransferStats();
  const broadcastStats = analyticsHelper.getBroadcastStats();
  const userStats = analyticsHelper.getUserStats();
  const auditStats = auditLogger.getStats();
  
  let message = `📈 <b>Analytics Dashboard</b>\n\n`;
  
  message += `<b>🚀 Transfer Stats:</b>\n`;
  message += `• Total: ${transferStats.total}\n`;
  message += `• Success: ${transferStats.success}\n`;
  message += `• Failed: ${transferStats.failed}\n`;
  message += `• Rate: ${transferStats.successRate}\n`;
  message += `• Mystery XP: ${transferStats.mysteryXP}\n\n`;
  
  message += `<b>📢 Broadcast Stats:</b>\n`;
  message += `• Total: ${broadcastStats.total}\n`;
  message += `• Sent: ${broadcastStats.totalSent}\n`;
  message += `• Failed: ${broadcastStats.totalFailed}\n`;
  message += `• Delivery: ${broadcastStats.deliveryRate}\n\n`;
  
  message += `<b>👥 User Stats:</b>\n`;
  message += `• Commands: ${userStats.totalCommands}\n`;
  message += `• Today: ${userStats.uniqueUsersToday}\n\n`;
  
  message += `<b>📝 Audit (24h):</b>\n`;
  message += `• Actions: ${auditStats.last24hCount}\n`;
  message += `• Admins: ${auditStats.uniqueAdmins}`;
  
  await ctx.editMessageText(message, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'analytics')],
      [Markup.button.callback('« Kembali', 'admin_menu')]
    ])
  });
  ctx.answerCbQuery();
});

// ============================================================
// BOT HANDLERS - BATCH TRANSFER
// ============================================================

bot.action('transfer', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  if (!ACCESS_TOKEN || !USER_ID) {
    ctx.answerCbQuery('❌ Token belum dikonfigurasi');
    return;
  }
  
  const walletsRaw = getWallets();
  
  if (walletsRaw.length === 0) {
    await ctx.editMessageText('📭 Tidak ada wallet di daftar.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
    });
    ctx.answerCbQuery();
    return;
  }
  
  const validation = validationHelper.validateWallets(walletsRaw);
  const wallets = validation.valid;
  
  if (validation.invalid.length > 0) {
    logger.warn(`Found ${validation.invalid.length} invalid wallets`);
    const invalidMsg = `⚠️ <b>Ditemukan wallet tidak valid:</b>\n${validation.invalid.slice(0, 5).map(i => i.errors.join(', ')).join('\n')}`;
    await ctx.editMessageText(invalidMsg + `\n\n✅ Melanjutkan dengan ${wallets.length} wallet valid...`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
    });
    await sleep(2000);
  }
  
  if (wallets.length === 0) {
    await ctx.editMessageText('❌ Semua wallet tidak valid.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
    });
    ctx.answerCbQuery();
    return;
  }
  
  try {
    await ctx.answerCbQuery('✅ Memulai batch transfer...', { show_alert: true });
  } catch (e) {}
  
  const statusMsg = await ctx.editMessageText(
    `🔄 <b>Mempersiapkan batch transfer...</b>\n\n📊 Wallet: ${wallets.length}`,
    { parse_mode: 'HTML' }
  );
  
  const adminName = ctx.from.first_name;
  const adminId = ctx.from.id;
  
  logger.batch(`Starting batch transfer`, { total: wallets.length });
  
  let success = 0;
  let failed = 0;
  let totalMysteryXP = 0;
  let mysteryCount = 0;
  let lastUpdateIdx = 0;
  const delay = 3000;
  const failedWallets = [];
  
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    
    try {
      const { success: isSuccess, result, attempts } = await transferWithRetry(wallet.address, wallet.amount);
      
      if (isSuccess) {
        success++;
        if (attempts > 1) {
          logger.transfer(i + 1, wallets.length, 'success', `(${attempts} attempts)`);
        }
        
        try {
          const mysteryResult = await claimMysteryBox();
          if (mysteryResult.success && mysteryResult.data?.mysteryReward) {
            totalMysteryXP += mysteryResult.data.mysteryReward;
            mysteryCount++;
          }
          await getTweetContent();
        } catch (e) {}
      } else {
        failed++;
        failedWallets.push({
          idx: i + 1,
          address: wallet.address.slice(0, 10) + '...',
          error: result?.message || 'Unknown error'
        });
        logger.transfer(i + 1, wallets.length, 'failed', result?.message || 'Unknown error');
      }
    } catch (error) {
      failed++;
      failedWallets.push({
        idx: i + 1,
        address: wallet.address.slice(0, 10) + '...',
        error: error.message
      });
      logger.transfer(i + 1, wallets.length, 'failed', error.message);
    }
    
    if ((i + 1) % 10 === 0 && i !== lastUpdateIdx) {
      const progressMsg = 
        `🚀 <b>Batch Transfer Progress</b>\n\n` +
        `📊 Progress: ${i + 1}/${wallets.length}\n` +
        `✅ Success: ${success}\n` +
        `❌ Failed: ${failed}\n` +
        `📈 Rate: ${((success / (i + 1)) * 100).toFixed(1)}%`;
      
      try {
        await ctx.editMessageText(progressMsg, { parse_mode: 'HTML' });
        lastUpdateIdx = i;
      } catch (e) {
        if (!e.message?.includes('message is not modified')) {
          logger.warn(`Progress update error: ${e.message}`);
        }
      }
    }
    
    if (i < wallets.length - 1) {
      await sleep(delay);
    }
  }
  
  const successRate = ((success / wallets.length) * 100).toFixed(1);
  
  let finalMessage = `📊 <b>TRANSFER SUMMARY</b>\n\n`;
  finalMessage += `💼 Total Wallet: ${wallets.length}\n`;
  finalMessage += `✅ Success: ${success}\n`;
  finalMessage += `❌ Failed: ${failed}\n`;
  finalMessage += `📈 Success Rate: <b>${successRate}%</b>\n`;
  
  if (totalMysteryXP > 0) {
    finalMessage += `\n🎁 Mystery Rewards: ${totalMysteryXP} XP (${mysteryCount}x)\n`;
  }
  
  finalMessage += `\n⏰ Completed: ${new Date().toLocaleTimeString('id-ID')}`;
  
  await ctx.editMessageText(finalMessage, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
  });
  
  // Log to audit
  auditLogger.logTransfer(adminId, adminName, {
    total: wallets.length,
    success,
    failed,
    mysteryXP: totalMysteryXP
  });
  
  logger.batch('Completed', { success, failed, total: wallets.length });
});

// ============================================================
// BOT HANDLERS - BROADCAST
// ============================================================

bot.action('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  await broadcastHandler.showBroadcastPrompt(ctx);
  ctx.answerCbQuery();
});

bot.action('broadcast_confirm', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  await broadcastHandler.confirmBroadcast(ctx, bot);
});

bot.action('broadcast_cancel', async (ctx) => {
  await broadcastHandler.cancelBroadcast(ctx);
});

// ============================================================
// BOT HANDLERS - LIVE CHAT
// ============================================================

bot.action('livechat_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  await liveChatHandler.showLiveChatMenu(ctx);
});

bot.action('livechat_pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  await liveChatHandler.showPendingMessages(ctx);
});

bot.action('livechat_start_manual', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  await liveChatHandler.promptManualUserId(ctx);
});

bot.action('livechat_end', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  await liveChatHandler.endChat(ctx);
});

bot.action(/^livechat_reply_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.answerCbQuery('🔒 Akses ditolak');
    return;
  }
  
  const userId = ctx.match[1];
  await liveChatHandler.startChatWithUser(ctx, userId);
});

// ============================================================
// BOT HANDLERS - MESSAGE HANDLER
// ============================================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const state = sessionManager.getState(userId);
  
  // Skip commands
  if (text.startsWith('/')) return;
  
  // Track command
  analyticsHelper.trackCommand(userId, 'text_message');
  
  // Handle broadcast message input
  if (state === 'waiting_broadcast_message' && isAdmin(userId)) {
    const handled = await broadcastHandler.handleBroadcastMessage(ctx);
    if (handled) return;
  }
  
  // Handle livechat user ID input
  if (state === 'waiting_livechat_userid' && isAdmin(userId)) {
    const handled = await liveChatHandler.handleManualUserId(ctx);
    if (handled) return;
  }
  
  // Handle admin live chat reply
  if (isAdmin(userId)) {
    const handled = await liveChatHandler.handleAdminReply(ctx);
    if (handled) return;
  }
  
  // Handle wallet input
  if (state === 'waiting_wallet') {
    const address = text.trim();
    
    if (!validationHelper.isValidWalletAddress(address)) {
      return ctx.reply(
        '❌ Format wallet tidak valid!\n\nGunakan format: 0x... (42 karakter)',
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
      );
    }
    
    const result = addWallet(address, userId);
    sessionManager.clearState(userId);
    
    if (result.success) {
      ctx.reply(
        `✅ Wallet berhasil ditambahkan!\n\n📫 Address: \`${address}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
        }
      );
    } else if (result.reason === 'duplicate') {
      ctx.reply(
        '⚠️ Wallet sudah ada di daftar!',
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
      );
    } else {
      ctx.reply(
        '❌ Gagal menambahkan wallet.',
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
      );
    }
    return;
  }
  
  // Handle single transfer input
  if (state === 'waiting_single_transfer') {
    const parts = text.trim().split(/\s+/);
    
    if (parts.length < 2) {
      return ctx.reply(
        '❌ Format salah!\n\nGunakan: `<address> <jumlah>`\nContoh: `0x1234...abcd 0.001`',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
        }
      );
    }
    
    const address = parts[0];
    const amount = parseFloat(parts[1]);
    
    if (!validationHelper.isValidWalletAddress(address)) {
      return ctx.reply(
        '❌ Address tidak valid!\n\nFormat: 0x... (42 karakter)',
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
      );
    }
    
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply(
        '❌ Jumlah tidak valid!\n\nMasukkan angka positif.',
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
      );
    }
    
    sessionManager.clearState(userId);
    
    const msg = await ctx.reply(`⚡ Memproses transfer ${amount} DIAM ke ${address.slice(0, 10)}...`);
    
    try {
      const { success, result, attempts } = await transferWithRetry(address, amount);
      
      if (success) {
        const hash = result.data?.transferData?.hash || 'N/A';
        let message = `✅ *TRANSFER BERHASIL!*\n\n`;
        message += `📫 To: \`${address}\`\n`;
        message += `💰 Amount: ${amount} DIAM\n`;
        message += `🔗 Hash: \`${hash}\`\n`;
        if (attempts > 1) message += `🔄 Attempts: ${attempts}`;
        
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
        });
        
        try {
          const mysteryResult = await claimMysteryBox();
          if (mysteryResult.success && mysteryResult.data?.mysteryReward) {
            ctx.reply(`🎁 Mystery Box: +${mysteryResult.data.mysteryReward} ${mysteryResult.data.rewardType || 'XP'}`);
          }
        } catch (e) {}
      } else {
        const errorMsg = result?.message || 'Unknown error';
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `❌ Transfer gagal setelah ${attempts}x percobaan.\n\nError: ${errorMsg}`,
          Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
        );
      }
    } catch (error) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `❌ Error: ${error.message}`,
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'admin_menu')]])
      );
    }
    return;
  }
  
  // Handle user transfer input (hardcoded 0.01 DIAM)
  if (state === 'waiting_user_transfer') {
    const address = text.trim();
    
    if (!validationHelper.isValidWalletAddress(address)) {
      return ctx.reply(
        '❌ Address tidak valid!\n\nFormat: 0x... (42 karakter)',
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
      );
    }
    
    const amount = 0.01;
    sessionManager.clearState(userId);
    
    const msg = await ctx.reply(`⚡ Memproses transfer ${amount} DIAM ke ${address.slice(0, 10)}...`);
    
    try {
      const { success, result, attempts } = await transferWithRetry(address, amount);
      
      if (success) {
        const hash = result.data?.transferData?.hash || 'N/A';
        let message = `✅ *TRANSFER BERHASIL!*\n\n`;
        message += `📫 To: \`${address}\`\n`;
        message += `💰 Amount: ${amount} DIAM\n`;
        message += `🔗 Hash: \`${hash}\`\n`;
        if (attempts > 1) message += `🔄 Attempts: ${attempts}`;
        
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
        });
        
        try {
          const mysteryResult = await claimMysteryBox();
          if (mysteryResult.success && mysteryResult.data?.mysteryReward) {
            ctx.reply(`🎁 Mystery Box: +${mysteryResult.data.mysteryReward} ${mysteryResult.data.rewardType || 'XP'}`);
          }
        } catch (e) {}
      } else {
        const errorMsg = result?.message || 'Unknown error';
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `❌ Transfer gagal setelah ${attempts}x percobaan.\n\nError: ${errorMsg}`,
          Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
        );
      }
    } catch (error) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `❌ Error: ${error.message}`,
        Markup.inlineKeyboard([[Markup.button.callback('« Kembali', 'main_menu')]])
      );
    }
    return;
  }
  
  // Queue message for live chat (non-admin users)
  if (!isAdmin(userId)) {
    await liveChatHandler.handleUserMessage(ctx);
  }
});

// ============================================================
// BOT HANDLERS - COMMANDS
// ============================================================

bot.command('help', (ctx) => {
  const isUserAdmin = isAdmin(ctx.from.id);
  
  let message = `📖 *Diamante Auto Transfer Bot*\n\n`;
  message += `*User Commands:*\n`;
  message += `/start - Menu utama\n`;
  message += `/help - Bantuan\n`;
  message += `/mywallets - Lihat wallet kamu\n`;
  
  if (isUserAdmin) {
    message += `\n*Admin Commands:*\n`;
    message += `/balance - Cek balance\n`;
    message += `/faucet - Claim faucet\n`;
    message += `/transfer - Batch transfer\n`;
    message += `/single <addr> <amt> - Single transfer\n`;
    message += `/addwallet <addr> - Tambah wallet\n`;
    message += `/removewallet <addr> - Hapus wallet\n`;
    message += `/addadmin <id> - Tambah admin\n`;
    message += `/removeadmin <id> - Hapus admin\n`;
    message += `/admins - Lihat daftar admin\n`;
    message += `/endchat - Akhiri live chat\n`;
  }
  
  ctx.replyWithMarkdown(message);
});

bot.command('mywallets', (ctx) => {
  const userId = ctx.from.id.toString();
  const userWalletsData = getUserWallets();
  const myWallets = userWalletsData[userId] || [];
  
  let message;
  if (myWallets.length === 0) {
    message = `📭 Kamu belum menambahkan wallet apapun.\n\nGunakan /start untuk menambah wallet.`;
  } else {
    message = `📋 *Wallet Kamu:*\n\n`;
    myWallets.forEach((addr, i) => {
      const shortAddr = addr.slice(0, 10) + '...' + addr.slice(-6);
      message += `${i + 1}. \`${shortAddr}\`\n`;
    });
    message += `\n📊 Total: ${myWallets.length} wallet`;
  }
  
  ctx.replyWithMarkdown(message);
});

bot.command('addwallet', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 Perintah ini hanya untuk admin.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    return ctx.reply('❌ Format: /addwallet <address> [amount]\nContoh: /addwallet 0x1234...abcd 0.001');
  }
  
  const address = args[0];
  const amount = parseFloat(args[1]) || 0.001;
  
  const result = addWallet(address, ctx.from.id.toString(), amount);
  
  if (result.success) {
    auditLogger.logWalletAdd(ctx.from.id, ctx.from.first_name, address);
    ctx.reply(`✅ Wallet ditambahkan!\n\n📫 \`${address}\`\n💰 ${amount} DIAM`, { parse_mode: 'Markdown' });
  } else if (result.reason === 'duplicate') {
    ctx.reply('⚠️ Wallet sudah ada di daftar!');
  } else if (result.reason === 'invalid') {
    ctx.reply('❌ Format address tidak valid!');
  }
});

bot.command('removewallet', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 Perintah ini hanya untuk admin.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    return ctx.reply('❌ Format: /removewallet <address>');
  }
  
  const address = args[0];
  
  if (removeWallet(address)) {
    auditLogger.logWalletRemove(ctx.from.id, ctx.from.first_name, address);
    ctx.reply(`✅ Wallet dihapus!\n\n📫 \`${address}\``, { parse_mode: 'Markdown' });
  } else {
    ctx.reply('❌ Wallet tidak ditemukan.');
  }
});

bot.command('single', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 Perintah ini hanya untuk admin.');
  }
  
  if (!ACCESS_TOKEN || !USER_ID) {
    return ctx.reply('❌ ACCESS_TOKEN atau USER_ID belum dikonfigurasi.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length < 2) {
    return ctx.reply('❌ Format: /single <address> <amount>\nContoh: /single 0x1234...abcd 0.001');
  }
  
  const address = args[0];
  const amount = parseFloat(args[1]);
  
  if (!validationHelper.isValidWalletAddress(address)) {
    return ctx.reply('❌ Address tidak valid!');
  }
  
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Amount tidak valid!');
  }
  
  const msg = await ctx.reply(`⚡ Memproses transfer ${amount} DIAM ke ${address.slice(0, 10)}...`);
  
  try {
    const { success, result, attempts } = await transferWithRetry(address, amount);
    
    if (success) {
      const hash = result.data?.transferData?.hash || 'N/A';
      let message = `✅ *TRANSFER BERHASIL!*\n\n`;
      message += `📫 To: \`${address}\`\n`;
      message += `💰 Amount: ${amount} DIAM\n`;
      message += `🔗 Hash: \`${hash}\`\n`;
      if (attempts > 1) message += `🔄 Attempts: ${attempts}`;
      
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, message, { parse_mode: 'Markdown' });
      
      try {
        const mysteryResult = await claimMysteryBox();
        if (mysteryResult.success && mysteryResult.data?.mysteryReward) {
          ctx.reply(`🎁 Mystery Box: +${mysteryResult.data.mysteryReward} ${mysteryResult.data.rewardType || 'XP'}`);
        }
      } catch (e) {}
    } else {
      const errorMsg = result?.message || 'Unknown error';
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `❌ Transfer gagal setelah ${attempts}x percobaan.\n\nError: ${errorMsg}`
      );
    }
  } catch (error) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `❌ Error: ${error.message}`
    );
  }
});

bot.command('addadmin', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 Perintah ini hanya untuk admin.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    return ctx.reply('❌ Format: /addadmin <user_id>');
  }
  
  const newAdminId = args[0];
  const result = addAdmin(newAdminId);
  
  if (result.success) {
    auditLogger.logAdminAdd(ctx.from.id, ctx.from.first_name, newAdminId);
    ctx.reply(`✅ Admin ditambahkan!\n\n👤 ID: \`${newAdminId}\``, { parse_mode: 'Markdown' });
  } else if (result.reason === 'primary') {
    ctx.reply('⚠️ User ini adalah Super Admin.');
  } else {
    ctx.reply('⚠️ User sudah menjadi admin.');
  }
});

bot.command('removeadmin', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 Perintah ini hanya untuk admin.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    return ctx.reply('❌ Format: /removeadmin <user_id>');
  }
  
  const adminId = args[0];
  
  if (adminId === ctx.from.id.toString()) {
    return ctx.reply('❌ Tidak bisa menghapus diri sendiri!');
  }
  
  const result = removeAdmin(adminId);
  
  if (result.success) {
    auditLogger.logAdminRemove(ctx.from.id, ctx.from.first_name, adminId);
    ctx.reply(`✅ Admin dihapus!\n\n👤 ID: \`${adminId}\``, { parse_mode: 'Markdown' });
  } else if (result.reason === 'primary') {
    ctx.reply('❌ Tidak bisa menghapus Super Admin!');
  } else {
    ctx.reply('❌ User bukan admin.');
  }
});

bot.command('admins', (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 Perintah ini hanya untuk admin.');
  }
  
  const additionalAdmins = getAdditionalAdmins();
  
  let message = `👥 *Daftar Admin*\n\n`;
  message += `👑 *Super Admin:*\n`;
  message += PRIMARY_ADMIN_ID ? `   \`${PRIMARY_ADMIN_ID}\`\n` : `   Tidak dikonfigurasi\n`;
  
  if (additionalAdmins.length > 0) {
    message += `\n📋 *Admin Tambahan:*\n`;
    additionalAdmins.forEach((id, i) => {
      message += `${i + 1}. \`${id}\`\n`;
    });
  }
  
  ctx.replyWithMarkdown(message);
});

// ============================================================
// ERROR HANDLING
// ============================================================

bot.catch(async (err, ctx) => {
  await errorHandler.handleError(err, ctx, 'bot.catch');
});

// ============================================================
// BOT LAUNCH
// ============================================================

async function initializeBot() {
  logger.info('Initializing bot components...');
  
  // Initialize managers
  await userManager.init();
  await auditLogger.init();
  await analyticsHelper.init();
  
  logger.success('All components initialized');
}

initializeBot().then(() => {
  bot.launch().then(() => {
    console.clear();
    console.log('╔════════════════════════════════════════╗');
    console.log('║   🤖 DIAMANTE AUTO TRANSFER BOT v2.0   ║');
    console.log('╠════════════════════════════════════════╣');
    console.log('║  Status: ✅ RUNNING                    ║');
    console.log('║  Mode: Modular Architecture            ║');
    console.log('║  Features: LiveChat, Broadcast, Audit  ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    logger.info('Bot started successfully');
    console.log('─────────────────────────────────────────');
  });
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  
  // Save any pending data
  await userManager.saveUsers();
  await auditLogger.save();
  await analyticsHelper.save();
  
  bot.stop(signal);
  logger.success('Bot stopped gracefully');
  process.exit(0);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

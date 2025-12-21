import { ethers } from 'ethers';
import fs from 'fs';
import cloudscraper from 'cloudscraper';
import logger from '../utils/logger.js';

const TOKENS_FILE = 'tokens.json';
const API_BASE = 'https://campapi.diamante.io/api/v1';

// Cloudscraper options for bypassing Cloudflare
const cloudscraperDefaults = {
  resolveWithFullResponse: true,
  cloudflareMaxTimeout: 30000,
  followAllRedirects: true,
  challengesToSolve: 3
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getDefaultHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Origin': 'https://campaign.diamante.io',
    'Referer': 'https://campaign.diamante.io/',
    'access-token': 'key',
    'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'priority': 'u=1, i'
  };
}

function generateDeviceId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'DEV';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    }
  } catch (e) {
    logger.warn(`Error loading tokens: ${e.message}`);
  }
  return {};
}

function saveTokens(accessToken, userId) {
  try {
    const data = {
      ACCESS_TOKEN: accessToken,
      USER_ID: userId,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
    logger.info('Tokens saved successfully');
    return true;
  } catch (e) {
    logger.error(`Error saving tokens: ${e.message}`);
    return false;
  }
}

function isTokenExpired(token) {
  if (!token) return true;
  
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const expTime = payload.exp * 1000;
    const now = Date.now();
    const bufferTime = 5 * 60 * 1000;
    
    return now >= (expTime - bufferTime);
  } catch (e) {
    logger.warn(`Error checking token expiry: ${e.message}`);
    return true;
  }
}

function generateCompleteDeviceFingerprint() {
  return {
    deviceId: generateDeviceId(),
    deviceSource: 'web_app',
    deviceType: 'Windows',
    browser: 'Chrome',
    ipAddress: '0.0.0.0',
    latitude: 12.9715987,
    longitude: 77.5945627,
    countryCode: 'Unknown',
    country: 'Unknown',
    continent: 'Unknown',
    continentCode: 'Unknown',
    region: 'Unknown',
    regionCode: 'Unknown',
    city: 'Unknown'
  };
}

async function extractTokenFromResponse(response, data) {
  let accessToken = null;
  
  // Try multiple methods to get set-cookie header
  // Method 1: node-fetch .raw() 
  if (response.headers.raw) {
    const rawHeaders = response.headers.raw();
    if (rawHeaders['set-cookie']) {
      const cookies = Array.isArray(rawHeaders['set-cookie']) 
        ? rawHeaders['set-cookie'] 
        : [rawHeaders['set-cookie']];
      
      for (const cookie of cookies) {
        const tokenMatch = cookie.match(/access_token=([^;]+)/);
        if (tokenMatch) {
          accessToken = tokenMatch[1];
          logger.debug('✅ Token parsed from raw headers');
          break;
        }
      }
    }
  }
  
  // Method 2: Direct .get() 
  if (!accessToken) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const tokenMatch = setCookie.match(/access_token=([^;]+)/);
      if (tokenMatch) {
        accessToken = tokenMatch[1];
        logger.debug('✅ Token parsed from .get()');
      }
    }
  }
  
  // Method 3: Iterate all headers
  if (!accessToken && response.headers) {
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() === 'set-cookie') {
        const tokenMatch = value.match(/access_token=([^;]+)/);
        if (tokenMatch) {
          accessToken = tokenMatch[1];
          logger.debug('✅ Token parsed from headers.entries()');
          break;
        }
      }
    }
  }
  
  if (accessToken) {
    return {
      accessToken: accessToken,
      userId: data.data?.userId || data.userId
    };
  }
  
  // Check response body
  if (data.data?.accessToken) {
    logger.info('✅ Token found in response body');
    return {
      accessToken: data.data.accessToken,
      userId: data.data.userId
    };
  }
  
  return null;
}

async function connectWallet(walletAddress, existingAccessToken = null) {
  const body = generateCompleteDeviceFingerprint();
  body.address = walletAddress;

  const headers = getDefaultHeaders();
  
  // Add existing access token as cookie if available
  if (existingAccessToken) {
    headers['Cookie'] = `access_token=${existingAccessToken}`;
    console.log('[DEBUG] Using existing access token cookie');
  }

  console.log(`[DEBUG] 📤 Connect-wallet request via cloudscraper to ${API_BASE}/user/connect-wallet`);

  try {
    const response = await cloudscraper({
      ...cloudscraperDefaults,
      method: 'POST',
      uri: `${API_BASE}/user/connect-wallet`,
      headers: headers,
      body: body,
      json: true
    });

    // Log response details
    console.log(`[DEBUG] 📥 Response status: ${response.statusCode}`);
    console.log(`[DEBUG] 📥 Response headers:`, JSON.stringify(response.headers).substring(0, 300));
    console.log(`[DEBUG] 📥 Response body: ${JSON.stringify(response.body)}`);
    
    const data = response.body;
    
    if (response.statusCode === 200 && data?.success) {
      // Extract token from set-cookie header
      const setCookie = response.headers['set-cookie'];
      let accessToken = null;
      
      if (setCookie) {
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const cookie of cookies) {
          const tokenMatch = cookie.match(/access_token=([^;]+)/);
          if (tokenMatch) {
            accessToken = tokenMatch[1];
            console.log('[DEBUG] ✅ Token extracted from set-cookie header');
            break;
          }
        }
      }
      
      if (accessToken) {
        logger.info(`✅ Connect-wallet succeeded via cloudscraper, token extracted`);
        return {
          accessToken: accessToken,
          userId: data.data?.userId
        };
      } else {
        console.log('[DEBUG] ⚠️ Response OK but no token found in set-cookie');
      }
    }
    
    console.log(`[DEBUG] Connect wallet status: ${response.statusCode}, success: ${data?.success}`);
    return null;
  } catch (error) {
    console.log(`[DEBUG] Cloudscraper error: ${error.message}`);
    
    // Fallback to regular fetch if cloudscraper fails
    console.log('[DEBUG] Falling back to regular fetch...');
    try {
      const response = await fetch(`${API_BASE}/user/connect-wallet`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });
      
      console.log(`[DEBUG] 📥 Fetch response status: ${response.status}`);
      
      if (response.ok) {
        const data = await response.json();
        const tokenData = await extractTokenFromResponse(response, data);
        if (tokenData?.accessToken) {
          logger.info(`✅ Connect-wallet succeeded via fetch fallback`);
          return tokenData;
        }
      }
    } catch (fetchError) {
      console.log(`[DEBUG] Fetch fallback also failed: ${fetchError.message}`);
    }
    
    return null;
  }
}

async function signUpWithWallet(walletAddress) {
  logger.debug(`Attempting wallet sign-up: ${walletAddress.slice(0, 10)}...`);
  
  const body = generateCompleteDeviceFingerprint();
  body.address = walletAddress;
  body.walletAddress = walletAddress;

  const headers = getDefaultHeaders();

  try {
    const response = await fetch(`${API_BASE}/auth/sign-up`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });

    if (response.ok) {
      const data = await response.json();
      const tokenData = await extractTokenFromResponse(response, data);
      if (tokenData?.accessToken) {
        logger.info(`✅ Sign-up succeeded, token generated`);
        return tokenData;
      }
    } else {
      logger.debug(`Sign-up returned ${response.status}`);
    }
  } catch (error) {
    logger.debug(`Sign-up error: ${error.message}`);
  }
  
  return null;
}

async function signMessageAndAuthenticate(wallet) {
  try {
    // Create a message to sign (timestamp-based nonce)
    const nonce = Math.floor(Date.now() / 1000);
    const message = `Diamante Authentication\nWallet: ${wallet.address}\nNonce: ${nonce}`;
    
    logger.debug(`Signing message with wallet: ${wallet.address.slice(0, 10)}...`);
    
    // Sign the message
    const signature = await wallet.signMessage(message);
    
    logger.debug(`Message signed successfully`);
    
    // Try to authenticate with signed message
    const response = await fetch(`${API_BASE}/user/sign-in`, {
      method: 'POST',
      headers: getDefaultHeaders(),
      body: JSON.stringify({
        address: wallet.address,
        message: message,
        signature: signature,
        deviceId: generateDeviceId(),
        deviceSource: 'web_app',
        deviceType: 'Windows',
        browser: 'Chrome'
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.data?.accessToken) {
        logger.info('✅ Message signature authentication successful');
        return {
          accessToken: data.data.accessToken,
          userId: data.data.userId,
          source: 'signed_message'
        };
      }
    }
    
    // Fallback: try direct connect-wallet with device info
    logger.debug('Sign-in endpoint not available, trying connect-wallet fallback...');
    return null;
  } catch (error) {
    logger.warn(`Message signing failed: ${error.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, name, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`[${name}] Attempt ${attempt}/${maxRetries}`);
      const result = await fn();
      if (result?.accessToken) {
        logger.info(`✅ [${name}] Success on attempt ${attempt}`);
        return result;
      }
    } catch (error) {
      logger.debug(`[${name}] Attempt ${attempt} failed: ${error.message}`);
    }
    
    if (attempt < maxRetries) {
      const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      logger.info(`⏱️ [${name}] Retry in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
  
  return null;
}

async function authenticateWithWallet(privateKey) {
  try {
    const wallet = new ethers.Wallet(privateKey);
    const walletAddress = wallet.address;
    
    logger.info(`🔐 Authenticating with wallet: ${walletAddress.slice(0, 10)}...`);
    
    // Method 1: Try message signing (Web3 standard) with retry
    logger.debug('Method 1: Trying message signing...');
    const signedAuth = await retryWithBackoff(
      () => signMessageAndAuthenticate(wallet),
      'Message Signing',
      3
    );
    if (signedAuth?.accessToken) {
      saveTokens(signedAuth.accessToken, signedAuth.userId);
      logger.info('✅ Auth successful via message signing');
      return {
        success: true,
        accessToken: signedAuth.accessToken,
        userId: signedAuth.userId,
        method: 'signed_message'
      };
    }
    
    // Method 2: Try sign-up without existing token with retry
    logger.debug('Method 2: Trying sign-up endpoint...');
    const signUpResult = await retryWithBackoff(
      () => signUpWithWallet(walletAddress),
      'Sign-up',
      3
    );
    if (signUpResult?.accessToken) {
      saveTokens(signUpResult.accessToken, signUpResult.userId);
      logger.info('✅ Auth successful via sign-up');
      return {
        success: true,
        accessToken: signUpResult.accessToken,
        userId: signUpResult.userId,
        method: 'sign_up'
      };
    }
    
    // Method 3: Try connect-wallet without token (might work) with retry
    logger.debug('Method 3: Trying connect-wallet without existing token...');
    const connectNoTokenResult = await retryWithBackoff(
      () => connectWallet(walletAddress, null),
      'Connect-Wallet (No Token)',
      3
    );
    if (connectNoTokenResult?.accessToken) {
      saveTokens(connectNoTokenResult.accessToken, connectNoTokenResult.userId);
      logger.info('✅ Auth successful via connect-wallet (no cookie)');
      return {
        success: true,
        accessToken: connectNoTokenResult.accessToken,
        userId: connectNoTokenResult.userId,
        method: 'connect_wallet_no_cookie'
      };
    }
    
    // Method 4: Try connect-wallet with existing token (fallback) with retry
    logger.debug('Method 4: Trying connect-wallet with existing token...');
    const tokens = loadTokens();
    const existingToken = tokens.ACCESS_TOKEN || process.env.ACCESS_TOKEN;
    
    if (existingToken && !isTokenExpired(existingToken)) {
      const connectWithTokenResult = await retryWithBackoff(
        () => connectWallet(walletAddress, existingToken),
        'Connect-Wallet (With Token)',
        3
      );
      if (connectWithTokenResult?.accessToken) {
        saveTokens(connectWithTokenResult.accessToken, connectWithTokenResult.userId);
        logger.info('✅ Auth successful via connect-wallet (with existing token)');
        return {
          success: true,
          accessToken: connectWithTokenResult.accessToken,
          userId: connectWithTokenResult.userId,
          method: 'connect_wallet'
        };
      }
    }
    
    logger.warn('❌ All authentication methods failed after retries');
    return { success: false, message: 'Unable to authenticate with wallet' };
  } catch (error) {
    logger.error(`❌ Wallet authentication failed: ${error.message}`);
    return { success: false, message: error.message };
  }
}

async function getValidTokens() {
  const tokens = loadTokens();
  const envAccessToken = process.env.ACCESS_TOKEN;
  const envUserId = process.env.USER_ID;
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  
  // Check if stored token is expired
  const storedTokenExpired = tokens.ACCESS_TOKEN ? isTokenExpired(tokens.ACCESS_TOKEN) : true;
  const envTokenExpired = envAccessToken ? isTokenExpired(envAccessToken) : true;
  
  // Get first valid (non-expired) token
  let validAccessToken = null;
  if (!storedTokenExpired && tokens.ACCESS_TOKEN) {
    validAccessToken = tokens.ACCESS_TOKEN;
    logger.info('Using stored access token (not expired)');
  } else if (!envTokenExpired && envAccessToken) {
    validAccessToken = envAccessToken;
    logger.info('Using environment access token (not expired)');
  }
  
  const hasValidToken = !!validAccessToken;
  const hasUserId = tokens.USER_ID || envUserId;
  
  // ALWAYS attempt wallet auth if private key is available
  // (connect-wallet can work even without existing token)
  if (privateKey) {
    logger.info('🔐 Private key found, attempting wallet authentication...');
    const result = await authenticateWithWallet(privateKey);
    if (result.success) {
      logger.info(`✅ Wallet authentication successful via ${result.method}`);
      return {
        accessToken: result.accessToken,
        userId: result.userId,
        source: 'wallet'
      };
    }
    logger.warn('Wallet authentication failed, falling back to stored/environment tokens');
  } else {
    logger.info('No private key configured, using environment/stored tokens');
  }
  
  // Fallback: use stored or environment tokens
  return {
    accessToken: validAccessToken || '',
    userId: hasUserId || '',
    source: 'stored'
  };
}

export default {
  authenticateWithWallet,
  getValidTokens,
  isTokenExpired,
  saveTokens,
  loadTokens
};

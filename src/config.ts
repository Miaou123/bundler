// src/config.ts - Modified to support two wallets

import { Keypair } from '@solana/web3.js';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { logger } from './utils/logger';

export interface BundlerConfig {
  // Network configuration
  rpcUrl: string;
  rpcWebsocketUrl?: string;
  network: string;
  
  // Wallet configuration - NOW WITH TWO WALLETS
  creatorWallet: Keypair;      // Wallet for token creation and initial buy
  distributorWallet: Keypair;  // Wallet for funding bundled buy wallets
  
  // BACKWARD COMPATIBILITY: Keep mainWallet as an alias to creatorWallet
  mainWallet: Keypair;
  
  // Bundler settings
  walletCount: number;
  swapAmountSol: number;
  randomizeBuyAmounts: boolean;
  walletDelayMs: number;
  
  // Fee configuration
  priorityFee: {
    unitLimit: number;
    unitPrice: number;
  };
  
  // Jito configuration
  jitoTipLamports: number;
  jitoMaxRetries: number;
  jitoTimeoutSeconds: number;
  forceJitoOnly: boolean;
  
  // Safety settings
  slippageBasisPoints: number;
  maxSolPerWallet: number;
  minMainWalletBalance: number;
  maxTotalSolSpend: number;
  maxRetryAttempts: number;
  retryCooldownSeconds: number;
  
  // Operational settings
  debugMode: boolean;
  logLevel: string;
  saveLogsToFile: boolean;
  autoCleanupWallets: boolean;
  requireConfirmation: boolean;
  monitorBalances: boolean;
  balanceCheckInterval: number;
}

export function validateEnvironment(): void {
  const required = [
    'RPC_URL',
    'CREATOR_WALLET_PRIVATE_KEY',     // New env var for creator
    'DISTRIBUTOR_WALLET_PRIVATE_KEY'  // New env var for distributor
  ];
  
  const missing = required.filter(env => !process.env[env]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  // Validate RPC URL format
  if (!process.env.RPC_URL?.startsWith('http')) {
    throw new Error('RPC_URL must be a valid HTTP/HTTPS URL');
  }
  
  // Validate wallet count
  const walletCount = parseInt(process.env.WALLET_COUNT || '10');
  if (walletCount < 1 || walletCount > 20) {
    throw new Error('WALLET_COUNT must be between 1 and 20');
  }
  
  logger.info('✅ Environment validation passed');
}

function parsePrivateKey(privateKeyString: string, walletType: string): Keypair {
  try {
    // Support both base58 and array formats
    let secretKey: Uint8Array;
    if (privateKeyString.startsWith('[')) {
      // Array format: [1,2,3,...]
      const keyArray = JSON.parse(privateKeyString);
      secretKey = new Uint8Array(keyArray);
    } else {
      // Base58 format
      secretKey = bs58.decode(privateKeyString);
    }
    
    // Validate key length
    if (secretKey.length !== 64) {
      throw new Error(`Invalid private key length: ${secretKey.length} (expected 64)`);
    }
    
    const keypair = Keypair.fromSecretKey(secretKey);
    logger.info(`✅ ${walletType} wallet loaded: ${keypair.publicKey.toBase58()}`);
    return keypair;
    
  } catch (error) {
    throw new Error(`Invalid ${walletType} private key format: ${error}`);
  }
}

export function loadConfig(): BundlerConfig {
  // Load and validate both private keys
  const creatorWallet = parsePrivateKey(
    process.env.CREATOR_WALLET_PRIVATE_KEY!, 
    'Creator'
  );
  
  const distributorWallet = parsePrivateKey(
    process.env.DISTRIBUTOR_WALLET_PRIVATE_KEY!, 
    'Distributor'
  );

  // Verify they're different wallets
  if (creatorWallet.publicKey.equals(distributorWallet.publicKey)) {
    throw new Error('Creator and Distributor wallets must be different');
  }

  // Parse and validate numeric values
  const walletCount = Math.min(
    parseInt(process.env.WALLET_COUNT || '10'),
    20 // Hard limit for safety
  );
  
  const swapAmountSol = parseFloat(process.env.SWAP_AMOUNT_SOL || '0.001');
  const maxSolPerWallet = parseFloat(process.env.MAX_SOL_PER_WALLET || '0.01');
  const minMainWalletBalance = parseFloat(process.env.MIN_MAIN_WALLET_BALANCE || '0.1');
  const maxTotalSolSpend = parseFloat(process.env.MAX_TOTAL_SOL_SPEND || '0.1');
  
  // Safety checks
  const totalSpendEstimate = walletCount * swapAmountSol;
  if (totalSpendEstimate > maxTotalSolSpend) {
    throw new Error(
      `Total estimated spend (${totalSpendEstimate} SOL) exceeds MAX_TOTAL_SOL_SPEND (${maxTotalSolSpend} SOL)`
    );
  }
  
  // Parse fee settings
  const priorityFeeUnitLimit = parseInt(process.env.PRIORITY_FEE_UNIT_LIMIT || '5000000');
  const priorityFeeUnitPrice = parseInt(process.env.PRIORITY_FEE_UNIT_PRICE || '200000');
  
  if (priorityFeeUnitLimit < 1000000 || priorityFeeUnitLimit > 10000000) {
    logger.warn('⚠️  PRIORITY_FEE_UNIT_LIMIT outside recommended range (1M-10M)');
  }
  
  if (priorityFeeUnitPrice < 1000 || priorityFeeUnitPrice > 1000000) {
    logger.warn('⚠️  PRIORITY_FEE_UNIT_PRICE outside recommended range (1K-1M micro-lamports)');
  }
  
  // Parse Jito settings
  const jitoTipLamports = parseInt(process.env.JITO_TIP_LAMPORTS || '1000000');
  const jitoMaxRetries = parseInt(process.env.JITO_MAX_RETRIES || '3');
  const jitoTimeoutSeconds = parseInt(process.env.JITO_TIMEOUT_SECONDS || '30');
  
  // Parse slippage
  const slippageBasisPoints = parseInt(process.env.SLIPPAGE_BASIS_POINTS || '500');
  if (slippageBasisPoints < 100 || slippageBasisPoints > 2000) {
    logger.warn('⚠️  SLIPPAGE_BASIS_POINTS outside recommended range (100-2000 = 1%-20%)');
  }
  
  // Parse operational settings
  const debugMode = process.env.DEBUG_MODE === 'true';
  const logLevel = process.env.LOG_LEVEL || 'INFO';
  const saveLogsToFile = process.env.SAVE_LOGS_TO_FILE !== 'false';
  const autoCleanupWallets = process.env.AUTO_CLEANUP_WALLETS === 'true';
  const requireConfirmation = process.env.REQUIRE_CONFIRMATION !== 'false';
  const randomizeBuyAmounts = process.env.RANDOMIZE_BUY_AMOUNTS === 'true';
  const walletDelayMs = parseInt(process.env.WALLET_DELAY_MS || '100');
  const forceJitoOnly = process.env.FORCE_JITO_ONLY === 'true';
  
  // Parse monitoring settings
  const monitorBalances = process.env.MONITOR_BALANCES !== 'false';
  const balanceCheckInterval = parseInt(process.env.BALANCE_CHECK_INTERVAL || '10');
  
  // Parse retry settings
  const maxRetryAttempts = parseInt(process.env.MAX_RETRY_ATTEMPTS || '3');
  const retryCooldownSeconds = parseInt(process.env.RETRY_COOLDOWN_SECONDS || '5');
  
  const config: BundlerConfig = {
    // Network
    rpcUrl: process.env.RPC_URL!,
    rpcWebsocketUrl: process.env.RPC_WEBSOCKET_URL,
    network: process.env.SOLANA_NETWORK || 'mainnet-beta',
    
    // Wallets - NOW DUAL WALLET SETUP
    creatorWallet,
    distributorWallet,
    // BACKWARD COMPATIBILITY: mainWallet points to creatorWallet
    mainWallet: creatorWallet,
    
    // Bundler settings
    walletCount,
    swapAmountSol,
    randomizeBuyAmounts,
    walletDelayMs,
    
    // Fees
    priorityFee: {
      unitLimit: priorityFeeUnitLimit,
      unitPrice: priorityFeeUnitPrice,
    },
    
    // Jito
    jitoTipLamports,
    jitoMaxRetries,
    jitoTimeoutSeconds,
    forceJitoOnly,
    
    // Safety
    slippageBasisPoints,
    maxSolPerWallet,
    minMainWalletBalance,
    maxTotalSolSpend,
    maxRetryAttempts,
    retryCooldownSeconds,
    
    // Operational
    debugMode,
    logLevel,
    saveLogsToFile,
    autoCleanupWallets,
    requireConfirmation,
    monitorBalances,
    balanceCheckInterval,
  };
  
  // Log configuration summary
  logger.info('📊 Configuration loaded:');
  logger.info(`   🌐 Network: ${config.network}`);
  logger.info(`   🎨 Creator wallet: ${config.creatorWallet.publicKey.toBase58()}`);
  logger.info(`   💰 Distributor wallet: ${config.distributorWallet.publicKey.toBase58()}`);
  logger.info(`   💰 Bundled wallets: ${config.walletCount}`);
  logger.info(`   💰 SOL per wallet: ${config.swapAmountSol}`);
  logger.info(`   💰 Total estimated: ${totalSpendEstimate.toFixed(6)} SOL`);
  logger.info(`   ⚡ Priority fee: ${config.priorityFee.unitPrice} micro-lamports`);
  logger.info(`   🚀 Jito tip: ${config.jitoTipLamports} lamports`);
  logger.info(`   📊 Slippage: ${config.slippageBasisPoints / 100}%`);
  
  return config;
}

// Rest of the existing functions remain the same
export function getNetworkInfo(rpcUrl: string): { isDevnet: boolean; isMainnet: boolean; network: string } {
  const url = rpcUrl.toLowerCase();
  const isDevnet = url.includes('devnet');
  const isMainnet = url.includes('mainnet') || (!url.includes('devnet') && !url.includes('testnet'));
  
  let network = 'unknown';
  if (isDevnet) network = 'devnet';
  else if (isMainnet) network = 'mainnet-beta';
  else if (url.includes('testnet')) network = 'testnet';
  
  return { isDevnet, isMainnet, network };
}

export function validateTokenMetadata(metadata: any): void {
  const required = ['name', 'symbol', 'description'];
  const missing = required.filter(field => !metadata[field]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required token metadata: ${missing.join(', ')}`);
  }
  
  // Validate lengths
  if (metadata.name.length > 32) {
    throw new Error('Token name cannot exceed 32 characters');
  }
  
  if (metadata.symbol.length > 10) {
    throw new Error('Token symbol cannot exceed 10 characters');
  }
  
  if (metadata.description.length > 1000) {
    throw new Error('Token description cannot exceed 1000 characters');
  }
  
  // Validate URLs if provided
  const urlFields = ['twitter', 'telegram', 'website'];
  for (const field of urlFields) {
    if (metadata[field] && !metadata[field].startsWith('http')) {
      throw new Error(`${field} must be a valid URL starting with http/https`);
    }
  }
  
  logger.info('✅ Token metadata validation passed');
}
// src/main.ts - Updated for dual wallet support

import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
// Use the corrected bundler
import { SecurePumpBundler } from './bundler';
import { loadConfig, validateEnvironment } from './config';
import { logger } from './utils/logger';

config();

interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  imagePath: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

// Simple confirmation using readline (built-in Node.js)
async function confirmProceed(config: any): Promise<boolean> {
  const totalCost = (config.walletCount * config.swapAmountSol) + 0.01;
  
  console.log('\n🔍 DUAL WALLET Configuration Summary:');
  console.log(`   🎨 Creator wallet: ${config.creatorWallet.publicKey.toBase58()}`);
  console.log(`   💰 Distributor wallet: ${config.distributorWallet.publicKey.toBase58()}`);
  console.log(`   💰 Bundled wallets: ${config.walletCount}`);
  console.log(`   💰 SOL per wallet: ${config.swapAmountSol}`);
  console.log(`   💰 Total estimated cost: ${totalCost.toFixed(6)} SOL`);
  console.log(`   🌐 Network: ${config.rpcUrl.includes('devnet') ? 'DEVNET' : 'MAINNET'}`);
  console.log(`\n📝 How it works:`);
  console.log(`   1. Creator wallet creates the token and does initial buy`);
  console.log(`   2. Distributor wallet funds all bundled buy wallets`);
  console.log(`   3. All transactions are bundled together via Jito`);
  
  if (process.env.REQUIRE_CONFIRMATION === 'false') {
    return true;
  }

  // Use readline for confirmation
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\n🚀 Do you want to proceed with DUAL WALLET token creation and bundling? (y/N): ', (answer: string) => {
      rl.close();
      const confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
      resolve(confirmed);
    });
  });
}

async function getTokenMetadata(): Promise<TokenMetadata> {
  const metadata: TokenMetadata = {
    name: process.env.TOKEN_NAME || 'Default Token',
    symbol: process.env.TOKEN_SYMBOL || 'DFT',
    description: process.env.TOKEN_DESCRIPTION || 'A token created with secure dual wallet bundler',
    imagePath: process.env.TOKEN_IMAGE_PATH || './assets/token-image.png',
    twitter: process.env.TOKEN_TWITTER,
    telegram: process.env.TOKEN_TELEGRAM,
    website: process.env.TOKEN_WEBSITE,
  };

  // Check if image file exists
  if (!fs.existsSync(metadata.imagePath)) {
    logger.warn(`⚠️  Token image not found at ${metadata.imagePath}`);
    
    // Create a simple placeholder image
    const assetsDir = path.dirname(metadata.imagePath);
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }
    
    // Create a minimal PNG file (1x1 pixel transparent PNG)
    const minimalPNG = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
      0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
    
    fs.writeFileSync(metadata.imagePath, minimalPNG);
    logger.info(`📷 Created placeholder image at ${metadata.imagePath}`);
  }

  return metadata;
}

async function checkDryRun(): Promise<boolean> {
  return process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
}

async function main() {
  try {
    logger.info('🚀 Starting Secure Pump.fun DUAL WALLET Bundler...');
    
    // Check for dry run mode
    const isDryRun = await checkDryRun();
    if (isDryRun) {
      logger.info('🧪 DRY RUN MODE - No actual transactions will be sent');
    }

    // Validate environment
    logger.info('🔍 Validating environment...');
    validateEnvironment();
    
    // Load configuration
    logger.info('⚙️  Loading DUAL WALLET configuration...');
    const bundlerConfig = loadConfig();
    
    // Get token metadata
    logger.info('📝 Loading token metadata...');
    const tokenMetadata = await getTokenMetadata();
    
    // Display configuration
    logger.info('\n📋 Token Configuration:');
    logger.info(`   Name: ${tokenMetadata.name}`);
    logger.info(`   Symbol: ${tokenMetadata.symbol}`);
    logger.info(`   Description: ${tokenMetadata.description}`);
    if (tokenMetadata.twitter) logger.info(`   Twitter: ${tokenMetadata.twitter}`);
    if (tokenMetadata.telegram) logger.info(`   Telegram: ${tokenMetadata.telegram}`);
    if (tokenMetadata.website) logger.info(`   Website: ${tokenMetadata.website}`);
    
    // Confirm proceed
    if (!isDryRun) {
      const shouldProceed = await confirmProceed(bundlerConfig);
      if (!shouldProceed) {
        logger.info('❌ Operation cancelled by user');
        process.exit(0);
      }
    }
    
    // Initialize bundler
    logger.info('🔧 Initializing DUAL WALLET bundler...');
    const bundler = new SecurePumpBundler(bundlerConfig);
    
    // Display wallet info
    const walletInfo = bundler.getWalletInfo();
    logger.info('\n📊 DUAL WALLET Bundler Information:');
    logger.info(`   🎨 Creator wallet: ${walletInfo.creatorWallet}`);
    logger.info(`   💰 Distributor wallet: ${walletInfo.distributorWallet}`);
    logger.info(`   📦 Generated wallets: ${walletInfo.walletCount}`);
    
    if (isDryRun) {
      logger.info('\n🧪 DRY RUN - Testing SDK...');
      const result = await bundler.createAndBundle(tokenMetadata, true);
      
      if (result.success) {
        logger.info('✅ All validations passed - ready to run!');
      } else {
        logger.error(`❌ Validation failed: ${result.error}`);
        process.exit(1);
      }
      return;
    }
    
    // Create token and execute buys
    logger.info('\n🚀 Starting DUAL WALLET token creation and buying...');
    const result = await bundler.createAndBundle(tokenMetadata, false);
    
    if (result.success) {
      logger.info('\n🎉 SUCCESS! DUAL WALLET Token created and buys executed successfully!');
      logger.info(`📝 Token Address: ${result.mint}`);
      logger.info(`🔗 Pump.fun URL: https://pump.fun/${result.mint}`);
      logger.info(`🔗 Solscan URL: https://solscan.io/token/${result.mint}`);
      
      // Save results
      const resultsPath = path.join(process.cwd(), 'logs', 'results.json');
      const resultsData = {
        timestamp: new Date().toISOString(),
        success: true,
        tokenAddress: result.mint,
        signature: result.signature,
        walletSetup: 'dual-wallet',
        creatorWallet: walletInfo.creatorWallet,
        distributorWallet: walletInfo.distributorWallet,
        tokenMetadata,
        bundlerConfig: {
          walletCount: bundlerConfig.walletCount,
          swapAmountSol: bundlerConfig.swapAmountSol,
        },
      };
      fs.writeFileSync(resultsPath, JSON.stringify(resultsData, null, 2));
      logger.info(`💾 Results saved to: ${resultsPath}`);
      
    } else {
      logger.error('\n💥 FAILED to create and buy token');
      logger.error(`Error: ${result.error}`);
      
      process.exit(1);
    }
    
  } catch (error) {
    logger.error('\n❌ Fatal error occurred:', error);
    
    if (error instanceof Error) {
      logger.error(`Error message: ${error.message}`);
      if (error.stack) {
        logger.error(`Stack trace: ${error.stack}`);
      }
    }
    
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  logger.info('\n🛑 Process interrupted by user');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('\n🛑 Process terminated');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled promise rejection:', reason);
  process.exit(1);
});

// Run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Application failed to start:', error);
    process.exit(1);
  });
}
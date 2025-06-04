// src/main.ts - COMPLETE SECURE VERSION

import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
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

// SECURE: Enhanced confirmation with security details
async function confirmProceed(config: any): Promise<boolean> {
  console.log('\n🛡️  SECURE JITO BUNDLER Configuration:');
  console.log(`   🎨 Creator wallet: ${config.creatorWallet.publicKey.toBase58()}`);
  console.log(`   💰 Distributor wallet: ${config.distributorWallet.publicKey.toBase58()}`);
  console.log(`   📦 Bundled wallets: ${config.walletCount}`);
  console.log(`   💰 SOL per wallet: ${config.swapAmountSol}`);
  console.log(`   🌐 Network: ${config.rpcUrl.includes('devnet') ? 'DEVNET' : 'MAINNET'}`);
  
  const totalCost = (config.walletCount * config.swapAmountSol) + 0.1;
  console.log(`   💰 Estimated total cost: ${totalCost.toFixed(6)} SOL`);
  
  console.log('\n🛡️  SECURITY FEATURES:');
  console.log(`   ✅ Embedded tip (no uncle bandit)`);
  console.log(`   ✅ Pre/post account checks (no unbundling)`);
  console.log(`   ✅ JITO-ONLY policy (no fallback)`);
  console.log(`   ✅ Dynamic tip calculation`);
  console.log(`   ✅ Single atomic transaction`);
  
  if (process.env.REQUIRE_CONFIRMATION === 'false') {
    return true;
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\n🛡️  Proceed with SECURE bundled token creation? (y/N): ', (answer: string) => {
      rl.close();
      const confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
      resolve(confirmed);
    });
  });
}

async function getTokenMetadata(): Promise<TokenMetadata> {
  const metadata: TokenMetadata = {
    name: process.env.TOKEN_NAME || 'SecureToken',
    symbol: process.env.TOKEN_SYMBOL || 'SECURE',
    description: process.env.TOKEN_DESCRIPTION || 'A token created with secure anti-MEV Jito bundling',
    imagePath: process.env.TOKEN_IMAGE_PATH || './assets/token-image.png',
    twitter: process.env.TOKEN_TWITTER,
    telegram: process.env.TOKEN_TELEGRAM,
    website: process.env.TOKEN_WEBSITE,
  };

  // Create placeholder image if it doesn't exist
  if (!fs.existsSync(metadata.imagePath)) {
    logger.warn(`⚠️  Token image not found at ${metadata.imagePath}`);
    
    const assetsDir = path.dirname(metadata.imagePath);
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }
    
    // Create minimal PNG (1x1 transparent pixel)
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

async function main() {
  try {
    logger.info('🛡️  Starting SECURE Pump.fun Bundler with Anti-MEV Protections...');
    
    // Check for dry run mode
    const isDryRun = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
    if (isDryRun) {
      logger.info('🧪 DRY RUN MODE - No actual transactions will be sent');
    }

    // Validate environment
    logger.info('🔍 Validating environment...');
    validateEnvironment();
    
    // Load configuration
    logger.info('⚙️  Loading configuration...');
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
    
    // Initialize secure bundler
    logger.info('🛡️  Initializing SECURE bundler...');
    const bundler = new SecurePumpBundler(bundlerConfig);
    
    // Display wallet info
    const walletInfo = bundler.getWalletInfo();
    logger.info('\n📊 SECURE Bundler Information:');
    logger.info(`   🎨 Creator wallet: ${walletInfo.creatorWallet}`);
    logger.info(`   💰 Distributor wallet: ${walletInfo.distributorWallet}`);
    logger.info(`   📦 Bundled wallets: ${walletInfo.walletCount}`);
    logger.info(`   🎯 Creator buy amount: ${walletInfo.creatorBuyAmount} SOL`);
    logger.info(`   🛡️  Strategy: ${walletInfo.strategy}`);
    
    if (isDryRun) {
      logger.info('\n🧪 DRY RUN - Testing SECURE configuration...');
      const result = await bundler.createAndBundle(tokenMetadata, true);
      
      if (result.success) {
        logger.info('✅ All SECURE validations passed - ready to run!');
        logger.info('🛡️  Security features verified:');
        logger.info('   ✅ Embedded tip protection');
        logger.info('   ✅ Pre/post checks enabled');
        logger.info('   ✅ Jito-only policy active');
        logger.info('   ✅ Dynamic tipping ready');
      } else {
        logger.error(`❌ SECURE validation failed: ${result.error}`);
        process.exit(1);
      }
      return;
    }
    
    // Execute secure bundled token creation
    logger.info('\n🛡️  Starting SECURE bundled token creation...');
    logger.info('🛡️  All anti-MEV protections active...');
    
    const result = await bundler.createAndBundle(tokenMetadata);
    
    if (result.success) {
      logger.info('\n🎉 SUCCESS! SECURE bundled token creation completed!');
      logger.info(`📝 Token Address: ${result.mint}`);
      logger.info(`🔗 Pump.fun URL: https://pump.fun/${result.mint}`);
      logger.info(`🔗 Solscan URL: https://solscan.io/token/${result.mint}`);
      logger.info(`📋 Transaction: ${result.signature}`);
      
      if (result.bundledWallets) {
        logger.info(`\n📊 Bundle Results:`);
        logger.info(`   💰 Bundled wallets: ${result.bundledWallets.length}`);
        logger.info(`   🛡️  Security: All protections verified`);
        logger.info(`   💎 Strategy: Secure anti-MEV bundling`);
        
        // Display wallet summary
        const totalRetainedSOL = result.bundledWallets.reduce((sum, w) => sum + w.remainingSOL, 0);
        logger.info(`   💰 Total SOL retained: ${totalRetainedSOL.toFixed(6)} SOL`);
      }
      
      // Save final results summary
      const summaryPath = path.join(process.cwd(), 'logs', 'success_summary.json');
      const summaryData = {
        timestamp: new Date().toISOString(),
        success: true,
        tokenAddress: result.mint,
        signature: result.signature,
        strategy: 'secure-anti-mev-bundling',
        securityFeatures: {
          embeddedTip: true,
          prePostChecks: true,
          jitoOnly: true,
          dynamicTipping: true,
          noFallback: true,
        },
        walletCount: result.bundledWallets?.length || 0,
        creatorWallet: walletInfo.creatorWallet,
        distributorWallet: walletInfo.distributorWallet,
        tokenMetadata,
        bundlerConfig: {
          walletCount: bundlerConfig.walletCount,
          swapAmountSol: bundlerConfig.swapAmountSol,
          slippageBasisPoints: bundlerConfig.slippageBasisPoints,
        },
      };
      
      fs.writeFileSync(summaryPath, JSON.stringify(summaryData, null, 2));
      logger.info(`💾 Success summary saved to: ${summaryPath}`);
      
      logger.info('\n🛡️  SECURE BUNDLING OPERATION COMPLETED SUCCESSFULLY! 🛡️');
      
    } else {
      logger.error('\n💥 FAILED to complete SECURE bundled token creation');
      logger.error(`Error: ${result.error}`);
      
      // Save failure log
      const failurePath = path.join(process.cwd(), 'logs', 'failure_log.json');
      const failureData = {
        timestamp: new Date().toISOString(),
        success: false,
        error: result.error,
        strategy: 'secure-anti-mev-bundling',
        tokenMetadata,
        bundlerConfig: {
          walletCount: bundlerConfig.walletCount,
          swapAmountSol: bundlerConfig.swapAmountSol,
        },
      };
      
      fs.writeFileSync(failurePath, JSON.stringify(failureData, null, 2));
      logger.error(`💾 Failure log saved to: ${failurePath}`);
      
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
    
    // Save crash log
    const crashPath = path.join(process.cwd(), 'logs', 'crash_log.json');
    const crashData = {
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      strategy: 'secure-anti-mev-bundling',
    };
    
    try {
      const logsDir = path.dirname(crashPath);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      fs.writeFileSync(crashPath, JSON.stringify(crashData, null, 2));
      logger.error(`💾 Crash log saved to: ${crashPath}`);
    } catch (logError) {
      logger.error('Failed to save crash log:', logError);
    }
    
    process.exit(1);
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  logger.info('\n🛑 Process interrupted by user');
  logger.info('🛡️  SECURE bundler shutting down safely...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('\n🛑 Process terminated');
  logger.info('🛡️  SECURE bundler shutting down safely...');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught exception:', error);
  logger.error('🛡️  SECURE bundler crashed unexpectedly');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled promise rejection:', reason);
  logger.error('🛡️  SECURE bundler promise rejection');
  process.exit(1);
});

// Run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Application failed to start:', error);
    console.error('🛡️  SECURE bundler startup failed');
    process.exit(1);
  });
}
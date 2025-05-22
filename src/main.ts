import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
// Remove inquirer import - we'll use readline instead
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
  
  console.log('\n🔍 Configuration Summary:');
  console.log(`   💰 Wallets: ${config.walletCount}`);
  console.log(`   💰 SOL per wallet: ${config.swapAmountSol}`);
  console.log(`   💰 Total estimated cost: ${totalCost.toFixed(6)} SOL`);
  console.log(`   🌐 Network: ${config.rpcUrl.includes('devnet') ? 'DEVNET' : 'MAINNET'}`);
  
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
    rl.question('\n🚀 Do you want to proceed with token creation and bundling? (y/N): ', (answer: string) => {
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
    description: process.env.TOKEN_DESCRIPTION || 'A token created with secure bundler',
    imagePath: process.env.TOKEN_IMAGE_PATH || './assets/token-image.png',
    twitter: process.env.TOKEN_TWITTER,
    telegram: process.env.TOKEN_TELEGRAM,
    website: process.env.TOKEN_WEBSITE,
  };

  // Check if image file exists
  if (!fs.existsSync(metadata.imagePath)) {
    logger.warn(`⚠️  Token image not found at ${metadata.imagePath}`);
    logger.warn('   Please add your token image to assets/token-image.png');
    
    // Create a placeholder if needed
    const placeholderPath = path.join(process.cwd(), 'assets', 'placeholder.txt');
    if (!fs.existsSync(placeholderPath)) {
      fs.writeFileSync(placeholderPath, 'Placeholder for token image');
    }
  }

  return metadata;
}

async function checkDryRun(): Promise<boolean> {
  return process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
}

async function main() {
  try {
    logger.info('🚀 Starting Secure Pump.fun Bundler...');
    
    // Check for dry run mode
    const isDryRun = await checkDryRun();
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
    
    // Initialize bundler
    logger.info('🔧 Initializing bundler...');
    const bundler = new SecurePumpBundler(bundlerConfig);
    
    // Display wallet info
    const walletInfo = bundler.getWalletInfo();
    logger.info('\n📊 Bundler Information:');
    logger.info(`   Main wallet: ${walletInfo.mainWallet}`);
    logger.info(`   Generated wallets: ${walletInfo.walletCount}`);
    
    if (isDryRun) {
      logger.info('\n🧪 DRY RUN - Simulating operations...');
      logger.info('✅ All validations passed');
      logger.info('✅ Configuration is valid');
      logger.info('✅ Token metadata is ready');
      logger.info('✅ Bundler is properly initialized');
      logger.info('\n🎯 To run for real, remove DRY_RUN=true from .env or don\'t use --dry-run flag');
      return;
    }
    
    // Create and bundle token
    logger.info('\n🚀 Starting token creation and bundling...');
    const testMode = process.env.TEST_MODE === 'true';
    const result = await bundler.createAndBundle(tokenMetadata, testMode);
    
    if (result.success) {
      logger.info('\n🎉 SUCCESS! Token created and bundled successfully!');
      logger.info(`📝 Token Address: ${result.mint}`);
      logger.info(`🔗 Pump.fun URL: https://pump.fun/${result.mint}`);
      logger.info(`🔗 Solscan URL: https://solscan.io/token/${result.mint}`);
      
      // Save results
      const resultsPath = path.join(process.cwd(), 'logs', 'results.json');
      const resultsData = {
        timestamp: new Date().toISOString(),
        success: true,
        tokenAddress: result.mint,
        tokenMetadata,
        bundlerConfig: {
          walletCount: bundlerConfig.walletCount,
          swapAmountSol: bundlerConfig.swapAmountSol,
        },
      };
      fs.writeFileSync(resultsPath, JSON.stringify(resultsData, null, 2));
      logger.info(`💾 Results saved to: ${resultsPath}`);
      
    } else {
      logger.error('\n💥 FAILED to create and bundle token');
      logger.error('📋 Check the logs above for error details');
      logger.error('💡 Common issues:');
      logger.error('   - Insufficient SOL balance');
      logger.error('   - Network congestion (try increasing priority fees)');
      logger.error('   - RPC rate limits (use a paid RPC service)');
      logger.error('   - Invalid token metadata or image');
      
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
    
    logger.error('\n🔧 Troubleshooting tips:');
    logger.error('1. Check your .env configuration');
    logger.error('2. Ensure your wallet has sufficient SOL');
    logger.error('3. Verify your RPC endpoint is working');
    logger.error('4. Try running with DEBUG_MODE=true for more details');
    
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
#!/usr/bin/env node

require('dotenv').config();
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
// Use anchor's bs58 instead of base-58
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');

function parsePrivateKey(privateKeyString, walletType) {
  try {
    const privateKey = privateKeyString.trim();
    let secretKey;
    
    if (privateKey.startsWith('[')) {
      // Array format
      secretKey = new Uint8Array(JSON.parse(privateKey));
    } else {
      // Base58 format
      secretKey = bs58.decode(privateKey);
    }
    
    if (secretKey.length !== 64) {
      throw new Error(`Invalid ${walletType} key length: ${secretKey.length} (expected 64)`);
    }
    
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    throw new Error(`Invalid ${walletType} private key format: ${error.message}`);
  }
}

async function checkDualWalletBalance() {
  try {
    console.log('🔍 Checking DUAL WALLET balance...\n');
    
    // Validate environment
    if (!process.env.RPC_URL) {
      console.error('❌ RPC_URL not found in .env file');
      process.exit(1);
    }
    
    if (!process.env.CREATOR_WALLET_PRIVATE_KEY) {
      console.error('❌ CREATOR_WALLET_PRIVATE_KEY not found in .env file');
      process.exit(1);
    }
    
    if (!process.env.DISTRIBUTOR_WALLET_PRIVATE_KEY) {
      console.error('❌ DISTRIBUTOR_WALLET_PRIVATE_KEY not found in .env file');
      process.exit(1);
    }
    
    // Connect to Solana
    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    console.log(`📡 Connected to: ${process.env.RPC_URL}`);
    
    // Load both wallets
    const creatorWallet = parsePrivateKey(process.env.CREATOR_WALLET_PRIVATE_KEY, 'Creator');
    const distributorWallet = parsePrivateKey(process.env.DISTRIBUTOR_WALLET_PRIVATE_KEY, 'Distributor');
    
    // Verify they're different
    if (creatorWallet.publicKey.equals(distributorWallet.publicKey)) {
      console.error('❌ Creator and Distributor wallets must be different!');
      process.exit(1);
    }
    
    // Get balances
    const creatorBalance = await connection.getBalance(creatorWallet.publicKey);
    const creatorBalanceSOL = creatorBalance / LAMPORTS_PER_SOL;
    
    const distributorBalance = await connection.getBalance(distributorWallet.publicKey);
    const distributorBalanceSOL = distributorBalance / LAMPORTS_PER_SOL;
    
    console.log('💰 DUAL WALLET Information:');
    console.log('\n🎨 CREATOR WALLET (handles token creation + initial buy):');
    console.log(`   Address: ${creatorWallet.publicKey.toBase58()}`);
    console.log(`   Balance: ${creatorBalanceSOL.toFixed(6)} SOL`);
    console.log(`   Balance: ${creatorBalance.toLocaleString()} lamports`);
    
    console.log('\n💰 DISTRIBUTOR WALLET (funds bundled buy wallets):');
    console.log(`   Address: ${distributorWallet.publicKey.toBase58()}`);
    console.log(`   Balance: ${distributorBalanceSOL.toFixed(6)} SOL`);
    console.log(`   Balance: ${distributorBalance.toLocaleString()} lamports`);
    
    // Calculate requirements
    const walletCount = parseInt(process.env.WALLET_COUNT || '10');
    const swapAmount = parseFloat(process.env.SWAP_AMOUNT_SOL || '0.001');
    const jitoTip = parseInt(process.env.JITO_TIP_LAMPORTS || '1000000') / LAMPORTS_PER_SOL;
    
    // Creator wallet needs: token creation fees + initial buy + buffer
    const creatorNeeds = swapAmount + 0.05; // Initial buy + creation fees + buffer
    
    // Distributor wallet needs: all bundled wallets + jito tip + fees
    const distributorNeeds = (walletCount * (swapAmount + 0.005)) + jitoTip + 0.02;
    
    const totalNeeded = creatorNeeds + distributorNeeds;
    
    console.log('\n📊 DUAL WALLET Cost Analysis:');
    console.log(`   Bundled wallets: ${walletCount}`);
    console.log(`   SOL per wallet: ${swapAmount} SOL`);
    
    console.log('\n🎨 CREATOR WALLET Requirements:');
    console.log(`   Token creation + fees: ~0.05 SOL`);
    console.log(`   Initial buy: ${swapAmount} SOL`);
    console.log(`   Total needed: ${creatorNeeds.toFixed(6)} SOL`);
    
    console.log('\n💰 DISTRIBUTOR WALLET Requirements:');
    console.log(`   Bundled purchases: ${(walletCount * swapAmount).toFixed(6)} SOL`);
    console.log(`   Wallet funding buffer: ${(walletCount * 0.005).toFixed(6)} SOL`);
    console.log(`   Jito tip: ${jitoTip.toFixed(6)} SOL`);
    console.log(`   Transaction fees: ~0.02 SOL`);
    console.log(`   Total needed: ${distributorNeeds.toFixed(6)} SOL`);
    
    console.log('\n📈 COMBINED Requirements:');
    console.log(`   Total needed: ${totalNeeded.toFixed(6)} SOL`);
    console.log(`   Total available: ${(creatorBalanceSOL + distributorBalanceSOL).toFixed(6)} SOL`);
    
    // Status check for each wallet
    const creatorSufficient = creatorBalanceSOL >= creatorNeeds;
    const distributorSufficient = distributorBalanceSOL >= distributorNeeds;
    const overallSufficient = creatorSufficient && distributorSufficient;
    
    const creatorStatus = creatorSufficient ? '✅ Sufficient' : '❌ Insufficient';
    const distributorStatus = distributorSufficient ? '✅ Sufficient' : '❌ Insufficient';
    const overallStatus = overallSufficient ? '✅ Ready to Launch' : '❌ Needs Funding';
    
    const statusColor = overallSufficient ? '\x1b[32m' : '\x1b[31m'; // Green or Red
    
    console.log(`\n${statusColor}📊 WALLET STATUS:\x1b[0m`);
    console.log(`   🎨 Creator wallet: ${creatorStatus}`);
    console.log(`   💰 Distributor wallet: ${distributorStatus}`);
    console.log(`   🚀 Overall status: ${overallStatus}`);
    
    if (overallSufficient) {
      const creatorRemaining = creatorBalanceSOL - creatorNeeds;
      const distributorRemaining = distributorBalanceSOL - distributorNeeds;
      console.log(`\n💰 Remaining after operation:`);
      console.log(`   🎨 Creator: ${creatorRemaining.toFixed(6)} SOL`);
      console.log(`   💰 Distributor: ${distributorRemaining.toFixed(6)} SOL`);
      
      if (creatorRemaining < 0.01 || distributorRemaining < 0.01) {
        console.log('\n⚠️  Warning: Very low remaining balance after operation');
      }
    } else {
      console.log(`\n💡 FUNDING REQUIREMENTS:`);
      if (!creatorSufficient) {
        const creatorShortfall = creatorNeeds - creatorBalanceSOL;
        console.log(`   🎨 Creator needs: ${creatorShortfall.toFixed(6)} SOL more`);
      }
      if (!distributorSufficient) {
        const distributorShortfall = distributorNeeds - distributorBalanceSOL;
        console.log(`   💰 Distributor needs: ${distributorShortfall.toFixed(6)} SOL more`);
      }
    }
    
    // Network info
    const networkInfo = process.env.RPC_URL.toLowerCase();
    const isDevnet = networkInfo.includes('devnet');
    const isMainnet = networkInfo.includes('mainnet') || (!networkInfo.includes('devnet') && !networkInfo.includes('testnet'));
    
    console.log(`\n🌐 Network: ${isDevnet ? 'DEVNET' : isMainnet ? 'MAINNET' : 'UNKNOWN'}`);
    
    if (isMainnet && (creatorBalanceSOL > 0.1 || distributorBalanceSOL > 0.1)) {
      console.log('\n⚠️  MAINNET DETECTED with significant balance');
      console.log('   Please double-check everything before proceeding!');
    }
    
    // Cost in USD (rough estimate)
    const solPriceUSD = 200; // Updated estimate
    const costUSD = totalNeeded * solPriceUSD;
    console.log(`\n💵 Estimated cost: $${costUSD.toFixed(2)} USD (at $${solPriceUSD}/SOL)`);
    
    // Final recommendation
    console.log('\n🎯 RECOMMENDATION:');
    if (overallSufficient) {
      if (totalNeeded < 0.01) {
        console.log('   ✅ Perfect for testing - very low cost');
      } else if (totalNeeded < 0.05) {
        console.log('   ✅ Good for testing - reasonable cost');
      } else {
        console.log('   ⚠️  Consider reducing amounts for first test');
      }
      console.log('   🚀 DUAL WALLET setup is ready to launch!');
    } else {
      console.log('   ❌ Fund the required wallets before proceeding');
      console.log('   💡 Each wallet has a specific role in the dual wallet setup');
    }
    
  } catch (error) {
    console.error('❌ Error checking DUAL WALLET balance:', error.message);
    
    if (error.message.includes('fetch')) {
      console.log('\n💡 This might be a network issue. Check your RPC_URL');
    } else if (error.message.includes('decode') || error.message.includes('format')) {
      console.log('\n💡 This might be a private key format issue');
      console.log('   Make sure both CREATOR_WALLET_PRIVATE_KEY and DISTRIBUTOR_WALLET_PRIVATE_KEY are set correctly');
    }
    
    process.exit(1);
  }
}

// Handle command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('DUAL WALLET Balance Checker for Secure Pump.fun Bundler\n');
  console.log('Usage: npm run balance\n');
  console.log('This script checks both creator and distributor wallet balances');
  console.log('and calculates whether you have sufficient SOL for bundler operations.\n');
  console.log('Required environment variables:');
  console.log('  - CREATOR_WALLET_PRIVATE_KEY (handles token creation)');
  console.log('  - DISTRIBUTOR_WALLET_PRIVATE_KEY (funds bundled wallets)');
  console.log('  - RPC_URL');
  process.exit(0);
}

if (require.main === module) {
  checkDualWalletBalance();
}

module.exports = { checkDualWalletBalance };
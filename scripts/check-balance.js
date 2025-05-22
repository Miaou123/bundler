#!/usr/bin/env node

require('dotenv').config();
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
// Use anchor's bs58 instead of base-58
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');

async function checkBalance() {
  try {
    console.log('🔍 Checking wallet balance...\n');
    
    // Validate environment
    if (!process.env.RPC_URL) {
      console.error('❌ RPC_URL not found in .env file');
      process.exit(1);
    }
    
    if (!process.env.MAIN_WALLET_PRIVATE_KEY) {
      console.error('❌ MAIN_WALLET_PRIVATE_KEY not found in .env file');
      process.exit(1);
    }
    
    // Connect to Solana
    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    console.log(`📡 Connected to: ${process.env.RPC_URL}`);
    
    // Load wallet
    let keypair;
    try {
      const privateKey = process.env.MAIN_WALLET_PRIVATE_KEY.trim();
      let secretKey;
      
      if (privateKey.startsWith('[')) {
        // Array format
        secretKey = new Uint8Array(JSON.parse(privateKey));
      } else {
        // Base58 format
        secretKey = bs58.decode(privateKey);
      }
      
      keypair = Keypair.fromSecretKey(secretKey);
    } catch (error) {
      console.error('❌ Invalid private key format:', error.message);
      process.exit(1);
    }
    
    // Get balance
    const balance = await connection.getBalance(keypair.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    
    console.log('💰 Wallet Information:');
    console.log(`   Address: ${keypair.publicKey.toBase58()}`);
    console.log(`   Balance: ${balanceSOL.toFixed(6)} SOL`);
    console.log(`   Balance: ${balance.toLocaleString()} lamports`);
    
    // Calculate requirements
    const walletCount = parseInt(process.env.WALLET_COUNT || '10');
    const swapAmount = parseFloat(process.env.SWAP_AMOUNT_SOL || '0.001');
    const jitoTip = parseInt(process.env.JITO_TIP_LAMPORTS || '1000000') / LAMPORTS_PER_SOL;
    const estimatedFees = 0.01; // Rough estimate for transaction fees
    
    const totalNeeded = (walletCount * swapAmount) + jitoTip + estimatedFees;
    
    console.log('\n📊 Cost Analysis:');
    console.log(`   Wallets: ${walletCount}`);
    console.log(`   SOL per wallet: ${swapAmount} SOL`);
    console.log(`   Token purchases: ${(walletCount * swapAmount).toFixed(6)} SOL`);
    console.log(`   Jito tip: ${jitoTip.toFixed(6)} SOL`);
    console.log(`   Estimated fees: ${estimatedFees.toFixed(6)} SOL`);
    console.log(`   Total needed: ${totalNeeded.toFixed(6)} SOL`);
    
    // Status check
    const sufficient = balanceSOL >= totalNeeded;
    const status = sufficient ? '✅ Sufficient' : '❌ Insufficient';
    const statusColor = sufficient ? '\x1b[32m' : '\x1b[31m'; // Green or Red
    
    console.log(`\n${statusColor}📈 Status: ${status}\x1b[0m`);
    
    if (sufficient) {
      const remaining = balanceSOL - totalNeeded;
      console.log(`   Remaining after operation: ${remaining.toFixed(6)} SOL`);
      
      if (remaining < 0.01) {
        console.log('\n⚠️  Warning: Very low remaining balance after operation');
      }
    } else {
      const shortfall = totalNeeded - balanceSOL;
      console.log(`   Shortfall: ${shortfall.toFixed(6)} SOL`);
      console.log(`\n💡 You need to add ${shortfall.toFixed(6)} SOL to your wallet`);
    }
    
    // Network info
    const networkInfo = process.env.RPC_URL.toLowerCase();
    const isDevnet = networkInfo.includes('devnet');
    const isMainnet = networkInfo.includes('mainnet') || (!networkInfo.includes('devnet') && !networkInfo.includes('testnet'));
    
    console.log(`\n🌐 Network: ${isDevnet ? 'DEVNET' : isMainnet ? 'MAINNET' : 'UNKNOWN'}`);
    
    if (isMainnet && balanceSOL > 0.1) {
      console.log('\n⚠️  MAINNET DETECTED with significant balance');
      console.log('   Please double-check everything before proceeding!');
    }
    
    // Cost in USD (rough estimate)
    const solPriceUSD = 200; // Updated estimate
    const costUSD = totalNeeded * solPriceUSD;
    console.log(`\n💵 Estimated cost: $${costUSD.toFixed(2)} USD (at $${solPriceUSD}/SOL)`);
    
    // Final recommendation
    console.log('\n🎯 RECOMMENDATION:');
    if (sufficient) {
      if (totalNeeded < 0.01) {
        console.log('   ✅ Perfect for testing - very low cost');
      } else if (totalNeeded < 0.05) {
        console.log('   ✅ Good for testing - reasonable cost');
      } else {
        console.log('   ⚠️  Consider reducing amounts for first test');
      }
    } else {
      console.log('   ❌ Add more SOL before proceeding');
    }
    
  } catch (error) {
    console.error('❌ Error checking balance:', error.message);
    
    if (error.message.includes('fetch')) {
      console.log('\n💡 This might be a network issue. Check your RPC_URL');
    } else if (error.message.includes('decode')) {
      console.log('\n💡 This might be a private key format issue');
      console.log('   Try running: node scripts/validate-private-key.js');
    }
    
    process.exit(1);
  }
}

// Handle command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Balance Checker for Secure Pump.fun Bundler\n');
  console.log('Usage: npm run balance\n');
  console.log('This script checks your main wallet balance and calculates');
  console.log('whether you have sufficient SOL for bundler operations.\n');
  console.log('Configuration is loaded from .env file.');
  process.exit(0);
}

if (require.main === module) {
  checkBalance();
}

module.exports = { checkBalance };
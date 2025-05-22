#!/usr/bin/env node

require('dotenv').config();

console.log('🔧 Testing bundler configuration...\n');

// Test required environment variables
const requiredVars = [
  'RPC_URL',
  'MAIN_WALLET_PRIVATE_KEY',
  'TOKEN_NAME',
  'TOKEN_SYMBOL',
  'TOKEN_DESCRIPTION',
  'TOKEN_IMAGE_PATH'
];

let hasErrors = false;

console.log('📋 Environment Variables:');
requiredVars.forEach(varName => {
  const value = process.env[varName];
  const status = value ? '✅' : '❌';
  console.log(`   ${status} ${varName}: ${value ? 'Set' : 'Missing'}`);
  if (!value) hasErrors = true;
});

// Test optional variables
console.log('\n📋 Optional Variables:');
const optionalVars = [
  'WALLET_COUNT',
  'SWAP_AMOUNT_SOL',
  'JITO_TIP_LAMPORTS',
  'SLIPPAGE_BASIS_POINTS'
];

optionalVars.forEach(varName => {
  const value = process.env[varName];
  const status = value ? '✅' : '⚠️';
  console.log(`   ${status} ${varName}: ${value || 'Using default'}`);
});

// Test image file
console.log('\n📁 File Checks:');
const fs = require('fs');
const imagePath = process.env.TOKEN_IMAGE_PATH || './assets/token-image.png';
const imageExists = fs.existsSync(imagePath);
console.log(`   ${imageExists ? '✅' : '❌'} Image file: ${imagePath}`);
if (!imageExists) hasErrors = true;

// Test wallet format
console.log('\n🔑 Wallet Validation:');
if (process.env.MAIN_WALLET_PRIVATE_KEY) {
  try {
    // Use anchor's bs58 since it's working (same as the validator script)
    const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
    const { Keypair } = require('@solana/web3.js');
    
    const privateKey = process.env.MAIN_WALLET_PRIVATE_KEY.trim();
    let secretKey;
    let format = 'unknown';
    
    // Check format and decode
    if (privateKey.startsWith('[') && privateKey.endsWith(']')) {
      // Array format
      const keyArray = JSON.parse(privateKey);
      secretKey = new Uint8Array(keyArray);
      format = 'array';
    } else {
      // Base58 format
      secretKey = bs58.decode(privateKey);
      format = 'base58';
    }
    
    if (secretKey.length !== 64) {
      throw new Error(`Invalid key length: ${secretKey.length} (expected 64)`);
    }
    
    const keypair = Keypair.fromSecretKey(secretKey);
    console.log(`   ✅ Wallet format: Valid (${format})`);
    console.log(`   📝 Public key: ${keypair.publicKey.toBase58()}`);
    console.log(`   🔑 Key length: ${secretKey.length} bytes`);
    
  } catch (error) {
    console.log(`   ❌ Wallet format: Invalid (${error.message})`);
    console.log(`   💡 Tip: Make sure you exported the PRIVATE KEY from Phantom, not the public key`);
    console.log(`   💡 Tip: Run 'node scripts/validate-private-key.js' for detailed validation`);
    hasErrors = true;
  }
}

// Test RPC connection
console.log('\n🌐 Network Connection:');
if (process.env.RPC_URL) {
  const { Connection } = require('@solana/web3.js');
  
  (async () => {
    try {
      const connection = new Connection(process.env.RPC_URL, 'confirmed');
      const version = await connection.getVersion();
      console.log(`   ✅ RPC connection: Working (Solana ${version['solana-core']})`);
      
      const isDevnet = process.env.RPC_URL.toLowerCase().includes('devnet');
      const network = isDevnet ? 'DEVNET' : 'MAINNET';
      console.log(`   🌐 Network: ${network}`);
      
    } catch (error) {
      console.log(`   ❌ RPC connection: Failed (${error.message})`);
      hasErrors = true;
    }
    
    // Final result
    console.log('\n' + '='.repeat(50));
    if (hasErrors) {
      console.log('❌ Configuration has errors - please fix before running');
      process.exit(1);
    } else {
      console.log('✅ Configuration is valid - ready to run!');
      
      // Show estimated costs
      const walletCount = parseInt(process.env.WALLET_COUNT || '10');
      const swapAmount = parseFloat(process.env.SWAP_AMOUNT_SOL || '0.001');
      const jitoTip = parseInt(process.env.JITO_TIP_LAMPORTS || '1000000') / 1000000000;
      const total = (walletCount * swapAmount) + jitoTip + 0.01;
      
      console.log(`\n💰 Estimated cost: ${total.toFixed(6)} SOL`);
      console.log(`   - Token purchases: ${(walletCount * swapAmount).toFixed(6)} SOL`);
      console.log(`   - Jito tip: ${jitoTip.toFixed(6)} SOL`);
      console.log(`   - Transaction fees: ~0.01 SOL`);
      
      process.exit(0);
    }
  })();
} else {
  console.log('\n❌ Cannot test RPC without RPC_URL');
  process.exit(1);
}
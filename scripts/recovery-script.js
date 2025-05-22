#!/usr/bin/env node

require('dotenv').config();
const { Connection, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
const fs = require('fs');
const path = require('path');

async function recoverFromBackup(backupFile) {
  try {
    console.log(`🔄 Loading backup from: ${backupFile}`);
    
    if (!fs.existsSync(backupFile)) {
      throw new Error(`Backup file not found: ${backupFile}`);
    }
    
    const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    
    console.log(`📊 Backup Info:`);
    console.log(`   Session ID: ${backupData.sessionId}`);
    console.log(`   Created: ${backupData.createdAt}`);
    console.log(`   Status: ${backupData.status}`);
    console.log(`   Main Wallet: ${backupData.mainWallet}`);
    console.log(`   Wallets: ${backupData.walletCount}`);
    
    // Connect to Solana
    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    
    // Load main wallet
    const mainPrivateKey = process.env.MAIN_WALLET_PRIVATE_KEY.trim();
    const mainSecretKey = bs58.decode(mainPrivateKey);
    const mainWallet = Keypair.fromSecretKey(mainSecretKey);
    
    if (mainWallet.publicKey.toBase58() !== backupData.mainWallet) {
      throw new Error('Main wallet mismatch! Check your private key.');
    }
    
    console.log(`\n💰 Recovering SOL from ${backupData.wallets.length} wallets...\n`);
    
    let totalRecovered = 0;
    let successCount = 0;
    const recoveryResults = [];
    
    for (const walletInfo of backupData.wallets) {
      try {
        console.log(`🔍 Checking wallet ${walletInfo.index + 1}: ${walletInfo.address}`);
        
        // Recreate wallet from private key
        const walletSecretKey = bs58.decode(walletInfo.privateKey);
        const wallet = Keypair.fromSecretKey(walletSecretKey);
        
        // Check current balance
        const balance = await connection.getBalance(wallet.publicKey);
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        console.log(`   Balance: ${balanceSOL.toFixed(6)} SOL`);
        
        if (balance > 5000) { // Keep some for rent exemption
          const recoverAmount = balance - 5000;
          const recoverSOL = recoverAmount / LAMPORTS_PER_SOL;
          
          console.log(`   💸 Recovering ${recoverSOL.toFixed(6)} SOL...`);
          
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: mainWallet.publicKey,
              lamports: BigInt(recoverAmount),
            })
          );
          
          const signature = await connection.sendTransaction(tx, [wallet], {
            skipPreflight: false,
            maxRetries: 3,
          });
          
          await connection.confirmTransaction(signature, 'confirmed');
          
          totalRecovered += recoverAmount;
          successCount++;
          
          console.log(`   ✅ Recovered! Signature: ${signature}`);
          
          recoveryResults.push({
            wallet: walletInfo.address,
            recovered: recoverSOL,
            signature,
            success: true,
          });
        } else {
          console.log(`   ⚪ No SOL to recover (${balanceSOL.toFixed(6)} SOL)`);
          recoveryResults.push({
            wallet: walletInfo.address,
            recovered: 0,
            success: true,
            reason: 'insufficient_balance',
          });
        }
        
      } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
        recoveryResults.push({
          wallet: walletInfo.address,
          success: false,
          error: error.message,
        });
      }
      
      // Small delay between operations
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`\n📊 Recovery Summary:`);
    console.log(`   Wallets processed: ${backupData.walletCount}`);
    console.log(`   Successful recoveries: ${successCount}`);
    console.log(`   Total recovered: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`   Value recovered: ~$${((totalRecovered / LAMPORTS_PER_SOL) * 200).toFixed(2)} USD`);
    
    // Update backup file with recovery results
    backupData.recoveryResults = {
      recoveredAt: new Date().toISOString(),
      walletsProcessed: backupData.walletCount,
      successfulRecoveries: successCount,
      totalRecoveredLamports: totalRecovered,
      totalRecoveredSOL: totalRecovered / LAMPORTS_PER_SOL,
      details: recoveryResults,
    };
    backupData.status = 'recovered';
    
    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
    console.log(`\n✅ Recovery complete! Updated backup file.`);
    
    // Archive the backup
    const archiveDir = path.join(path.dirname(backupFile), 'archive');
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }
    
    const archivePath = path.join(archiveDir, `${backupData.sessionId}_recovered.json`);
    fs.copyFileSync(backupFile, archivePath);
    fs.unlinkSync(backupFile); // Remove original
    
    console.log(`📦 Backup archived to: ${archivePath}`);
    
  } catch (error) {
    console.error('❌ Recovery failed:', error.message);
    process.exit(1);
  }
}

async function listBackups() {
  const walletsDir = path.join(process.cwd(), 'wallets');
  
  if (!fs.existsSync(walletsDir)) {
    console.log('📁 No wallets directory found');
    return;
  }
  
  const files = fs.readdirSync(walletsDir)
    .filter(file => file.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a)); // Newest first
  
  if (files.length === 0) {
    console.log('📄 No backup files found');
    return;
  }
  
  console.log(`📋 Found ${files.length} backup file(s):\n`);
  
  files.forEach((file, index) => {
    try {
      const filePath = path.join(walletsDir, file);
      const backupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      console.log(`${index + 1}. ${file}`);
      console.log(`   Session: ${backupData.sessionId}`);
      console.log(`   Created: ${new Date(backupData.createdAt).toLocaleString()}`);
      console.log(`   Status: ${backupData.status}`);
      console.log(`   Wallets: ${backupData.walletCount}`);
      console.log(`   Network: ${backupData.network}`);
      console.log('');
    } catch (error) {
      console.log(`${index + 1}. ${file} (corrupted)`);
    }
  });
  
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log('SOL Recovery Tool\n');
    console.log('Usage:');
    console.log('  node scripts/recover-sol.js --list           # List all backup files');
    console.log('  node scripts/recover-sol.js <backup-file>    # Recover from specific backup');
    console.log('  node scripts/recover-sol.js --latest         # Recover from latest backup');
    console.log('');
    return;
  }
  
  if (args.includes('--list')) {
    await listBackups();
    return;
  }
  
  if (args.includes('--latest')) {
    const files = await listBackups();
    if (files && files.length > 0) {
      const latestFile = path.join(process.cwd(), 'wallets', files[0]);
      await recoverFromBackup(latestFile);
    }
    return;
  }
  
  if (args.length === 0) {
    console.log('❌ Please specify a backup file or use --list to see available backups');
    console.log('Usage: node scripts/recover-sol.js <backup-file>');
    return;
  }
  
  const backupFile = args[0];
  const fullPath = path.isAbsolute(backupFile) ? backupFile : path.join(process.cwd(), 'wallets', backupFile);
  
  await recoverFromBackup(fullPath);
}

if (require.main === module) {
  main();
}
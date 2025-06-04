#!/usr/bin/env node

// scripts/recovery-enhanced.js - Enhanced recovery for new backup format

require('dotenv').config();
const { Connection, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
const fs = require('fs');
const path = require('path');

async function recoverFromEnhancedBackup(backupFile) {
  try {
    console.log(`🔄 Loading enhanced backup from: ${backupFile}`);
    
    if (!fs.existsSync(backupFile)) {
      throw new Error(`Backup file not found: ${backupFile}`);
    }
    
    const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    
    console.log(`📊 Enhanced Backup Info:`);
    console.log(`   Session ID: ${backupData.sessionId}`);
    console.log(`   Created: ${new Date(backupData.createdAt).toLocaleString()}`);
    console.log(`   Status: ${backupData.status.toUpperCase()}`);
    console.log(`   Network: ${backupData.network}`);
    
    if (backupData.mint) {
      console.log(`   Token: ${backupData.mint}`);
      console.log(`   Pump.fun: https://pump.fun/${backupData.mint}`);
    }
    
    console.log(`   Creator Wallet: ${backupData.creatorWallet}`);
    console.log(`   Distributor Wallet: ${backupData.distributorWallet}`);
    console.log(`   Total Wallets: ${backupData.walletCount}`);
    
    if (backupData.error) {
      console.log(`   Error: ${backupData.error}`);
    }
    
    console.log(`\n💰 Financial Summary:`);
    console.log(`   SOL Distributed: ${backupData.totalSolDistributed.toFixed(6)} SOL`);
    console.log(`   SOL Recovered: ${backupData.totalSolRecovered.toFixed(6)} SOL`);
    console.log(`   SOL Lost/Retained: ${backupData.solLost.toFixed(6)} SOL`);
    
    // Check if recovery was already attempted
    if (backupData.recoveryAttempted) {
      console.log(`\n⚠️  Recovery was already attempted on this backup:`);
      if (backupData.recoveryResults) {
        console.log(`   Successful: ${backupData.recoveryResults.successful}`);
        console.log(`   Failed: ${backupData.recoveryResults.failed}`);
        console.log(`   Total Recovered: ${backupData.recoveryResults.totalRecovered.toFixed(6)} SOL`);
      }
      
      console.log(`\n❓ Do you want to attempt recovery again? (y/N)`);
      const answer = await getUserInput();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('Recovery cancelled');
        return;
      }
    }
    
    // Connect to Solana
    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    
    // Load distributor wallet (where we'll send recovered SOL)
    const distributorPrivateKey = process.env.DISTRIBUTOR_WALLET_PRIVATE_KEY.trim();
    let distributorSecretKey;
    
    if (distributorPrivateKey.startsWith('[')) {
      distributorSecretKey = new Uint8Array(JSON.parse(distributorPrivateKey));
    } else {
      distributorSecretKey = bs58.decode(distributorPrivateKey);
    }
    
    const distributorWallet = Keypair.fromSecretKey(distributorSecretKey);
    
    if (distributorWallet.publicKey.toBase58() !== backupData.distributorWallet) {
      throw new Error('Distributor wallet mismatch! Check your DISTRIBUTOR_WALLET_PRIVATE_KEY.');
    }
    
    console.log(`\n💰 Starting enhanced recovery from ${backupData.wallets.length} wallets...`);
    console.log(`   Target distributor wallet: ${backupData.distributorWallet}`);
    console.log(`   Recovery strategy: Maximum SOL recovery (emergency mode)`);
    
    let totalRecovered = 0;
    let successCount = 0;
    const recoveryResults = [];
    
    for (let i = 0; i < backupData.wallets.length; i++) {
      const walletInfo = backupData.wallets[i];
      
      try {
        console.log(`\n🔍 Processing wallet ${i + 1}/${backupData.wallets.length}:`);
        console.log(`   Address: ${walletInfo.publicKey}`);
        console.log(`   Status: ${walletInfo.status.toUpperCase()}`);
        console.log(`   Initial Balance: ${walletInfo.initialBalance.toFixed(6)} SOL`);
        console.log(`   Final Balance: ${walletInfo.finalBalance.toFixed(6)} SOL`);
        console.log(`   Previously Recovered: ${walletInfo.recovered.toFixed(6)} SOL`);
        
        // Recreate wallet from private key
        const walletSecretKey = bs58.decode(walletInfo.privateKey);
        const wallet = Keypair.fromSecretKey(walletSecretKey);
        
        // Get current balance
        const currentBalance = await connection.getBalance(wallet.publicKey);
        const currentBalanceSOL = currentBalance / LAMPORTS_PER_SOL;
        
        console.log(`   Current Live Balance: ${currentBalanceSOL.toFixed(6)} SOL`);
        
        // Emergency recovery: take everything except minimal rent exemption
        if (currentBalance > 5000) { // Keep only 5000 lamports for rent exemption
          const recoverAmount = currentBalance - 5000;
          const recoverSOL = recoverAmount / LAMPORTS_PER_SOL;
          
          console.log(`   💸 Attempting to recover ${recoverSOL.toFixed(6)} SOL...`);
          
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: distributorWallet.publicKey,
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
          
          console.log(`   ✅ Recovered ${recoverSOL.toFixed(6)} SOL!`);
          console.log(`   📝 Signature: ${signature}`);
          console.log(`   🔗 Solscan: https://solscan.io/tx/${signature}`);
          
          recoveryResults.push({
            walletIndex: i + 1,
            publicKey: walletInfo.publicKey,
            recovered: recoverSOL,
            signature,
            success: true,
          });
        } else {
          console.log(`   ⚪ No SOL to recover (balance: ${currentBalanceSOL.toFixed(6)} SOL)`);
          
          recoveryResults.push({
            walletIndex: i + 1,
            publicKey: walletInfo.publicKey,
            recovered: 0,
            success: true,
            reason: 'insufficient_balance',
          });
        }
        
      } catch (error) {
        console.log(`   ❌ Recovery failed: ${error.message}`);
        
        recoveryResults.push({
          walletIndex: i + 1,
          publicKey: walletInfo.publicKey,
          success: false,
          error: error.message,
        });
      }
      
      // Small delay between operations
      if (i < backupData.wallets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`\n📊 Enhanced Recovery Summary:`);
    console.log(`   Wallets processed: ${backupData.wallets.length}`);
    console.log(`   Successful recoveries: ${successCount}`);
    console.log(`   Total recovered: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`   Value recovered: ~$${((totalRecovered / LAMPORTS_PER_SOL) * 200).toFixed(2)} USD`);
    
    // Update backup file with recovery results
    backupData.recoveryAttempted = true;
    backupData.lastRecoveryAt = new Date().toISOString();
    backupData.totalSolRecovered += totalRecovered / LAMPORTS_PER_SOL;
    backupData.solLost = Math.max(0, backupData.totalSolDistributed - backupData.totalSolRecovered);
    
    if (!backupData.recoveryResults) {
      backupData.recoveryResults = {
        successful: 0,
        failed: 0,
        totalRecovered: 0,
        errors: [],
      };
    }
    
    backupData.recoveryResults.successful += successCount;
    backupData.recoveryResults.failed += (backupData.wallets.length - successCount);
    backupData.recoveryResults.totalRecovered += totalRecovered / LAMPORTS_PER_SOL;
    
    // Add detailed recovery log
    if (!backupData.recoveryLogs) {
      backupData.recoveryLogs = [];
    }
    
    backupData.recoveryLogs.push({
      timestamp: new Date().toISOString(),
      walletsProcessed: backupData.wallets.length,
      successful: successCount,
      failed: backupData.wallets.length - successCount,
      solRecovered: totalRecovered / LAMPORTS_PER_SOL,
      results: recoveryResults,
    });
    
    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
    console.log(`\n✅ Enhanced recovery complete! Updated backup file.`);
    
    // Create recovery report
    const reportPath = path.join(path.dirname(backupFile), `recovery_report_${Date.now()}.txt`);
    const report = generateRecoveryReport(backupData, recoveryResults, totalRecovered / LAMPORTS_PER_SOL);
    fs.writeFileSync(reportPath, report);
    console.log(`📄 Recovery report saved: ${reportPath}`);
    
    // Final recommendation
    console.log(`\n🎯 Final Status:`);
    if (successCount === backupData.wallets.length) {
      console.log(`   ✅ Perfect recovery - all wallets processed successfully`);
    } else if (successCount > 0) {
      console.log(`   ⚠️  Partial recovery - ${successCount}/${backupData.wallets.length} wallets recovered`);
    } else {
      console.log(`   ❌ No SOL recovered - wallets may be empty or inaccessible`);
    }
    
    if (backupData.solLost > 0.001) {
      console.log(`   💸 SOL still unrecovered: ${backupData.solLost.toFixed(6)} SOL`);
      console.log(`   💡 Check individual wallet balances manually if needed`);
    }
    
  } catch (error) {
    console.error('❌ Enhanced recovery failed:', error.message);
    process.exit(1);
  }
}

function generateRecoveryReport(backupData, recoveryResults, totalRecovered) {
  let report = `ENHANCED RECOVERY REPORT\n`;
  report += `=======================\n\n`;
  report += `Session ID: ${backupData.sessionId}\n`;
  report += `Recovery Date: ${new Date().toLocaleString()}\n`;
  report += `Original Status: ${backupData.status.toUpperCase()}\n`;
  report += `Network: ${backupData.network}\n\n`;
  
  if (backupData.mint) {
    report += `Token Address: ${backupData.mint}\n`;
    report += `Pump.fun URL: https://pump.fun/${backupData.mint}\n\n`;
  }
  
  report += `RECOVERY SUMMARY:\n`;
  report += `-----------------\n`;
  report += `Wallets Processed: ${backupData.wallets.length}\n`;
  report += `Successful Recoveries: ${recoveryResults.filter(r => r.success).length}\n`;
  report += `Failed Recoveries: ${recoveryResults.filter(r => !r.success).length}\n`;
  report += `Total SOL Recovered: ${totalRecovered.toFixed(6)} SOL\n`;
  report += `Estimated Value: $${(totalRecovered * 200).toFixed(2)} USD\n\n`;
  
  report += `DETAILED RECOVERY RESULTS:\n`;
  report += `--------------------------\n`;
  
  recoveryResults.forEach((result, i) => {
    report += `Wallet ${result.walletIndex}:\n`;
    report += `  Address: ${result.publicKey}\n`;
    report += `  Status: ${result.success ? 'SUCCESS' : 'FAILED'}\n`;
    
    if (result.success && result.recovered > 0) {
      report += `  SOL Recovered: ${result.recovered.toFixed(6)} SOL\n`;
      report += `  Transaction: ${result.signature}\n`;
      report += `  Solscan: https://solscan.io/tx/${result.signature}\n`;
    } else if (result.reason) {
      report += `  Reason: ${result.reason}\n`;
    } else if (result.error) {
      report += `  Error: ${result.error}\n`;
    }
    
    report += `  Solscan Address: https://solscan.io/account/${result.publicKey}\n\n`;
  });
  
  report += `FINANCIAL HISTORY:\n`;
  report += `------------------\n`;
  report += `Original SOL Distributed: ${backupData.totalSolDistributed.toFixed(6)} SOL\n`;
  report += `Total SOL Recovered: ${backupData.totalSolRecovered.toFixed(6)} SOL\n`;
  report += `SOL Lost/Unrecoverable: ${backupData.solLost.toFixed(6)} SOL\n`;
  report += `Recovery Rate: ${((backupData.totalSolRecovered / backupData.totalSolDistributed) * 100).toFixed(1)}%\n\n`;
  
  report += `MANUAL RECOVERY INSTRUCTIONS:\n`;
  report += `-----------------------------\n`;
  report += `If any SOL remains unrecovered:\n`;
  report += `1. Check individual wallet balances on Solscan using URLs above\n`;
  report += `2. Import private keys from the backup file into Phantom wallet\n`;
  report += `3. Manually transfer any remaining SOL\n`;
  report += `4. Private keys are in: ${backupData.sessionId}_backup.json\n\n`;
  
  report += `BACKUP FILE LOCATION:\n`;
  report += `--------------------\n`;
  report += `Enhanced Backup: ${backupData.sessionId}_backup.json\n`;
  report += `Human Summary: ${backupData.sessionId}_summary.txt\n`;
  report += `Recovery Report: recovery_report_${Date.now()}.txt\n\n`;
  
  return report;
}

async function listEnhancedBackups() {
  const walletsDir = path.join(process.cwd(), 'wallets');
  
  if (!fs.existsSync(walletsDir)) {
    console.log('📁 No wallets directory found');
    return [];
  }
  
  const files = fs.readdirSync(walletsDir)
    .filter(file => file.endsWith('_backup.json'))
    .sort((a, b) => b.localeCompare(a)); // Newest first
  
  if (files.length === 0) {
    console.log('📄 No enhanced backup files found');
    console.log('💡 Looking for files matching pattern: *_backup.json');
    
    // Check for any JSON files
    const allJsonFiles = fs.readdirSync(walletsDir).filter(f => f.endsWith('.json'));
    if (allJsonFiles.length > 0) {
      console.log(`\n📋 Found ${allJsonFiles.length} other JSON files:`);
      allJsonFiles.forEach(file => console.log(`   - ${file}`));
    }
    
    return [];
  }
  
  console.log(`📋 Found ${files.length} enhanced backup file(s):\n`);
  
  const backups = [];
  
  files.forEach((file, index) => {
    try {
      const filePath = path.join(walletsDir, file);
      const backupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      console.log(`${index + 1}. ${file}`);
      console.log(`   Session: ${backupData.sessionId}`);
      console.log(`   Created: ${new Date(backupData.createdAt).toLocaleString()}`);
      console.log(`   Status: ${backupData.status.toUpperCase()}`);
      console.log(`   Network: ${backupData.network}`);
      console.log(`   Wallets: ${backupData.walletCount}`);
      
      if (backupData.mint) {
        console.log(`   Token: ${backupData.mint}`);
      }
      
      // Financial summary
      console.log(`   SOL Distributed: ${backupData.totalSolDistributed.toFixed(6)}`);
      console.log(`   SOL Recovered: ${backupData.totalSolRecovered.toFixed(6)}`);
      console.log(`   SOL Lost: ${backupData.solLost.toFixed(6)}`);
      
      // Recovery status
      if (backupData.recoveryAttempted) {
        console.log(`   Recovery: Previously attempted`);
        if (backupData.recoveryResults) {
          console.log(`   Last Recovery: ${backupData.recoveryResults.successful}/${backupData.walletCount} successful`);
        }
      } else {
        console.log(`   Recovery: Not attempted`);
      }
      
      if (backupData.error) {
        console.log(`   Error: ${backupData.error.substring(0, 60)}...`);
      }
      
      console.log('');
      
      backups.push({
        file,
        path: filePath,
        data: backupData
      });
      
    } catch (error) {
      console.log(`${index + 1}. ${file} (corrupted or invalid format)`);
      console.log(`   Error: ${error.message}`);
      console.log('');
    }
  });
  
  return backups;
}

async function analyzeWalletStatus(backupFile) {
  try {
    console.log(`🔍 Analyzing wallet status from: ${backupFile}`);
    
    const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    
    console.log(`\n📊 Live Wallet Analysis:`);
    console.log(`   Session: ${backupData.sessionId}`);
    console.log(`   Status: ${backupData.status.toUpperCase()}`);
    console.log(`   Network: ${backupData.network}`);
    
    let totalCurrentBalance = 0;
    let walletsWithBalance = 0;
    
    console.log(`\n💰 Current wallet balances:`);
    
    for (let i = 0; i < backupData.wallets.length; i++) {
      const walletInfo = backupData.wallets[i];
      
      try {
        const publicKey = new (require('@solana/web3.js').PublicKey)(walletInfo.publicKey);
        const currentBalance = await connection.getBalance(publicKey);
        const currentBalanceSOL = currentBalance / LAMPORTS_PER_SOL;
        
        if (currentBalanceSOL > 0.001) { // Only show wallets with meaningful balance
          walletsWithBalance++;
          console.log(`   Wallet ${i + 1}: ${currentBalanceSOL.toFixed(6)} SOL (${walletInfo.publicKey.slice(0, 8)}...)`);
        }
        
        totalCurrentBalance += currentBalanceSOL;
        
      } catch (error) {
        console.log(`   Wallet ${i + 1}: Error checking balance (${walletInfo.publicKey.slice(0, 8)}...)`);
      }
    }
    
    console.log(`\n📈 Analysis Summary:`);
    console.log(`   Total wallets: ${backupData.walletCount}`);
    console.log(`   Wallets with balance: ${walletsWithBalance}`);
    console.log(`   Current total balance: ${totalCurrentBalance.toFixed(6)} SOL`);
    console.log(`   Originally distributed: ${backupData.totalSolDistributed.toFixed(6)} SOL`);
    console.log(`   Previously recovered: ${backupData.totalSolRecovered.toFixed(6)} SOL`);
    console.log(`   Potential recovery: ${totalCurrentBalance.toFixed(6)} SOL`);
    
    if (totalCurrentBalance > 0.001) {
      console.log(`\n💡 Recommendation: ${totalCurrentBalance.toFixed(6)} SOL can be recovered`);
      console.log(`   Estimated value: ~${(totalCurrentBalance * 200).toFixed(2)} USD`);
    } else {
      console.log(`\n✅ No significant SOL remaining in wallets`);
    }
    
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
  }
}

function getUserInput() {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
// Replace the main function in your recovery script with this fixed version:

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Enhanced SOL Recovery Tool for Pump.fun Bundler\n');
    console.log('Usage:');
    console.log('  node scripts/recovery-enhanced.js --list           # List all enhanced backup files');
    console.log('  node scripts/recovery-enhanced.js --analyze <file> # Analyze current wallet status');
    console.log('  node scripts/recovery-enhanced.js <backup-file>    # Recover from specific backup');
    console.log('  node scripts/recovery-enhanced.js --latest         # Recover from latest backup');
    console.log('');
    console.log('Features:');
    console.log('  - Complete SOL recovery (no retention on failed bundles)');
    console.log('  - Detailed wallet backup with private keys');
    console.log('  - Recovery reports and summaries');
    console.log('  - Live wallet balance analysis');
    console.log('');
    return;
  }
  
  if (args.includes('--list')) {
    await listEnhancedBackups();
    return;
  }
  
  if (args.includes('--analyze')) {
    const backupFile = args[args.indexOf('--analyze') + 1];
    if (!backupFile) {
      console.log('❌ Please specify a backup file to analyze');
      return;
    }
    
    // FIXED: Better path handling
    let fullPath;
    if (path.isAbsolute(backupFile)) {
      fullPath = backupFile;
    } else if (backupFile.includes('/')) {
      // If it already has a path, use as-is
      fullPath = backupFile;
    } else {
      // Just filename, add wallets/ prefix
      fullPath = path.join(process.cwd(), 'wallets', backupFile);
    }
    
    console.log(`🔍 Looking for file: ${fullPath}`);
    await analyzeWalletStatus(fullPath);
    return;
  }
  
  if (args.includes('--latest')) {
    const backups = await listEnhancedBackups();
    if (backups && backups.length > 0) {
      console.log(`\n🎯 Using latest backup: ${backups[0].file}`);
      await recoverFromEnhancedBackup(backups[0].path);
    } else {
      console.log('❌ No backup files found');
    }
    return;
  }
  
  if (args.length === 0) {
    console.log('❌ Please specify a backup file or use --list to see available backups');
    console.log('Usage: node scripts/recovery-enhanced.js <backup-file>');
    console.log('Help: node scripts/recovery-enhanced.js --help');
    return;
  }
  
  const backupFile = args[0];
  
  // FIXED: Better path handling for direct file recovery
  let fullPath;
  if (path.isAbsolute(backupFile)) {
    fullPath = backupFile;
  } else if (backupFile.includes('/')) {
    // If it already has a path (like wallets/filename), use as-is
    fullPath = backupFile;
  } else {
    // Just filename, add wallets/ prefix
    fullPath = path.join(process.cwd(), 'wallets', backupFile);
  }
  
  console.log(`🔍 Looking for file: ${fullPath}`);
  await recoverFromEnhancedBackup(fullPath);
}

if (require.main === module) {
  main().catch(console.error);
}
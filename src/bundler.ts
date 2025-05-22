import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import { BN } from 'bn.js';
import { BundlerConfig } from './config';
import { logger } from './utils/logger';
import {
  createTokenInstruction,
  buyTokenInstruction,
  getGlobalPDA,
  getBondingCurvePDA,
  getMetadataPDA,
  CreateTokenParams,
  BuyTokenParams,
  parseGlobalAccount,
  parseBondingCurveAccount,
} from './instructions';
import { sendJitoBundle } from './jito';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import fs from 'fs';
import path from 'path';

export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  imagePath: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface BundleResult {
  success: boolean;
  mint?: string;
  signature?: string;
  error?: string;
  transactions?: string[];
}

interface WalletBackup {
  address: string;
  privateKey: string;
  index: number;
  createdAt: string;
}

export class SecurePumpBundler {
  private connection: Connection;
  private config: BundlerConfig;
  private wallets: Keypair[] = [];
  private globalData?: any;
  private walletBackupFile: string;
  private sessionId: string;

  constructor(config: BundlerConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    // Create session ID for this bundler run
    this.sessionId = `bundler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create wallets directory if it doesn't exist
    const walletsDir = path.join(process.cwd(), 'wallets');
    if (!fs.existsSync(walletsDir)) {
      fs.mkdirSync(walletsDir, { recursive: true });
    }
    
    this.walletBackupFile = path.join(walletsDir, `${this.sessionId}.json`);
    
    logger.info(`📡 Connected to ${config.network} via ${config.rpcUrl}`);
    logger.info(`🔐 Session ID: ${this.sessionId}`);
    this.generateWallets();
  }

  private generateWallets(): void {
    logger.info(`🔧 Generating ${this.config.walletCount} wallets...`);
    
    this.wallets = [];
    const walletBackups: WalletBackup[] = [];
    
    for (let i = 0; i < this.config.walletCount; i++) {
      const wallet = Keypair.generate();
      this.wallets.push(wallet);
      
      // Save backup info
      walletBackups.push({
        address: wallet.publicKey.toBase58(),
        privateKey: bs58.encode(wallet.secretKey),
        index: i,
        createdAt: new Date().toISOString(),
      });
    }
    
    // Save wallets to file immediately
    const backupData = {
      sessionId: this.sessionId,
      mainWallet: this.config.mainWallet.publicKey.toBase58(),
      createdAt: new Date().toISOString(),
      network: this.config.network,
      rpcUrl: this.config.rpcUrl,
      walletCount: this.config.walletCount,
      swapAmountSol: this.config.swapAmountSol,
      wallets: walletBackups,
      status: 'generated',
    };
    
    try {
      fs.writeFileSync(this.walletBackupFile, JSON.stringify(backupData, null, 2));
      logger.info(`💾 Wallet backup saved: ${this.walletBackupFile}`);
      logger.info(`✅ Generated ${this.wallets.length} wallets successfully`);
      
      // Log wallet addresses for reference
      walletBackups.forEach((wallet, index) => {
        logger.debug(`   Wallet ${index + 1}: ${wallet.address}`);
      });
      
    } catch (error) {
      logger.error('❌ Failed to save wallet backup:', error);
      throw new Error('Critical: Could not save wallet backup');
    }
  }

  private updateBackupStatus(status: string, additionalData?: any): void {
    try {
      if (fs.existsSync(this.walletBackupFile)) {
        const backupData = JSON.parse(fs.readFileSync(this.walletBackupFile, 'utf8'));
        backupData.status = status;
        backupData.lastUpdated = new Date().toISOString();
        
        if (additionalData) {
          Object.assign(backupData, additionalData);
        }
        
        fs.writeFileSync(this.walletBackupFile, JSON.stringify(backupData, null, 2));
        logger.debug(`📝 Updated backup status: ${status}`);
      }
    } catch (error) {
      logger.warn('⚠️  Failed to update backup status:', error);
    }
  }

  private async loadGlobalData(): Promise<void> {
    const [globalPDA] = getGlobalPDA();
    
    try {
      const accountInfo = await this.connection.getAccountInfo(globalPDA);
      if (!accountInfo) {
        throw new Error('Global account not found');
      }
      
      this.globalData = parseGlobalAccount(accountInfo.data);
      logger.info('✅ Global account data loaded');
      
    } catch (error) {
      throw new Error(`Failed to load global account: ${error}`);
    }
  }

  private async checkAndDistributeSOL(): Promise<void> {
    const mainBalance = await this.connection.getBalance(this.config.mainWallet.publicKey);
    const balanceSOL = mainBalance / LAMPORTS_PER_SOL;
    
    const solPerWallet = this.config.swapAmountSol + 0.005; // Extra for fees
    const totalNeeded = (this.config.walletCount * solPerWallet) + 0.02; // +0.02 for main wallet fees
    
    logger.info(`💰 Main wallet balance: ${balanceSOL.toFixed(6)} SOL`);
    logger.info(`💰 Total needed: ${totalNeeded.toFixed(6)} SOL`);
    
    if (balanceSOL < totalNeeded) {
      throw new Error(`Insufficient balance. Need ${totalNeeded.toFixed(6)} SOL, have ${balanceSOL.toFixed(6)} SOL`);
    }

    // Distribute SOL to wallets
    logger.info('💸 Distributing SOL to wallets...');
    this.updateBackupStatus('distributing_sol');
    
    const tx = new Transaction();
    
    // Add priority fees
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ 
        units: this.config.priorityFee.unitLimit 
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ 
        microLamports: this.config.priorityFee.unitPrice 
      })
    );

    // Add transfers
    for (const wallet of this.wallets) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: this.config.mainWallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: BigInt(Math.floor(solPerWallet * LAMPORTS_PER_SOL)),
        })
      );
    }

    const signature = await this.connection.sendTransaction(tx, [this.config.mainWallet]);
    await this.connection.confirmTransaction(signature, 'confirmed');
    
    logger.info(`✅ SOL distribution completed: ${signature}`);
    this.updateBackupStatus('sol_distributed', { distributionSignature: signature });
  }

  private async uploadMetadata(metadata: TokenMetadata): Promise<string> {
    logger.info('📤 Uploading metadata to IPFS...');
    this.updateBackupStatus('uploading_metadata');
    
    // Read and validate image file
    if (!fs.existsSync(metadata.imagePath)) {
      throw new Error(`Image file not found: ${metadata.imagePath}`);
    }
    
    const imageBuffer = fs.readFileSync(metadata.imagePath);
    const imageBlob = new Blob([imageBuffer]);
    
    const formData = new FormData();
    formData.append('file', imageBlob);
    formData.append('name', metadata.name);
    formData.append('symbol', metadata.symbol);
    formData.append('description', metadata.description);
    formData.append('twitter', metadata.twitter || '');
    formData.append('telegram', metadata.telegram || '');
    formData.append('website', metadata.website || '');
    formData.append('showName', 'true');

    try {
      const response = await fetch('https://pump.fun/api/ipfs', {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Origin': 'https://pump.fun',
          'Referer': 'https://pump.fun/',
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      const result = await response.json();
      if (!result.metadataUri) {
        throw new Error('No metadata URI returned');
      }
      
      logger.info(`✅ Metadata uploaded: ${result.metadataUri}`);
      this.updateBackupStatus('metadata_uploaded', { metadataUri: result.metadataUri });
      return result.metadataUri;
      
    } catch (error) {
      throw new Error(`Metadata upload failed: ${error}`);
    }
  }

  private async createToken(metadata: TokenMetadata, metadataUri: string): Promise<{ mint: Keypair; transaction: VersionedTransaction }> {
    const mint = Keypair.generate();
    
    logger.info(`🪙 Creating token with mint: ${mint.publicKey.toBase58()}`);
    this.updateBackupStatus('creating_token', { mintAddress: mint.publicKey.toBase58() });
    
    // Get required PDAs
    const [global] = getGlobalPDA();
    const [mintAuthority] = require('./instructions').getMintAuthorityPDA();
    const [bondingCurve] = getBondingCurvePDA(mint.publicKey);
    const [metadataPDA] = getMetadataPDA(mint.publicKey);
    
    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint.publicKey,
      bondingCurve,
      true
    );

    const createParams: CreateTokenParams = {
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadataUri,
    };

    const createIx = createTokenInstruction(createParams, {
      mint: mint.publicKey,
      mintAuthority,
      bondingCurve,
      associatedBondingCurve,
      global,
      metadata: metadataPDA,
      user: this.config.mainWallet.publicKey,
    });

    // Build transaction
    const tx = new Transaction();
    
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ 
        units: this.config.priorityFee.unitLimit 
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ 
        microLamports: this.config.priorityFee.unitPrice 
      })
    );
    
    tx.add(createIx);

    // Create versioned transaction
    const { blockhash } = await this.connection.getLatestBlockhash();
    const versionedTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.config.mainWallet.publicKey,
        recentBlockhash: blockhash,
        instructions: tx.instructions,
      }).compileToV0Message()
    );
    
    versionedTx.sign([this.config.mainWallet, mint]);
    
    return { mint, transaction: versionedTx };
  }

  private async createBuyTransactions(mint: PublicKey): Promise<VersionedTransaction[]> {
    logger.info(`🔨 Building buy transactions for ${this.wallets.length} wallets...`);
    this.updateBackupStatus('building_buy_transactions');
    
    const buyTxs: VersionedTransaction[] = [];
    const { blockhash } = await this.connection.getLatestBlockhash();
    
    for (let i = 0; i < this.wallets.length; i++) {
      const wallet = this.wallets[i];
      
      // Calculate buy amount with optional randomization
      let buyAmountSOL = this.config.swapAmountSol;
      if (this.config.randomizeBuyAmounts) {
        const variance = 0.1 + (Math.random() * 0.2); // 10-30% variance
        buyAmountSOL *= (0.9 + variance);
      }

      const solAmount = new BN(Math.floor(buyAmountSOL * LAMPORTS_PER_SOL));
      const maxSolCost = solAmount.muln(1 + this.config.slippageBasisPoints / 10000);
      
      // Simplified token amount calculation - in production you'd query the bonding curve
      const tokenAmount = solAmount.muln(1000000); // This needs proper calculation

      // Get required accounts
      const [global] = getGlobalPDA();
      const [bondingCurve] = getBondingCurvePDA(mint);
      
      const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);
      const associatedUser = await getAssociatedTokenAddress(mint, wallet.publicKey, false);

      const tx = new Transaction();
      
      // Add priority fees
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ 
          units: this.config.priorityFee.unitLimit 
        }),
        ComputeBudgetProgram.setComputeUnitPrice({ 
          microLamports: this.config.priorityFee.unitPrice 
        })
      );

      // Create ATA if needed
      try {
        await getAccount(this.connection, associatedUser);
      } catch {
        tx.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            associatedUser,
            wallet.publicKey,
            mint
          )
        );
      }

      const buyParams: BuyTokenParams = {
        amount: tokenAmount,
        maxSolCost: maxSolCost,
      };

      const buyIx = buyTokenInstruction(buyParams, {
        global,
        feeRecipient: this.globalData?.feeRecipient || global,
        mint,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        user: wallet.publicKey,
      });

      tx.add(buyIx);

      // Create versioned transaction
      const versionedTx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: blockhash,
          instructions: tx.instructions,
        }).compileToV0Message()
      );
      
      versionedTx.sign([wallet]);
      buyTxs.push(versionedTx);
      
      logger.debug(`   Wallet ${i + 1}: ${buyAmountSOL.toFixed(6)} SOL`);
    }
    
    return buyTxs;
  }

  /**
 * Simulates transactions before sending them to catch issues early
 */
private async simulateTransactions(transactions: VersionedTransaction[]): Promise<{ success: boolean; errors: string[] }> {
  logger.info('🧪 Simulating transactions before bundle submission...');
  
  const errors: string[] = [];
  
  for (let i = 0; i < transactions.length; i++) {
    try {
      logger.debug(`   Simulating transaction ${i + 1}/${transactions.length}...`);
      
      const simulation = await this.connection.simulateTransaction(transactions[i], {
        sigVerify: false, // Skip signature verification for simulation
        commitment: 'processed',
      });
      
      if (simulation.value.err) {
        const errorMsg = `Transaction ${i + 1} simulation failed: ${JSON.stringify(simulation.value.err)}`;
        errors.push(errorMsg);
        logger.error(`❌ ${errorMsg}`);
        
        // Log more details about the failed transaction
        if (simulation.value.logs) {
          logger.error(`   Logs:`, simulation.value.logs);
        }
      } else {
        logger.debug(`   ✅ Transaction ${i + 1} simulation successful`);
        logger.debug(`      Compute units used: ${simulation.value.unitsConsumed}`);
        
        if (simulation.value.logs && simulation.value.logs.length > 0) {
          logger.debug(`      Last log: ${simulation.value.logs[simulation.value.logs.length - 1]}`);
        }
      }
      
    } catch (error) {
      const errorMsg = `Transaction ${i + 1} simulation error: ${error}`;
      errors.push(errorMsg);
      logger.error(`❌ ${errorMsg}`);
    }
  }
  
  if (errors.length === 0) {
    logger.info('✅ All transaction simulations passed!');
  } else {
    logger.error(`❌ ${errors.length}/${transactions.length} transaction simulations failed`);
  }
  
  return {
    success: errors.length === 0,
    errors,
  };
}

async testInstructions(): Promise<{ success: boolean; errors: string[] }> {
  logger.info('🧪 TESTING MODE: Validating instructions without spending SOL...');
  
  const errors: string[] = [];
  
  try {
    // Test 1: Global account access
    logger.info('   Testing global account access...');
    await this.loadGlobalData();
    logger.info('   ✅ Global account accessible');
    
    // Test 2: Instruction building (without signatures)
    logger.info('   Testing instruction creation...');
    const testMint = Keypair.generate();
    
    const [global] = getGlobalPDA();
    const [mintAuthority] = require('./instructions').getMintAuthorityPDA();
    const [bondingCurve] = getBondingCurvePDA(testMint.publicKey);
    const [metadataPDA] = getMetadataPDA(testMint.publicKey);
    
    // Test create instruction
    const createParams: CreateTokenParams = {
      name: 'TEST',
      symbol: 'TST',
      uri: 'https://test.com/metadata.json',
    };
    
    const associatedBondingCurve = await getAssociatedTokenAddress(
      testMint.publicKey,
      bondingCurve,
      true
    );
    
    const createIx = createTokenInstruction(createParams, {
      mint: testMint.publicKey,
      mintAuthority,
      bondingCurve,
      associatedBondingCurve,
      global,
      metadata: metadataPDA,
      user: this.config.mainWallet.publicKey,
    });
    
    logger.info('   ✅ Create instruction built successfully');
    
    // Test buy instruction
    const buyParams: BuyTokenParams = {
      amount: new BN(1000),
      maxSolCost: new BN(100000),
    };
    
    const testWallet = Keypair.generate();
    const associatedUser = await getAssociatedTokenAddress(testMint.publicKey, testWallet.publicKey, false);
    
    const buyIx = buyTokenInstruction(buyParams, {
      global,
      feeRecipient: this.globalData?.feeRecipient || global,
      mint: testMint.publicKey,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      user: testWallet.publicKey,
    });
    
    logger.info('   ✅ Buy instruction built successfully');
    
    // Test transaction building
    logger.info('   Testing transaction construction...');
    
    const testTx = new Transaction();
    testTx.add(createIx);
    
    const { blockhash } = await this.connection.getLatestBlockhash();
    const versionedTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.config.mainWallet.publicKey,
        recentBlockhash: blockhash,
        instructions: testTx.instructions,
      }).compileToV0Message()
    );
    
    logger.info('   ✅ Transaction construction successful');
    
    // Test transaction size validation
    const serialized = versionedTx.serialize();
    if (serialized.length > 1232) {
      errors.push(`Transaction too large: ${serialized.length} bytes (max 1232)`);
    } else {
      logger.info(`   ✅ Transaction size OK: ${serialized.length} bytes`);
    }
    
    logger.info('🎉 All instruction tests passed!');
    
  } catch (error) {
    const errorMsg = `Instruction test failed: ${error}`;
    errors.push(errorMsg);
    logger.error(`❌ ${errorMsg}`);
  }
  
  return {
    success: errors.length === 0,
    errors,
  };
}

  async cleanup(): Promise<void> {
    logger.info('🧹 Starting automatic wallet cleanup...');
    this.updateBackupStatus('cleaning_up');
    
    let totalRecovered = 0;
    let successCount = 0;
    
    const cleanupPromises = this.wallets.map(async (wallet, index) => {
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        logger.debug(`   Wallet ${index + 1}: ${balanceSOL.toFixed(6)} SOL`);
        
        if (balance > 5000) { // Keep some for rent exemption
          const recoverAmount = balance - 5000;
          
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: this.config.mainWallet.publicKey,
              lamports: BigInt(recoverAmount),
            })
          );
          
          const signature = await this.connection.sendTransaction(tx, [wallet], {
            skipPreflight: false,
            maxRetries: 3,
          });
          
          await this.connection.confirmTransaction(signature, 'confirmed');
          
          totalRecovered += recoverAmount;
          successCount++;
          
          logger.debug(`   ✅ Recovered ${(recoverAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL from wallet ${index + 1}`);
          return { success: true, amount: recoverAmount, signature };
        }
        
        return { success: true, amount: 0, signature: null };
      } catch (error) {
        logger.warn(`   ⚠️  Failed to cleanup wallet ${index + 1}: ${error}`);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    
    const results = await Promise.allSettled(cleanupPromises);
    
    logger.info(`✅ Cleanup completed: ${successCount}/${this.wallets.length} wallets processed`);
    logger.info(`💰 Total recovered: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    
    // Update backup with cleanup results
    this.updateBackupStatus('cleaned_up', {
      cleanupResults: {
        walletsProcessed: this.wallets.length,
        successfulCleanups: successCount,
        totalRecoveredLamports: totalRecovered,
        totalRecoveredSOL: totalRecovered / LAMPORTS_PER_SOL,
        cleanupTimestamp: new Date().toISOString(),
      }
    });
    
    // Archive the backup file
    try {
      const archiveDir = path.join(process.cwd(), 'wallets', 'archive');
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }
      
      const archivePath = path.join(archiveDir, `${this.sessionId}_cleaned.json`);
      fs.renameSync(this.walletBackupFile, archivePath);
      logger.info(`📦 Backup archived: ${archivePath}`);
    } catch (error) {
      logger.warn('⚠️  Failed to archive backup:', error);
    }
  }

  async createAndBundle(metadata: TokenMetadata, testMode: boolean = false): Promise<BundleResult> {
    // Check for test mode first
    if (testMode) {
      logger.info('🧪 RUNNING IN TEST MODE - No SOL will be spent');
      
      const testResult = await this.testInstructions();
      
      if (testResult.success) {
        logger.info('✅ TEST MODE: All instructions valid - ready for real run!');
        return {
          success: true,
          mint: 'TEST_MODE_NO_MINT',
          signature: 'TEST_MODE_NO_SIGNATURE',
        };
      } else {
        logger.error('❌ TEST MODE: Instruction validation failed');
        return {
          success: false,
          error: `Test failed: ${testResult.errors.join('; ')}`,
        };
      }
    }
  
    try {
      logger.info('🚀 Starting token creation and bundling...');
      this.updateBackupStatus('starting_bundle');
      
      // Step 1: Load global data
      await this.loadGlobalData();
      
      // Step 2: Distribute SOL
      await this.checkAndDistributeSOL();
      
      // Step 3: Upload metadata
      const metadataUri = await this.uploadMetadata(metadata);
      
      // Step 4: Create token
      const { mint, transaction: createTx } = await this.createToken(metadata, metadataUri);
      
      // Step 5: Create buy transactions
      const buyTxs = await this.createBuyTransactions(mint.publicKey);
      
      // Step 6: Simulate transactions before sending
      const allTxs = [createTx, ...buyTxs];
      logger.info(`📦 Preparing bundle with ${allTxs.length} transactions...`);
  
      // NEW: Simulate before sending
      const simulationResult = await this.simulateTransactions(allTxs);
      if (!simulationResult.success) {
        this.updateBackupStatus('simulation_failed', { 
          errors: simulationResult.errors 
        });
        
        // Still try cleanup even if simulation fails
        await this.cleanup();
        
        return {
          success: false,
          error: `Transaction simulation failed: ${simulationResult.errors.join('; ')}`,
        };
      }
  
      logger.info(`📦 All simulations passed! Sending bundle via Jito...`);
      this.updateBackupStatus('submitting_bundle', { transactionCount: allTxs.length });
      
      const result = await sendJitoBundle(allTxs, this.config.mainWallet, this.config);
      
      if (result.success) {
        logger.info('🎉 Bundle successful!');
        this.updateBackupStatus('bundle_successful', { 
          signature: result.signature,
          mintAddress: mint.publicKey.toBase58()
        });
        
        // Clean up wallets after success
        await this.cleanup();
        
        return {
          success: true,
          mint: mint.publicKey.toBase58(),
          signature: result.signature,
          transactions: allTxs.map(tx => tx.signatures[0].toString()),
        };
      } else {
        logger.error('❌ Bundle failed via Jito');
        this.updateBackupStatus('bundle_failed', { 
          error: result.error,
          mintAddress: mint.publicKey.toBase58()
        });
        
        // Clean up wallets after failure
        await this.cleanup();
        
        return {
          success: false,
          error: result.error || 'Bundle failed',
        };
      }
      
    } catch (error) {
      logger.error('💥 Bundle creation failed:', error);
      this.updateBackupStatus('error', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Always cleanup on error
      try {
        await this.cleanup();
      } catch (cleanupError) {
        logger.warn('⚠️  Cleanup failed:', cleanupError);
        this.updateBackupStatus('cleanup_failed', { 
          cleanupError: cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup error'
        });
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Utility methods
  getWalletInfo() {
    return {
      mainWallet: this.config.mainWallet.publicKey.toBase58(),
      walletCount: this.wallets.length,
      walletAddresses: this.wallets.map(w => w.publicKey.toBase58()),
      sessionId: this.sessionId,
      backupFile: this.walletBackupFile,
    };
  }

  async getWalletBalances(): Promise<{ address: string; balance: number }[]> {
    const balances = await Promise.all(
      this.wallets.map(async (wallet) => {
        const balance = await this.connection.getBalance(wallet.publicKey);
        return {
          address: wallet.publicKey.toBase58(),
          balance: balance / LAMPORTS_PER_SOL,
        };
      })
    );
    return balances;
  }
}
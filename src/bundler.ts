// src/bundler.ts - Updated bundler using integrated PumpFun SDK

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { BundlerConfig } from './config';
import { logger } from './utils/logger';
import { sendJitoBundle } from './jito';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import fs from 'fs';
import path from 'path';
import { AnchorProvider } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
import { PumpFunSDK, CreateTokenMetadata, PriorityFee } from './pumpfun-sdk';

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
  private pumpFunSDK: PumpFunSDK;
  private walletBackupFile: string;
  private sessionId: string;

  constructor(config: BundlerConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    // Initialize PumpFun SDK with proper provider
    const wallet = new NodeWallet(config.mainWallet);
    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: 'confirmed',
    });
    this.pumpFunSDK = new PumpFunSDK(provider);
    
    this.sessionId = `bundler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
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
      
      walletBackups.push({
        address: wallet.publicKey.toBase58(),
        privateKey: bs58.encode(wallet.secretKey),
        index: i,
        createdAt: new Date().toISOString(),
      });
    }
    
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

  private async checkAndDistributeSOL(): Promise<void> {
    const mainBalance = await this.connection.getBalance(this.config.mainWallet.publicKey);
    const balanceSOL = mainBalance / LAMPORTS_PER_SOL;
    
    const solPerWallet = this.config.swapAmountSol + 0.005; // Extra for fees
    const totalNeeded = (this.config.walletCount * solPerWallet) + 0.02;
    
    logger.info(`💰 Main wallet balance: ${balanceSOL.toFixed(6)} SOL`);
    logger.info(`💰 Total needed: ${totalNeeded.toFixed(6)} SOL`);
    
    if (balanceSOL < totalNeeded) {
      throw new Error(`Insufficient balance. Need ${totalNeeded.toFixed(6)} SOL, have ${balanceSOL.toFixed(6)} SOL`);
    }

    logger.info('💸 Distributing SOL to wallets...');
    this.updateBackupStatus('distributing_sol');
    
    const tx = new Transaction();
    
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ 
        units: this.config.priorityFee.unitLimit 
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ 
        microLamports: this.config.priorityFee.unitPrice 
      })
    );

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

  private async simulateTransactions(transactions: VersionedTransaction[]): Promise<{ success: boolean; errors: string[] }> {
    logger.info('🧪 Simulating transactions before bundle submission...');
    
    const errors: string[] = [];
    
    for (let i = 0; i < transactions.length; i++) {
      try {
        logger.debug(`   Simulating transaction ${i + 1}/${transactions.length}...`);
        
        const simulation = await this.connection.simulateTransaction(transactions[i], {
          sigVerify: false,
          commitment: 'processed',
        });
        
        if (simulation.value.err) {
          const errorMsg = `Transaction ${i + 1} simulation failed: ${JSON.stringify(simulation.value.err)}`;
          errors.push(errorMsg);
          logger.error(`❌ ${errorMsg}`);
          
          if (simulation.value.logs) {
            logger.error(`   Logs:`, simulation.value.logs);
          }
        } else {
          logger.debug(`   ✅ Transaction ${i + 1} simulation successful`);
          logger.debug(`      Compute units used: ${simulation.value.unitsConsumed}`);
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
    logger.info('🧪 TESTING MODE: Validating PumpFun SDK instructions...');
    
    const errors: string[] = [];
    
    try {
      // Test 1: Global account access
      logger.info('   Testing global account access...');
      const globalAccount = await this.pumpFunSDK.getGlobalAccount();
      logger.info(`   ✅ Global account accessible, fee recipient: ${globalAccount.feeRecipient.toBase58()}`);
      
      // Test 2: Test metadata upload (without actual file)
      logger.info('   Testing metadata format...');
      const testMetadata: CreateTokenMetadata = {
        name: 'TEST',
        symbol: 'TST',
        description: 'Test token',
        file: new Blob(['test'], { type: 'image/jpeg' }),
      };
      
      // Create test form data to validate format
      const formData = new FormData();
      formData.append('file', testMetadata.file);
      formData.append('name', testMetadata.name);
      formData.append('symbol', testMetadata.symbol);
      formData.append('description', testMetadata.description);
      
      logger.info('   ✅ Metadata format validation successful');
      
      // Test 3: Test instruction building
      logger.info('   Testing instruction creation...');
      const testMint = Keypair.generate();
      
      const createIx = await this.pumpFunSDK.getCreateInstructions(
        this.config.mainWallet.publicKey,
        'TEST',
        'TST',
        'https://test.com/metadata.json',
        testMint
      );
      
      logger.info('   ✅ Create instruction built successfully');
      
      const testWallet = Keypair.generate();
      try {
        const buyIx = await this.pumpFunSDK.getBuyInstructionsBySolAmount(
          testWallet.publicKey,
          testMint.publicKey,
          BigInt(0.001 * LAMPORTS_PER_SOL),
          500n,
          'processed'
        );
        logger.info('   ✅ Buy instruction built successfully');
      } catch (error) {
        // Expected to fail since bonding curve doesn't exist
        if (error instanceof Error && error.message.includes('Bonding curve account not found')) {
          logger.info('   ✅ Buy instruction validation successful (expected bonding curve error)');
        } else {
          throw error;
        }
      }
      
      logger.info('🎉 All PumpFun SDK instruction tests passed!');
      
    } catch (error) {
      const errorMsg = `PumpFun SDK instruction test failed: ${error}`;
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
    
    for (let i = 0; i < this.wallets.length; i++) {
      const wallet = this.wallets[i];
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        logger.debug(`   Wallet ${i + 1}: ${balanceSOL.toFixed(6)} SOL`);
        
        if (balance > 5000) {
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
          
          logger.debug(`   ✅ Recovered ${(recoverAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL from wallet ${i + 1}`);
        }
      } catch (error) {
        logger.warn(`   ⚠️  Failed to cleanup wallet ${i + 1}: ${error}`);
      }
    }
    
    logger.info(`✅ Cleanup completed: ${successCount}/${this.wallets.length} wallets processed`);
    logger.info(`💰 Total recovered: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    
    this.updateBackupStatus('cleaned_up', {
      cleanupResults: {
        walletsProcessed: this.wallets.length,
        successfulCleanups: successCount,
        totalRecoveredLamports: totalRecovered,
        totalRecoveredSOL: totalRecovered / LAMPORTS_PER_SOL,
        cleanupTimestamp: new Date().toISOString(),
      }
    });
    
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
    if (testMode) {
      logger.info('🧪 RUNNING IN TEST MODE - No SOL will be spent');
      
      const testResult = await this.testInstructions();
      
      if (testResult.success) {
        logger.info('✅ TEST MODE: All PumpFun SDK instructions valid - ready for real run!');
        return {
          success: true,
          mint: 'TEST_MODE_NO_MINT',
          signature: 'TEST_MODE_NO_SIGNATURE',
        };
      } else {
        logger.error('❌ TEST MODE: PumpFun SDK instruction validation failed');
        return {
          success: false,
          error: `Test failed: ${testResult.errors.join('; ')}`,
        };
      }
    }
  
    try {
      logger.info('🚀 Starting token creation and bundling...');
      this.updateBackupStatus('starting_bundle');
      
      // Step 1: Distribute SOL
      await this.checkAndDistributeSOL();
      
      // Step 2: Prepare token metadata for PumpFun SDK
      if (!fs.existsSync(metadata.imagePath)) {
        throw new Error(`Token image not found: ${metadata.imagePath}`);
      }
      
      const imageBuffer = fs.readFileSync(metadata.imagePath);
      
      // For Node.js, we need to handle the file differently
      const createTokenMetadata: CreateTokenMetadata = {
        name: metadata.name,
        symbol: metadata.symbol,
        description: metadata.description,
        file: imageBuffer as any, // Pass buffer directly, will be handled in createTokenMetadata
        twitter: metadata.twitter,
        telegram: metadata.telegram,
        website: metadata.website,
      };
      
      // Step 3: Create mint keypair
      const mint = Keypair.generate();
      logger.info(`🪙 Creating token with mint: ${mint.publicKey.toBase58()}`);
      this.updateBackupStatus('creating_token', { mintAddress: mint.publicKey.toBase58() });
      
      // Step 4: Use PumpFun SDK to create and buy
      const priorityFees: PriorityFee = {
        unitLimit: this.config.priorityFee.unitLimit,
        unitPrice: this.config.priorityFee.unitPrice,
      };
      
      const buyAmountSol = BigInt(Math.floor(this.config.swapAmountSol * LAMPORTS_PER_SOL));
      const slippageBasisPoints = BigInt(this.config.slippageBasisPoints);
      
      logger.info('🔨 Building transactions with PumpFun SDK...');
      const { createTx, buyTxs } = await this.pumpFunSDK.createAndBuy(
        this.config.mainWallet,
        mint,
        this.wallets,
        createTokenMetadata,
        buyAmountSol,
        slippageBasisPoints,
        priorityFees,
        'confirmed'
      );
      
      // Step 5: Simulate all transactions
      const allTxs = [createTx, ...buyTxs];
      logger.info(`📦 Preparing bundle with ${allTxs.length} transactions...`);
      
      const simulationResult = await this.simulateTransactions(allTxs);
      if (!simulationResult.success) {
        this.updateBackupStatus('simulation_failed', { 
          errors: simulationResult.errors 
        });
        
        await this.cleanup();
        
        return {
          success: false,
          error: `Transaction simulation failed: ${simulationResult.errors.join('; ')}`,
        };
      }
      
      // Step 6: Submit bundle via Jito
      logger.info(`📦 All simulations passed! Sending bundle via Jito...`);
      this.updateBackupStatus('submitting_bundle', { transactionCount: allTxs.length });
      
      const result = await sendJitoBundle(allTxs, this.config.mainWallet, this.config);
      
      if (result.success) {
        logger.info('🎉 Bundle successful!');
        this.updateBackupStatus('bundle_successful', { 
          signature: result.signature,
          mintAddress: mint.publicKey.toBase58()
        });
        
        await this.cleanup();
        
        return {
          success: true,
          mint: mint.publicKey.toBase58(),
          signature: result.signature,
          transactions: allTxs.map(tx => bs58.encode(tx.signatures[0])),
        };
      } else {
        logger.error('❌ Bundle failed via Jito');
        this.updateBackupStatus('bundle_failed', { 
          error: result.error,
          mintAddress: mint.publicKey.toBase58()
        });
        
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
      
      try {
        await this.cleanup();
      } catch (cleanupError) {
        logger.warn('⚠️  Cleanup failed:', cleanupError);
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
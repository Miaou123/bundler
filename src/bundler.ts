// src/bundler.ts - Updated to use the working PumpFun SDK

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { BundlerConfig } from './config';
import { logger } from './utils/logger';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import fs from 'fs';
import path from 'path';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';

// Import the WORKING PumpFun SDK
import { PumpFunSDK, DEFAULT_DECIMALS } from './sdk/index';
import { CreateTokenMetadata, PriorityFee } from './sdk/types';

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
}

export class SecurePumpBundler {
  private connection: Connection;
  private config: BundlerConfig;
  private wallets: Keypair[] = [];
  private pumpFunSDK: PumpFunSDK;
  private sessionId: string;

  constructor(config: BundlerConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    // Initialize the WORKING PumpFun SDK (exactly like in the examples)
    const wallet = new Wallet(config.mainWallet);
    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: 'finalized',
    });
    this.pumpFunSDK = new PumpFunSDK(provider);
    
    this.sessionId = `bundler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.info(`📡 Connected to ${config.network} via ${config.rpcUrl}`);
    logger.info(`🔐 Session ID: ${this.sessionId}`);
    this.generateWallets();
  }

  private generateWallets(): void {
    logger.info(`🔧 Generating ${this.config.walletCount} wallets...`);
    
    this.wallets = [];
    for (let i = 0; i < this.config.walletCount; i++) {
      const wallet = Keypair.generate();
      this.wallets.push(wallet);
    }
    
    logger.info(`✅ Generated ${this.wallets.length} wallets successfully`);
  }

  private async distributeSOL(): Promise<void> {
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
  }

  async createAndBundle(metadata: TokenMetadata, testMode: boolean = false): Promise<BundleResult> {
    if (testMode) {
      logger.info('🧪 TEST MODE - Validating working SDK...');
      
      try {
        // Test global account access (using the working SDK)
        const globalAccount = await this.pumpFunSDK.getGlobalAccount();
        logger.info(`✅ Working SDK validated successfully!`);
        logger.info(`   Fee recipient: ${globalAccount.feeRecipient.toBase58()}`);
        logger.info(`   Authority: ${globalAccount.authority.toBase58()}`);
        logger.info(`   Fee basis points: ${globalAccount.feeBasisPoints}`);
        logger.info(`   Token total supply: ${globalAccount.tokenTotalSupply}`);
        
        return {
          success: true,
          mint: 'TEST_MODE_NO_MINT',
          signature: 'TEST_MODE_NO_SIGNATURE',
        };
      } catch (error) {
        return {
          success: false,
          error: `Working SDK test failed: ${error}`,
        };
      }
    }

    try {
      logger.info('🚀 Starting token creation and buying with working SDK...');
      
      // Step 1: Distribute SOL to wallets
      await this.distributeSOL();
      
      // Step 2: Prepare token metadata (exactly like in the working examples)
      if (!fs.existsSync(metadata.imagePath)) {
        throw new Error(`Token image not found: ${metadata.imagePath}`);
      }
      
      // Read the file and create a proper Blob (like in the working example)
      const imageData = fs.readFileSync(metadata.imagePath);
      const imageBlob = new Blob([imageData], { type: 'image/png' });
      
      const createTokenMetadata: CreateTokenMetadata = {
        name: metadata.name,
        symbol: metadata.symbol,
        description: metadata.description,
        file: imageBlob,
        twitter: metadata.twitter,
        telegram: metadata.telegram,
        website: metadata.website,
      };
      
      // Step 3: Create mint keypair (like in the working example)
      const mint = Keypair.generate();
      logger.info(`🪙 Creating token with mint: ${mint.publicKey.toBase58()}`);
      
      // Step 4: Create token with initial buy (EXACTLY like the working example)
      const buyAmountSol = BigInt(Math.floor(this.config.swapAmountSol * LAMPORTS_PER_SOL));
      const slippageBasisPoints = BigInt(this.config.slippageBasisPoints);
      
      logger.info('🔨 Creating token with initial buy using working SDK...');
      
      const priorityFees: PriorityFee = {
        unitLimit: this.config.priorityFee.unitLimit,
        unitPrice: this.config.priorityFee.unitPrice,
      };
      
      const createResult = await this.pumpFunSDK.createAndBuy(
        this.config.mainWallet,  // creator
        mint,                    // mint
        createTokenMetadata,     // metadata
        buyAmountSol,           // buyAmountSol
        slippageBasisPoints,    // slippageBasisPoints
        priorityFees,           // priorityFees
        'confirmed',            // commitment
        'confirmed'             // finality
      );
      
      if (!createResult.success) {
        throw new Error(`Token creation failed: ${createResult.error}`);
      }
      
      logger.info(`✅ Token created successfully with working SDK!`);
      logger.info(`   Signature: ${createResult.signature}`);
      logger.info(`   Mint: ${mint.publicKey.toBase58()}`);
      logger.info(`   View on Pump.fun: https://pump.fun/${mint.publicKey.toBase58()}`);
      
      // Step 5: Execute additional buys from other wallets
      logger.info(`🛒 Executing ${this.wallets.length} additional buy transactions...`);
      
      let successfulBuys = 0;
      for (let i = 0; i < this.wallets.length; i++) {
        const wallet = this.wallets[i];
        
        try {
          // Add randomization to buy amounts (±20%)
          const variance = 0.8 + (Math.random() * 0.4); // 0.8 to 1.2
          const buyAmountSolWithRandom = BigInt(Math.floor(Number(buyAmountSol) * variance));
          
          logger.info(`   Buy ${i + 1}/${this.wallets.length}: ${(Number(buyAmountSolWithRandom) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
          
          // Use the working SDK buy method
          const buyResult = await this.pumpFunSDK.buy(
            wallet,                  // buyer
            mint.publicKey,         // mint
            buyAmountSolWithRandom, // buyAmountSol
            slippageBasisPoints,    // slippageBasisPoints
            priorityFees,           // priorityFees
            'confirmed',            // commitment
            'confirmed'             // finality
          );
          
          if (buyResult.success) {
            logger.info(`   ✅ Buy ${i + 1} successful: ${buyResult.signature}`);
            successfulBuys++;
          } else {
            logger.warn(`   ⚠️  Buy ${i + 1} failed: ${buyResult.error}`);
          }
          
          // Small delay between transactions
          if (i < this.wallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          
        } catch (error) {
          logger.warn(`   ❌ Buy ${i + 1} error: ${error}`);
        }
      }
      
      logger.info(`🎉 Operation completed with working SDK!`);
      logger.info(`   Token created: ✅`);
      logger.info(`   Additional buys: ${successfulBuys}/${this.wallets.length} successful`);
      
      // Step 6: Cleanup
      await this.cleanup();
      
      return {
        success: true,
        mint: mint.publicKey.toBase58(),
        signature: createResult.signature,
      };
      
    } catch (error) {
      logger.error('💥 Operation failed:', error);
      
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

  private async cleanup(): Promise<void> {
    logger.info('🧹 Cleaning up wallets...');
    
    let totalRecovered = 0;
    let successCount = 0;
    
    for (let i = 0; i < this.wallets.length; i++) {
      const wallet = this.wallets[i];
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        
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
        }
      } catch (error) {
        logger.warn(`   ⚠️  Failed to cleanup wallet ${i + 1}: ${error}`);
      }
    }
    
    logger.info(`✅ Cleanup completed: ${successCount}/${this.wallets.length} wallets processed`);
    logger.info(`💰 Total recovered: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }

  getWalletInfo() {
    return {
      mainWallet: this.config.mainWallet.publicKey.toBase58(),
      walletCount: this.wallets.length,
      sessionId: this.sessionId,
    };
  }
}
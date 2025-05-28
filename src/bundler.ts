// src/bundler.ts - Enhanced with SOL retention for future transactions

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
import { BundledBuy } from './pumpfun';

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
  // NEW: Return wallet info for future use
  bundledWallets?: {
    publicKey: string;
    privateKey: string;
    remainingSOL: number;
  }[];
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
    
    // Initialize the PumpFun SDK with the CREATOR wallet (for token creation)
    const creatorWallet = new Wallet(config.creatorWallet);
    const provider = new AnchorProvider(this.connection, creatorWallet, {
      commitment: 'finalized',
    });
    this.pumpFunSDK = new PumpFunSDK(provider);
    
    this.sessionId = `bundler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.info(`📡 Connected to ${config.network} via ${config.rpcUrl}`);
    logger.info(`🔐 Session ID: ${this.sessionId}`);
    logger.info(`🎨 Creator wallet: ${config.creatorWallet.publicKey.toBase58()}`);
    logger.info(`💰 Distributor wallet: ${config.distributorWallet.publicKey.toBase58()}`);
    
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

  private async checkWalletBalances(): Promise<void> {
    logger.info('💰 Checking wallet balances...');
    
    // Check creator wallet balance
    const creatorBalance = await this.connection.getBalance(this.config.creatorWallet.publicKey);
    const creatorBalanceSOL = creatorBalance / LAMPORTS_PER_SOL;
    logger.info(`   🎨 Creator wallet: ${creatorBalanceSOL.toFixed(6)} SOL`);
    
    // Check distributor wallet balance
    const distributorBalance = await this.connection.getBalance(this.config.distributorWallet.publicKey);
    const distributorBalanceSOL = distributorBalance / LAMPORTS_PER_SOL;
    logger.info(`   💰 Distributor wallet: ${distributorBalanceSOL.toFixed(6)} SOL`);
    
    // IMPROVED: More accurate funding calculation
    const buyAmount = this.config.swapAmountSol;
    const retainAmount = parseFloat(process.env.RETAIN_SOL_PER_WALLET || '0.005'); // Keep 0.005 SOL for future txs
    const txFees = 0.002; // Estimated transaction fees
    const solPerWallet = buyAmount + retainAmount + txFees;
    
    const totalDistributorNeeded = (this.config.walletCount * solPerWallet) + 0.01; // Buffer
    const creatorNeeded = buyAmount + 0.05; // For token creation and initial buy
    
    logger.info(`💰 IMPROVED Balance requirements:`);
    logger.info(`   🎨 Creator needs: ${creatorNeeded.toFixed(6)} SOL (creation + initial buy)`);
    logger.info(`   💰 Distributor needs: ${totalDistributorNeeded.toFixed(6)} SOL`);
    logger.info(`     - Buy amount per wallet: ${buyAmount.toFixed(6)} SOL`);
    logger.info(`     - Retain per wallet: ${retainAmount.toFixed(6)} SOL`);
    logger.info(`     - Estimated fees: ${txFees.toFixed(6)} SOL per wallet`);
    
    // Validate balances
    if (creatorBalanceSOL < creatorNeeded) {
      throw new Error(`Creator wallet insufficient balance. Need ${creatorNeeded.toFixed(6)} SOL, have ${creatorBalanceSOL.toFixed(6)} SOL`);
    }
    
    if (distributorBalanceSOL < totalDistributorNeeded) {
      throw new Error(`Distributor wallet insufficient balance. Need ${totalDistributorNeeded.toFixed(6)} SOL, have ${distributorBalanceSOL.toFixed(6)} SOL`);
    }
    
    logger.info('✅ All wallet balances are sufficient');
  }

  private async distributeSOL(): Promise<void> {
    // IMPROVED: More precise funding calculation
    const buyAmount = this.config.swapAmountSol;
    const retainAmount = parseFloat(process.env.RETAIN_SOL_PER_WALLET || '0.005');
    const txFees = 0.002;
    const solPerWallet = buyAmount + retainAmount + txFees;
    
    logger.info('💸 IMPROVED SOL distribution to bundled wallets...');
    logger.info(`   💰 Each wallet will receive: ${solPerWallet.toFixed(6)} SOL`);
    logger.info(`     - For token buy: ${buyAmount.toFixed(6)} SOL`);
    logger.info(`     - For future txs: ${retainAmount.toFixed(6)} SOL`);
    logger.info(`     - For tx fees: ${txFees.toFixed(6)} SOL`);
    
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
          fromPubkey: this.config.distributorWallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: BigInt(Math.floor(solPerWallet * LAMPORTS_PER_SOL)),
        })
      );
    }

    const signature = await this.connection.sendTransaction(tx, [this.config.distributorWallet]);
    await this.connection.confirmTransaction(signature, 'confirmed');
    
    logger.info(`✅ SOL distribution completed: ${signature}`);
    logger.info(`   💰 Distributed ${solPerWallet.toFixed(6)} SOL to each of ${this.wallets.length} wallets`);
  }

  async createAndBundle(metadata: TokenMetadata, testMode: boolean = false): Promise<BundleResult> {
    if (testMode) {
      logger.info('🧪 TEST MODE - Validating working SDK...');
      
      try {
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
      logger.info('🚀 Starting DUAL WALLET bundled token creation and buying...');
      
      // Step 1: Check wallet balances
      await this.checkWalletBalances();
      
      // Step 2: Distribute SOL to bundled wallets FROM DISTRIBUTOR WALLET
      await this.distributeSOL();
      
      // Step 3: Prepare token metadata
      if (!fs.existsSync(metadata.imagePath)) {
        throw new Error(`Token image not found: ${metadata.imagePath}`);
      }
      
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
      
      // Step 4: Create mint keypair
      const mint = Keypair.generate();
      logger.info(`🪙 Creating token with mint: ${mint.publicKey.toBase58()}`);
      
      // Step 5: Prepare bundled buys (these wallets are funded by distributor)
      const buyAmountSol = BigInt(Math.floor(this.config.swapAmountSol * LAMPORTS_PER_SOL));
      const slippageBasisPoints = BigInt(this.config.slippageBasisPoints);
      
      // Create bundled buys for all wallets (funded by distributor)
      const bundledBuys: BundledBuy[] = this.wallets.map((wallet, index) => {
        // Add randomization to buy amounts (±20%)
        const variance = 0.8 + (Math.random() * 0.4); // 0.8 to 1.2
        const randomizedAmount = BigInt(Math.floor(Number(buyAmountSol) * variance));
        
        logger.info(`   Bundled wallet ${index + 1}: ${wallet.publicKey.toBase58().slice(0, 8)}... - ${Number(randomizedAmount) / LAMPORTS_PER_SOL} SOL`);
        
        return {
          wallet,
          solAmount: randomizedAmount,
        };
      });
      
      logger.info('🔨 Creating bundled transaction with DUAL WALLET system...');
      logger.info(`   🎨 Creator wallet handles: Token creation + initial buy`);
      logger.info(`   💰 Distributor wallet funded: ${bundledBuys.length} bundled buy wallets`);
      
      const priorityFees: PriorityFee = {
        unitLimit: this.config.priorityFee.unitLimit,
        unitPrice: this.config.priorityFee.unitPrice,
      };
      
      // Step 6: Execute bundled create and buy WITH DUAL WALLET SETUP
      const createResult = await this.pumpFunSDK.createAndBuyBundled(
        this.config.creatorWallet,    // CREATOR: Creates token and does initial buy
        mint,                         // mint keypair
        createTokenMetadata,          // metadata
        buyAmountSol,                // creator's initial buy amount
        bundledBuys,                 // bundled buys (funded by distributor)
        slippageBasisPoints,         // slippage
        priorityFees,                // priority fees
        'confirmed',                 // commitment
        'confirmed'                  // finality
      );
      
      if (!createResult.success) {
        throw new Error(`Bundled transaction failed: ${createResult.error}`);
      }
      
      logger.info(`✅ DUAL WALLET bundled transaction successful!`);
      logger.info(`   Signature: ${createResult.signature}`);
      logger.info(`   Mint: ${mint.publicKey.toBase58()}`);
      logger.info(`   View on Pump.fun: https://pump.fun/${mint.publicKey.toBase58()}`);
      
      logger.info(`🎉 Operation completed with DUAL WALLET bundled SDK!`);
      logger.info(`   🎨 Creator wallet: Token created + initial buy ✅`);
      logger.info(`   💰 Distributor wallet: Funded ${bundledBuys.length} bundled buys ✅`);
      logger.info(`   📦 Bundled buys: ${bundledBuys.length} wallets ✅`);
      
      // Step 7: IMPROVED cleanup with retention option
      const walletInfo = await this.improvedCleanup();
      
      return {
        success: true,
        mint: mint.publicKey.toBase58(),
        signature: createResult.signature,
        bundledWallets: walletInfo, // NEW: Return wallet info for future use
      };
      
    } catch (error) {
      logger.error('💥 Operation failed:', error);
      
      try {
        await this.improvedCleanup();
      } catch (cleanupError) {
        logger.warn('⚠️  Cleanup failed:', cleanupError);
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // NEW: Improved cleanup with SOL retention option
  private async improvedCleanup(): Promise<{publicKey: string; privateKey: string; remainingSOL: number}[]> {
    const retainAmount = parseFloat(process.env.RETAIN_SOL_PER_WALLET || '0.005');
    const retainLamports = Math.floor(retainAmount * LAMPORTS_PER_SOL);
    
    logger.info('🧹 IMPROVED wallet cleanup with SOL retention...');
    logger.info(`   💰 Retaining ${retainAmount} SOL per wallet for future transactions`);
    
    let totalRecovered = 0;
    let successCount = 0;
    const walletInfo: {publicKey: string; privateKey: string; remainingSOL: number}[] = [];
    
    for (let i = 0; i < this.wallets.length; i++) {
      const wallet = this.wallets[i];
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        // Calculate how much to recover (keep retainAmount + rent exemption)
        const keepAmount = retainLamports + 5000; // 5000 for rent exemption
        
        if (balance > keepAmount) {
          const recoverAmount = balance - keepAmount;
          
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: this.config.distributorWallet.publicKey,
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
          
          const finalBalance = balance - recoverAmount;
          const finalBalanceSOL = finalBalance / LAMPORTS_PER_SOL;
          
          logger.info(`   ✅ Wallet ${i + 1}: Recovered ${(recoverAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL, retained ${finalBalanceSOL.toFixed(6)} SOL`);
          
          // Store wallet info for future use
          walletInfo.push({
            publicKey: wallet.publicKey.toBase58(),
            privateKey: bs58.encode(wallet.secretKey),
            remainingSOL: finalBalanceSOL,
          });
        } else {
          logger.info(`   ⚪ Wallet ${i + 1}: No excess SOL to recover (${balanceSOL.toFixed(6)} SOL)`);
          
          walletInfo.push({
            publicKey: wallet.publicKey.toBase58(),
            privateKey: bs58.encode(wallet.secretKey),
            remainingSOL: balanceSOL,
          });
        }
      } catch (error) {
        logger.warn(`   ⚠️  Failed to cleanup wallet ${i + 1}: ${error}`);
        
        // Still add to wallet info even if cleanup failed
        walletInfo.push({
          publicKey: wallet.publicKey.toBase58(),
          privateKey: bs58.encode(wallet.secretKey),
          remainingSOL: 0, // Unknown balance due to error
        });
      }
    }
    
    logger.info(`✅ IMPROVED cleanup completed: ${successCount}/${this.wallets.length} wallets processed`);
    logger.info(`💰 Total recovered to distributor: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    logger.info(`🎯 Each wallet retained ~${retainAmount} SOL for future transactions`);
    
    // NEW: Save wallet info to file for future use
    if (walletInfo.length > 0) {
      const walletFilePath = path.join(process.cwd(), 'wallets', `${this.sessionId}_bundled_wallets.json`);
      const walletsDir = path.dirname(walletFilePath);
      
      if (!fs.existsSync(walletsDir)) {
        fs.mkdirSync(walletsDir, { recursive: true });
      }
      
      const walletData = {
        sessionId: this.sessionId,
        createdAt: new Date().toISOString(),
        retainedSOLPerWallet: retainAmount,
        wallets: walletInfo,
      };
      
      fs.writeFileSync(walletFilePath, JSON.stringify(walletData, null, 2));
      logger.info(`💾 Wallet info saved to: ${walletFilePath}`);
    }
    
    return walletInfo;
  }

  getWalletInfo() {
    return {
      creatorWallet: this.config.creatorWallet.publicKey.toBase58(),
      distributorWallet: this.config.distributorWallet.publicKey.toBase58(),
      walletCount: this.wallets.length,
      sessionId: this.sessionId,
    };
  }
}
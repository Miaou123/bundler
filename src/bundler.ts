// src/bundler.ts - FIXED: No hardcoded values, all from env

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

// Import the SECURE PumpFun SDK
import { PumpFunSDK } from './pumpfun';
import { CreateTokenMetadata, PriorityFee } from './sdk/types';

// FIXED: No hardcoded values - all from environment
const CREATOR_BUY_AMOUNT_SOL = parseFloat(process.env.CREATOR_BUY_AMOUNT_SOL || '0.05');
const RETAIN_SOL_PER_WALLET = parseFloat(process.env.RETAIN_SOL_PER_WALLET || '0.005');
const WALLET_FUNDING_BUFFER = parseFloat(process.env.WALLET_FUNDING_BUFFER || '0.01');
const CREATOR_FUNDING_BUFFER = parseFloat(process.env.CREATOR_FUNDING_BUFFER || '0.05');
const DISTRIBUTOR_FUNDING_BUFFER = parseFloat(process.env.DISTRIBUTOR_FUNDING_BUFFER || '0.02');
const RENT_EXEMPTION_LAMPORTS = parseInt(process.env.RENT_EXEMPTION_LAMPORTS || '5000');

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
  tipAmount?: number;
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
    
    // Initialize PumpFun SDK with creator wallet
    const creatorWallet = new Wallet(config.creatorWallet);
    const provider = new AnchorProvider(this.connection, creatorWallet, {
      commitment: 'finalized',
    });
    this.pumpFunSDK = new PumpFunSDK(provider);
    
    this.sessionId = `secure_bundler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.info(`🛡️  SECURE Bundler Connected to ${config.network}`);
    logger.info(`🔐 Session ID: ${this.sessionId}`);
    logger.info(`🎨 Creator wallet: ${config.creatorWallet.publicKey.toBase58()}`);
    logger.info(`💰 Distributor wallet: ${config.distributorWallet.publicKey.toBase58()}`);
    
    // FIXED: Show env-based values, not hardcoded
    logger.info(`🎯 Creator buy amount: ${CREATOR_BUY_AMOUNT_SOL} SOL (from env)`);
    logger.info(`💰 Retain per wallet: ${RETAIN_SOL_PER_WALLET} SOL (from env)`);
    logger.info(`🛡️  Security: Jito-only, embedded tips, pre/post checks`);
    
    this.generateWallets();
  }

  private generateWallets(): void {
    logger.info(`🔧 Generating ${this.config.walletCount} wallets...`);
    
    this.wallets = [];
    for (let i = 0; i < this.config.walletCount; i++) {
      const wallet = Keypair.generate();
      this.wallets.push(wallet);
    }
    
    logger.info(`✅ Generated ${this.wallets.length} wallets`);
  }

  private async checkBalances(): Promise<void> {
    logger.info('💰 Checking wallet balances...');
    
    const creatorBalance = await this.connection.getBalance(this.config.creatorWallet.publicKey);
    const creatorBalanceSOL = creatorBalance / LAMPORTS_PER_SOL;
    
    const distributorBalance = await this.connection.getBalance(this.config.distributorWallet.publicKey);
    const distributorBalanceSOL = distributorBalance / LAMPORTS_PER_SOL;
    
    // FIXED: Use env-based values for calculations
    const buyAmount = this.config.swapAmountSol;
    const walletFunding = (buyAmount + WALLET_FUNDING_BUFFER) * this.wallets.length;
    const creatorNeeds = CREATOR_BUY_AMOUNT_SOL + CREATOR_FUNDING_BUFFER;
    const distributorNeeds = walletFunding + DISTRIBUTOR_FUNDING_BUFFER;
    
    logger.info(`💰 Requirements (from env):`);
    logger.info(`   Creator needs: ${creatorNeeds.toFixed(6)} SOL (${CREATOR_BUY_AMOUNT_SOL} buy + ${CREATOR_FUNDING_BUFFER} buffer)`);
    logger.info(`   Distributor needs: ${distributorNeeds.toFixed(6)} SOL (${walletFunding.toFixed(6)} funding + ${DISTRIBUTOR_FUNDING_BUFFER} buffer)`);
    logger.info(`   Per-wallet funding: ${(buyAmount + WALLET_FUNDING_BUFFER).toFixed(6)} SOL (${buyAmount} buy + ${WALLET_FUNDING_BUFFER} buffer)`);
    
    if (creatorBalanceSOL < creatorNeeds) {
      throw new Error(`Creator wallet needs ${creatorNeeds.toFixed(6)} SOL, has ${creatorBalanceSOL.toFixed(6)} SOL`);
    }
    
    if (distributorBalanceSOL < distributorNeeds) {
      throw new Error(`Distributor wallet needs ${distributorNeeds.toFixed(6)} SOL, has ${distributorBalanceSOL.toFixed(6)} SOL`);
    }
    
    logger.info('✅ Sufficient balances confirmed');
  }

  private async fundWallets(): Promise<void> {
    // FIXED: Use env-based value
    const solPerWallet = this.config.swapAmountSol + WALLET_FUNDING_BUFFER;
    
    logger.info(`💸 Funding ${this.wallets.length} wallets with ${solPerWallet.toFixed(6)} SOL each (from env)...`);
    
    const tx = new Transaction();
    
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.priorityFee.unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.priorityFee.unitPrice })
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
    
    logger.info(`✅ Wallet funding completed: ${signature}`);
  }

  private async cleanupWallets(): Promise<{publicKey: string; privateKey: string; remainingSOL: number}[]> {
    // FIXED: Use env-based values
    const retainLamports = Math.floor(RETAIN_SOL_PER_WALLET * LAMPORTS_PER_SOL);
    
    logger.info(`🧹 Cleaning up wallets (retaining ${RETAIN_SOL_PER_WALLET} SOL each from env)...`);
    
    const walletInfo: {publicKey: string; privateKey: string; remainingSOL: number}[] = [];
    let totalRecovered = 0;
    
    for (let i = 0; i < this.wallets.length; i++) {
      const wallet = this.wallets[i];
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        // FIXED: Use env-based values
        const keepAmount = retainLamports + RENT_EXEMPTION_LAMPORTS;
        
        if (balance > keepAmount) {
          const recoverAmount = balance - keepAmount;
          
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: this.config.distributorWallet.publicKey,
              lamports: BigInt(recoverAmount),
            })
          );
          
          const signature = await this.connection.sendTransaction(tx, [wallet]);
          await this.connection.confirmTransaction(signature, 'confirmed');
          
          totalRecovered += recoverAmount;
          const finalBalanceSOL = (balance - recoverAmount) / LAMPORTS_PER_SOL;
          
          logger.info(`   ✅ Wallet ${i + 1}: Recovered ${(recoverAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
          
          walletInfo.push({
            publicKey: wallet.publicKey.toBase58(),
            privateKey: bs58.encode(wallet.secretKey),
            remainingSOL: finalBalanceSOL,
          });
        } else {
          const balanceSOL = balance / LAMPORTS_PER_SOL;
          logger.info(`   ⚪ Wallet ${i + 1}: No excess SOL (${balanceSOL.toFixed(6)} SOL, keeping ${(keepAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
          
          walletInfo.push({
            publicKey: wallet.publicKey.toBase58(),
            privateKey: bs58.encode(wallet.secretKey),
            remainingSOL: balanceSOL,
          });
        }
      } catch (error) {
        logger.warn(`   ⚠️  Failed to cleanup wallet ${i + 1}: ${error}`);
        walletInfo.push({
          publicKey: wallet.publicKey.toBase58(),
          privateKey: bs58.encode(wallet.secretKey),
          remainingSOL: 0,
        });
      }
    }
    
    logger.info(`✅ Cleanup completed: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL recovered`);
    logger.info(`💰 Retained ${RETAIN_SOL_PER_WALLET} SOL per wallet (from RETAIN_SOL_PER_WALLET env var)`);
    
    return walletInfo;
  }

  // MAIN METHOD: Secure bundled token creation
  async createAndBundle(metadata: TokenMetadata, testMode: boolean = false): Promise<BundleResult> {
    if (testMode) {
      logger.info('🧪 TEST MODE - Validating configuration...');
      
      try {
        const globalAccount = await this.pumpFunSDK.getGlobalAccount();
        logger.info(`✅ Configuration valid! Fee recipient: ${globalAccount.feeRecipient.toBase58()}`);
        
        return {
          success: true,
          mint: 'TEST_MODE',
          signature: 'TEST_MODE',
        };
      } catch (error) {
        return {
          success: false,
          error: `Configuration test failed: ${error}`,
        };
      }
    }
  
    try {
      logger.info('🛡️  SECURE: Starting bundled token creation with anti-MEV protections...');
      
      // Step 1: Check balances
      await this.checkBalances();
      
      // Step 2: Fund wallets
      await this.fundWallets();
      
      // Step 3: Prepare metadata
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
      
      // Step 4: Create mint and prepare bundled buys
      const mint = Keypair.generate();
      logger.info(`🪙 Token mint: ${mint.publicKey.toBase58()}`);
      
      const buyAmountSol = BigInt(Math.floor(this.config.swapAmountSol * LAMPORTS_PER_SOL));
      // FIXED: Use env-based value
      const creatorBuyAmountSol = BigInt(Math.floor(CREATOR_BUY_AMOUNT_SOL * LAMPORTS_PER_SOL));
      const slippageBasisPoints = BigInt(this.config.slippageBasisPoints);
      
      // FIXED: Use env-based randomization settings
      const randomizeBuys = process.env.RANDOMIZE_BUY_AMOUNTS === 'true';
      const minVariance = parseFloat(process.env.BUY_AMOUNT_MIN_VARIANCE || '0.8'); // 80%
      const maxVariance = parseFloat(process.env.BUY_AMOUNT_MAX_VARIANCE || '1.2'); // 120%
      
      // Create bundled buys with configurable randomization
      const bundledBuys: BundledBuy[] = this.wallets.map((wallet, index) => {
        let finalAmount = buyAmountSol;
        
        if (randomizeBuys) {
          const variance = minVariance + (Math.random() * (maxVariance - minVariance));
          finalAmount = BigInt(Math.floor(Number(buyAmountSol) * variance));
        }
        
        logger.info(`   Wallet ${index + 1}: ${finalAmount.toString()} lamports (${Number(finalAmount) / LAMPORTS_PER_SOL} SOL)${randomizeBuys ? ' [randomized]' : ''}`);
        
        return {
          wallet,
          solAmount: finalAmount,
        };
      });
      
      const priorityFees: PriorityFee = {
        unitLimit: this.config.priorityFee.unitLimit,
        unitPrice: this.config.priorityFee.unitPrice,
      };
      
      // Step 5: Execute SECURE bundled transaction
      logger.info('🛡️  Executing SECURE bundled transaction with embedded protections...');
      logger.info(`   🎨 Creator: Token creation + ${CREATOR_BUY_AMOUNT_SOL} SOL buy (from env)`);
      logger.info(`   💰 Bundled buys: ${bundledBuys.length} wallets`);
      logger.info(`   💰 Retain per wallet: ${RETAIN_SOL_PER_WALLET} SOL (from env)`);
      logger.info(`   🛡️  Security: Embedded tip + pre/post checks + Jito-only`);
      
      // FIXED: Use env-based priority
      const jitoPriority = (process.env.JITO_PRIORITY as 'low' | 'medium' | 'high' | 'max') || 'high';
      
      const createResult = await this.pumpFunSDK.createAndBuyBundledSecure(
        this.config.creatorWallet,    // Creator wallet
        mint,                         // Mint keypair
        createTokenMetadata,          // Token metadata
        creatorBuyAmountSol,         // Creator buy amount (from env)
        bundledBuys,                 // Bundled buys
        slippageBasisPoints,         // Slippage
        priorityFees,                // Priority fees
        jitoPriority,                // Jito priority (from env)
        'confirmed',                 // Commitment
        'confirmed'                  // Finality
      );
      
      if (!createResult.success) {
        throw new Error(`SECURE bundled transaction failed: ${createResult.error}`);
      }
      
      logger.info(`🛡️  SECURE bundled transaction successful!`);
      logger.info(`   Signature: ${createResult.signature}`);
      logger.info(`   Mint: ${mint.publicKey.toBase58()}`);
      logger.info(`   🛡️  All security protections verified`);
      logger.info(`   View: https://pump.fun/${mint.publicKey.toBase58()}`);
      
      // Step 6: Cleanup wallets
      const walletInfo = await this.cleanupWallets();
      
      // Step 7: Save results
      this.saveResults(walletInfo, mint.publicKey.toBase58(), createResult);
      
      logger.info(`🛡️  SECURE bundling completed successfully!`);
      
      return {
        success: true,
        mint: mint.publicKey.toBase58(),
        signature: createResult.signature,
        bundledWallets: walletInfo,
      };
      
    } catch (error) {
      logger.error('🛡️  SECURE bundling failed:', error);
      
      // Try cleanup on failure
      try {
        await this.cleanupWallets();
      } catch (cleanupError) {
        logger.warn('⚠️  Cleanup failed:', cleanupError);
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private saveResults(walletInfo: any[], mint: string, createResult: any): void {
    const resultsData = {
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      mint,
      signature: createResult.signature,
      network: this.config.network,
      strategy: 'secure-jito-bundling-with-anti-mev',
      totalWallets: walletInfo.length,
      creatorWallet: this.config.creatorWallet.publicKey.toBase58(),
      distributorWallet: this.config.distributorWallet.publicKey.toBase58(),
      // FIXED: Save env-based values used
      configurationUsed: {
        creatorBuyAmount: CREATOR_BUY_AMOUNT_SOL,
        retainSolPerWallet: RETAIN_SOL_PER_WALLET,
        walletFundingBuffer: WALLET_FUNDING_BUFFER,
        creatorFundingBuffer: CREATOR_FUNDING_BUFFER,
        distributorFundingBuffer: DISTRIBUTOR_FUNDING_BUFFER,
        rentExemptionLamports: RENT_EXEMPTION_LAMPORTS,
      },
      securityFeatures: {
        embeddedTip: true,
        prePostChecks: true,
        jitoOnly: true,
        noFallback: true,
      },
      wallets: walletInfo,
      config: {
        walletCount: this.config.walletCount,
        swapAmountSol: this.config.swapAmountSol,
        slippageBasisPoints: this.config.slippageBasisPoints,
      }
    };
    
    const resultsPath = path.join(process.cwd(), 'wallets', `secure_results_${this.sessionId}.json`);
    const walletsDir = path.dirname(resultsPath);
    
    if (!fs.existsSync(walletsDir)) {
      fs.mkdirSync(walletsDir, { recursive: true });
    }
    
    fs.writeFileSync(resultsPath, JSON.stringify(resultsData, null, 2));
    logger.info(`💾 SECURE results saved to: ${resultsPath}`);
  }

  getWalletInfo() {
    return {
      creatorWallet: this.config.creatorWallet.publicKey.toBase58(),
      distributorWallet: this.config.distributorWallet.publicKey.toBase58(),
      walletCount: this.wallets.length,
      sessionId: this.sessionId,
      // FIXED: Return env-based values
      creatorBuyAmount: CREATOR_BUY_AMOUNT_SOL,
      retainSolPerWallet: RETAIN_SOL_PER_WALLET,
      strategy: 'secure-jito-bundling-with-anti-mev',
    };
  }
}
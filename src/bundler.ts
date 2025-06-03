// src/bundler.ts - MODIFIED: Added token distribution functionality

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from '@solana/spl-token';
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

// ENHANCED: Bundle result with distribution info
export interface BundleResult {
  success: boolean;
  mint?: string;
  signature?: string;
  error?: string;
  // Original bundled wallets (4 initial buyers)
  bundledWallets?: {
    publicKey: string;
    privateKey: string;
    remainingSOL: number;
  }[];
  // NEW: Distribution results
  distributionResults?: {
    success: boolean;
    totalDistributedWallets: number;
    distributionSignatures: string[];
    finalWalletCount: number;
  };
  // NEW: All final wallets (original + distributed)
  allFinalWallets?: {
    publicKey: string;
    privateKey: string;
    tokenBalance: number;
    solBalance: number;
    source: 'original' | 'distributed';
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
    // FIXED: Generate only 4 wallets for atomic bundle
    const initialWalletCount = 4;
    logger.info(`🔧 Generating ${initialWalletCount} wallets for atomic bundle...`);
    
    this.wallets = [];
    for (let i = 0; i < initialWalletCount; i++) {
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
    
    // FIXED: Calculate for 4 initial wallets + distribution needs
    const buyAmount = this.config.swapAmountSol;
    const retainAmount = parseFloat(process.env.RETAIN_SOL_PER_WALLET || '0.005');
    const txFees = 0.002;
    const solPerWallet = buyAmount + retainAmount + txFees;
    
    const totalDistributorNeeded = (4 * solPerWallet) + 0.01; // 4 wallets + buffer
    const creatorNeeded = buyAmount + 0.05; // For token creation and initial buy
    
    // ADDITIONAL: Calculate distribution SOL needs
    const finalWalletCount = parseInt(process.env.FINAL_WALLET_COUNT || '8');
    const additionalWallets = finalWalletCount - 4;
    const solPerDistributedWallet = parseFloat(process.env.SOL_PER_DISTRIBUTED_WALLET || '0.005');
    const distributionSolNeeded = additionalWallets * solPerDistributedWallet;
    
    logger.info(`💰 Balance requirements:`);
    logger.info(`   🎨 Creator needs: ${creatorNeeded.toFixed(6)} SOL (creation + initial buy)`);
    logger.info(`   💰 Distributor needs: ${totalDistributorNeeded.toFixed(6)} SOL (4 initial wallets)`);
    logger.info(`   📦 Distribution needs: ${distributionSolNeeded.toFixed(6)} SOL (${additionalWallets} new wallets)`);
    logger.info(`   🎯 Total estimated: ${(creatorNeeded + totalDistributorNeeded + distributionSolNeeded).toFixed(6)} SOL`);
    
    // Validate balances
    if (creatorBalanceSOL < creatorNeeded) {
      throw new Error(`Creator wallet insufficient balance. Need ${creatorNeeded.toFixed(6)} SOL, have ${creatorBalanceSOL.toFixed(6)} SOL`);
    }
    
    if (distributorBalanceSOL < totalDistributorNeeded + distributionSolNeeded) {
      throw new Error(`Distributor wallet insufficient balance. Need ${(totalDistributorNeeded + distributionSolNeeded).toFixed(6)} SOL, have ${distributorBalanceSOL.toFixed(6)} SOL`);
    }
    
    logger.info('✅ All wallet balances are sufficient');
  }

  private async distributeSOL(): Promise<void> {
    // FIXED: Distribute to 4 wallets only
    const buyAmount = this.config.swapAmountSol;
    const retainAmount = parseFloat(process.env.RETAIN_SOL_PER_WALLET || '0.005');
    const txFees = 0.002;
    const solPerWallet = buyAmount + retainAmount + txFees;
    
    logger.info('💸 SOL distribution to 4 atomic bundle wallets...');
    logger.info(`   💰 Each wallet will receive: ${solPerWallet.toFixed(6)} SOL`);
    
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

  // NEW: Token distribution functionality
  private async distributeTokens(mint: string, sourceWallets: any[]): Promise<{
    success: boolean;
    distributedWallets: any[];
    signatures: string[];
    totalDistributed: number;
  }> {
    const finalWalletCount = parseInt(process.env.FINAL_WALLET_COUNT || '8');
    const additionalWalletsNeeded = finalWalletCount - sourceWallets.length;
    
    if (additionalWalletsNeeded <= 0) {
      logger.info('🎯 No additional wallets needed');
      return {
        success: true,
        distributedWallets: [],
        signatures: [],
        totalDistributed: 0
      };
    }
    
    logger.info(`🔄 Starting token distribution...`);
    logger.info(`   Source wallets: ${sourceWallets.length}`);
    logger.info(`   Additional wallets needed: ${additionalWalletsNeeded}`);
    
    const walletsPerSource = Math.ceil(additionalWalletsNeeded / sourceWallets.length);
    const solPerDistributedWallet = parseFloat(process.env.SOL_PER_DISTRIBUTED_WALLET || '0.005');
    
    logger.info(`   Wallets per source: ${walletsPerSource}`);
    logger.info(`   SOL per new wallet: ${solPerDistributedWallet}`);
    
    const allDistributedWallets: any[] = [];
    const allSignatures: string[] = [];
    let totalDistributed = 0;
    
    for (let i = 0; i < sourceWallets.length; i++) {
      const sourceWallet = sourceWallets[i];
      
      try {
        logger.info(`\n📦 Distributing from wallet ${i + 1}: ${sourceWallet.publicKey.slice(0, 8)}...`);
        
        // Get current token balance
        const sourceATA = await getAssociatedTokenAddress(
          new (require('@solana/web3.js').PublicKey)(mint),
          new (require('@solana/web3.js').PublicKey)(sourceWallet.publicKey),
          false
        );
        
        const tokenAccount = await getAccount(this.connection, sourceATA);
        const totalTokens = Number(tokenAccount.amount);
        
        logger.info(`   Token balance: ${totalTokens.toLocaleString()} tokens`);
        
        // Keep 5% in source wallet, distribute 95%
        const tokensToDistribute = Math.floor(totalTokens * 0.95);
        
        // Generate random distribution amounts
        const distributionAmounts = this.generateRandomAmounts(tokensToDistribute, walletsPerSource);
        
        // Create new wallets and distribution transaction
        const newWallets: Keypair[] = [];
        const newWalletData: any[] = [];
        
        for (let j = 0; j < walletsPerSource; j++) {
          const newWallet = Keypair.generate();
          newWallets.push(newWallet);
          newWalletData.push({
            publicKey: newWallet.publicKey.toBase58(),
            privateKey: bs58.encode(newWallet.secretKey),
            expectedTokens: distributionAmounts[j],
            expectedSOL: solPerDistributedWallet
          });
        }
        
        // Create distribution transaction
        const tx = new Transaction();
        
        // Recreate source keypair
        const sourceKeypair = Keypair.fromSecretKey(bs58.decode(sourceWallet.privateKey));
        
        for (let j = 0; j < newWallets.length; j++) {
          const newWallet = newWallets[j];
          const tokenAmount = distributionAmounts[j];
          
          // Send SOL to new wallet
          tx.add(
            SystemProgram.transfer({
              fromPubkey: sourceKeypair.publicKey,
              toPubkey: newWallet.publicKey,
              lamports: BigInt(Math.floor(solPerDistributedWallet * LAMPORTS_PER_SOL)),
            })
          );
          
          // Create ATA for new wallet
          const newWalletATA = await getAssociatedTokenAddress(
            new (require('@solana/web3.js').PublicKey)(mint),
            newWallet.publicKey,
            false
          );
          
          tx.add(
            createAssociatedTokenAccountInstruction(
              sourceKeypair.publicKey, // Payer
              newWalletATA,
              newWallet.publicKey, // Owner
              new (require('@solana/web3.js').PublicKey)(mint)
            )
          );
          
          // Transfer tokens
          tx.add(
            createTransferInstruction(
              sourceATA,
              newWalletATA,
              sourceKeypair.publicKey,
              BigInt(tokenAmount),
              [],
              TOKEN_PROGRAM_ID
            )
          );
          
          logger.info(`     → ${newWallet.publicKey.toBase58().slice(0, 8)}... ${tokenAmount.toLocaleString()} tokens + ${solPerDistributedWallet} SOL`);
        }
        
        // Send distribution transaction
        const signature = await this.connection.sendTransaction(tx, [sourceKeypair], {
          skipPreflight: false,
          maxRetries: 3,
        });
        
        await this.connection.confirmTransaction(signature, 'confirmed');
        
        logger.info(`   ✅ Distribution completed: ${signature}`);
        
        allDistributedWallets.push(...newWalletData);
        allSignatures.push(signature);
        totalDistributed += tokensToDistribute;
        
        // Wait between distributions
        if (i < sourceWallets.length - 1) {
          logger.info(`   ⏳ Waiting 2s before next distribution...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error) {
        logger.error(`   ❌ Distribution failed for wallet ${i + 1}:`, error);
      }
    }
    
    logger.info(`\n📊 Distribution summary:`);
    logger.info(`   New wallets created: ${allDistributedWallets.length}`);
    logger.info(`   Total tokens distributed: ${totalDistributed.toLocaleString()}`);
    logger.info(`   Distribution transactions: ${allSignatures.length}`);
    
    return {
      success: allDistributedWallets.length > 0,
      distributedWallets: allDistributedWallets,
      signatures: allSignatures,
      totalDistributed
    };
  }
  
  // Helper function to generate random distribution amounts
  private generateRandomAmounts(totalAmount: number, count: number): number[] {
    if (count === 1) return [totalAmount];
    
    const amounts: number[] = [];
    let remaining = totalAmount;
    
    for (let i = 0; i < count - 1; i++) {
      const baseAmount = Math.floor(remaining / (count - i));
      const variance = Math.floor(baseAmount * 0.15); // 15% variance
      const randomVariance = Math.floor((Math.random() - 0.5) * 2 * variance);
      const amount = Math.max(1, baseAmount + randomVariance);
      
      amounts.push(Math.min(amount, remaining - (count - i - 1)));
      remaining -= amounts[i];
    }
    
    amounts.push(remaining);
    return amounts;
  }

  // MODIFIED: Main function with distribution support
  async createAndBundle(metadata: TokenMetadata, testMode: boolean = false, enableDistribution: boolean = true): Promise<BundleResult> {
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
      logger.info('🚀 Starting ATOMIC bundled token creation and buying (4 wallets)...');
      
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
      
      // Step 5: Prepare bundled buys (4 wallets only for atomic execution)
      const buyAmountSol = BigInt(Math.floor(this.config.swapAmountSol * LAMPORTS_PER_SOL));
      const slippageBasisPoints = BigInt(this.config.slippageBasisPoints);
      
      // Create bundled buys for 4 wallets
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
      
      logger.info('🔨 Creating ATOMIC bundled transaction (CREATE + 4 buys)...');
      logger.info(`   🎨 Creator wallet handles: Token creation + initial buy`);
      logger.info(`   💰 Distributor wallet funded: ${bundledBuys.length} bundled buy wallets`);
      
      const priorityFees: PriorityFee = {
        unitLimit: this.config.priorityFee.unitLimit,
        unitPrice: this.config.priorityFee.unitPrice,
      };
      
      // Step 6: Execute bundled create and buy WITH ATOMIC BUNDLE (5 transactions total)
      const createResult = await this.pumpFunSDK.createAndBuyBundled(
        this.config.creatorWallet,    // CREATOR: Creates token and does initial buy
        mint,                         // mint keypair
        createTokenMetadata,          // metadata
        buyAmountSol,                // creator's initial buy amount
        bundledBuys,                 // bundled buys (4 wallets)
        slippageBasisPoints,         // slippage
        priorityFees,                // priority fees
        'confirmed',                 // commitment
        'confirmed'                  // finality
      );
      
      if (!createResult.success) {
        throw new Error(`Atomic bundled transaction failed: ${createResult.error}`);
      }
      
      logger.info(`✅ ATOMIC bundled transaction successful!`);
      logger.info(`   Signature: ${createResult.signature}`);
      logger.info(`   Mint: ${mint.publicKey.toBase58()}`);
      logger.info(`   View on Pump.fun: https://pump.fun/${mint.publicKey.toBase58()}`);
      
      // Step 7: Get initial wallet info with cleanup
      const walletInfo = await this.improvedCleanup();
      
      // Step 8: Execute token distribution if enabled
      let distributionResults;
      let allFinalWallets: any[] = [];
      
      if (enableDistribution) {
        logger.info('\n🔄 Starting token distribution phase...');
        
        // Wait for initial transactions to settle
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        distributionResults = await this.distributeTokens(mint.publicKey.toBase58(), walletInfo);
        
        // Compile all final wallets
        // Add original wallets (now with less tokens)
        for (const wallet of walletInfo) {
          try {
            const tokenBalance = await this.getTokenBalance(wallet.publicKey, mint.publicKey.toBase58());
            const solBalance = await this.connection.getBalance(new (require('@solana/web3.js').PublicKey)(wallet.publicKey));
            
            allFinalWallets.push({
              publicKey: wallet.publicKey,
              privateKey: wallet.privateKey,
              tokenBalance,
              solBalance: solBalance / LAMPORTS_PER_SOL,
              source: 'original'
            });
          } catch (error) {
            logger.warn(`Could not get updated balance for original wallet ${wallet.publicKey.slice(0, 8)}`);
          }
        }
        
        // Add distributed wallets
        for (const distributedWallet of distributionResults.distributedWallets) {
          allFinalWallets.push({
            publicKey: distributedWallet.publicKey,
            privateKey: distributedWallet.privateKey,
            tokenBalance: distributedWallet.expectedTokens,
            solBalance: distributedWallet.expectedSOL,
            source: 'distributed'
          });
        }
      } else {
        // No distribution, just use original wallets
        allFinalWallets = walletInfo.map(wallet => ({
          publicKey: wallet.publicKey,
          privateKey: wallet.privateKey,
          tokenBalance: 0, // Would need to fetch
          solBalance: wallet.remainingSOL,
          source: 'original'
        }));
      }
      
      // Step 9: Save all final wallets
      this.saveAllFinalWallets(allFinalWallets, mint.publicKey.toBase58());
      
      logger.info(`🎉 Operation completed with ATOMIC bundling + distribution!`);
      logger.info(`   🎨 Creator wallet: Token created + initial buy ✅`);
      logger.info(`   💰 Distributor wallet: Funded 4 atomic bundled buys ✅`);
      logger.info(`   📦 Atomic bundle: 4 wallets ✅`);
      if (enableDistribution && distributionResults) {
        logger.info(`   🔄 Token distribution: ${distributionResults.distributedWallets.length} new wallets ✅`);
        logger.info(`   🏁 Total final wallets: ${allFinalWallets.length} ✅`);
      }
      
      return {
        success: true,
        mint: mint.publicKey.toBase58(),
        signature: createResult.signature,
        bundledWallets: walletInfo,
        distributionResults: distributionResults ? {
          success: distributionResults.success,
          totalDistributedWallets: distributionResults.distributedWallets.length,
          distributionSignatures: distributionResults.signatures,
          finalWalletCount: allFinalWallets.length
        } : undefined,
        allFinalWallets
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

  // Helper method to get token balance
  private async getTokenBalance(walletAddress: string, mint: string): Promise<number> {
    try {
      const walletPubkey = new (require('@solana/web3.js').PublicKey)(walletAddress);
      const mintPubkey = new (require('@solana/web3.js').PublicKey)(mint);
      const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey, false);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount);
    } catch (error) {
      return 0;
    }
  }

  // NEW: Save all final wallets to file
  private saveAllFinalWallets(allWallets: any[], mint: string): void {
    const walletData = {
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      mint,
      network: this.config.network,
      totalWallets: allWallets.length,
      originalWallets: allWallets.filter(w => w.source === 'original').length,
      distributedWallets: allWallets.filter(w => w.source === 'distributed').length,
      wallets: allWallets.map(wallet => ({
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
        tokenBalance: wallet.tokenBalance,
        solBalance: wallet.solBalance,
        source: wallet.source
      }))
    };
    
    const walletFilePath = path.join(process.cwd(), 'wallets', `final_wallets_${this.sessionId}.json`);
    const walletsDir = path.dirname(walletFilePath);
    
    if (!fs.existsSync(walletsDir)) {
      fs.mkdirSync(walletsDir, { recursive: true });
    }
    
    fs.writeFileSync(walletFilePath, JSON.stringify(walletData, null, 2));
    logger.info(`💾 All final wallets saved to: ${walletFilePath}`);
  }

  // Keep existing cleanup method
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
// src/token-distributor.ts - Secondary token distribution system

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
  } from '@solana/web3.js';
  import {
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createTransferInstruction,
    getAccount,
  } from '@solana/spl-token';
  import { logger } from './utils/logger';
  import { BundlerConfig } from './config';
  
  export interface DistributionWallet {
    publicKey: string;
    privateKey: string;
    tokenBalance: number;
    solBalance: number;
  }
  
  export interface DistributionTarget {
    wallet: Keypair;
    tokenAmount: bigint;
    solAmount: number;
  }
  
  export interface DistributionPlan {
    sourceWallet: DistributionWallet;
    targets: DistributionTarget[];
    totalTokens: bigint;
    totalSol: number;
  }
  
  export interface DistributionResult {
    success: boolean;
    sourceWallet: string;
    distributedWallets: {
      publicKey: string;
      privateKey: string;
      receivedTokens: number;
      receivedSOL: number;
    }[];
    signature?: string;
    error?: string;
  }
  
  export class TokenDistributor {
    private connection: Connection;
    private config: BundlerConfig;
    private mint: PublicKey;
  
    constructor(connection: Connection, config: BundlerConfig, mint: string) {
      this.connection = connection;
      this.config = config;
      this.mint = new PublicKey(mint);
    }
  
    /**
     * Generate randomized distribution amounts
     * @param totalAmount Total amount to distribute
     * @param targetCount Number of targets
     * @param variancePercent Randomness variance (5-15%)
     */
    private generateRandomDistribution(
      totalAmount: bigint,
      targetCount: number,
      variancePercent: number = 10
    ): bigint[] {
      if (targetCount === 1) {
        return [totalAmount];
      }
  
      const baseAmount = totalAmount / BigInt(targetCount);
      const variance = Number(baseAmount) * (variancePercent / 100);
      const amounts: bigint[] = [];
      let remaining = totalAmount;
  
      for (let i = 0; i < targetCount - 1; i++) {
        // Generate random variance (-variance to +variance)
        const randomVariance = Math.floor((Math.random() - 0.5) * 2 * variance);
        const amount = BigInt(Number(baseAmount) + randomVariance);
        
        // Ensure amount is positive and doesn't exceed remaining
        const finalAmount = amount > 0n && amount < remaining 
          ? amount 
          : remaining / BigInt(targetCount - i);
        
        amounts.push(finalAmount);
        remaining -= finalAmount;
      }
  
      // Last amount gets whatever is remaining
      amounts.push(remaining);
  
      logger.info(`📊 Generated random distribution:`);
      amounts.forEach((amount, i) => {
        const percentage = (Number(amount) / Number(totalAmount)) * 100;
        logger.info(`   Target ${i + 1}: ${amount.toString()} tokens (${percentage.toFixed(1)}%)`);
      });
  
      return amounts;
    }
  
    /**
     * Create distribution plans for all source wallets
     */
    async createDistributionPlans(
      sourceWallets: DistributionWallet[],
      walletsPerSource: number,
      solPerNewWallet: number = 0.005
    ): Promise<DistributionPlan[]> {
      logger.info(`📋 Creating distribution plans:`);
      logger.info(`   Source wallets: ${sourceWallets.length}`);
      logger.info(`   Wallets per source: ${walletsPerSource}`);
      logger.info(`   SOL per new wallet: ${solPerNewWallet}`);
  
      const plans: DistributionPlan[] = [];
  
      for (let i = 0; i < sourceWallets.length; i++) {
        const sourceWallet = sourceWallets[i];
        
        logger.info(`\n🎯 Planning distribution for wallet ${i + 1}: ${sourceWallet.publicKey.slice(0, 8)}...`);
        logger.info(`   Token balance: ${sourceWallet.tokenBalance.toLocaleString()} tokens`);
        logger.info(`   SOL balance: ${sourceWallet.solBalance.toFixed(6)} SOL`);
  
        // Generate target wallets
        const targets: DistributionTarget[] = [];
        const tokenAmounts = this.generateRandomDistribution(
          BigInt(Math.floor(sourceWallet.tokenBalance * 0.95)), // Keep 5% in source wallet
          walletsPerSource,
          12 // 12% variance for realistic distribution
        );
  
        for (let j = 0; j < walletsPerSource; j++) {
          const targetWallet = Keypair.generate();
          targets.push({
            wallet: targetWallet,
            tokenAmount: tokenAmounts[j],
            solAmount: solPerNewWallet,
          });
  
          logger.info(`   Target ${j + 1}: ${targetWallet.publicKey.toBase58().slice(0, 8)}... - ${tokenAmounts[j].toString()} tokens + ${solPerNewWallet} SOL`);
        }
  
        const totalTokens = tokenAmounts.reduce((sum, amount) => sum + amount, 0n);
        const totalSol = walletsPerSource * solPerNewWallet;
  
        // Validate source wallet has enough
        if (Number(totalTokens) > sourceWallet.tokenBalance * 0.95) {
          throw new Error(`Source wallet ${i + 1} doesn't have enough tokens for distribution`);
        }
  
        if (totalSol > sourceWallet.solBalance * 0.8) {
          throw new Error(`Source wallet ${i + 1} doesn't have enough SOL for distribution`);
        }
  
        plans.push({
          sourceWallet,
          targets,
          totalTokens,
          totalSol,
        });
      }
  
      logger.info(`\n✅ Created ${plans.length} distribution plans`);
      return plans;
    }
  
    /**
     * Execute a single distribution plan
     */
    async executeDistributionPlan(
      plan: DistributionPlan,
      sourceKeypair: Keypair
    ): Promise<DistributionResult> {
      logger.info(`🚀 Executing distribution for ${plan.sourceWallet.publicKey.slice(0, 8)}...`);
  
      try {
        const transaction = new Transaction();
        const sourceATA = await getAssociatedTokenAddress(
          this.mint,
          sourceKeypair.publicKey,
          false
        );
  
        // Add priority fees
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: sourceKeypair.publicKey,
            toPubkey: sourceKeypair.publicKey,
            lamports: 0, // No-op to set payer
          })
        );
  
        const distributedWallets: {
          publicKey: string;
          privateKey: string;
          receivedTokens: number;
          receivedSOL: number;
        }[] = [];
  
        // Process each target
        for (let i = 0; i < plan.targets.length; i++) {
          const target = plan.targets[i];
          
          // 1. Send SOL to new wallet
          transaction.add(
            SystemProgram.transfer({
              fromPubkey: sourceKeypair.publicKey,
              toPubkey: target.wallet.publicKey,
              lamports: BigInt(Math.floor(target.solAmount * LAMPORTS_PER_SOL)),
            })
          );
  
          // 2. Create ATA for new wallet
          const targetATA = await getAssociatedTokenAddress(
            this.mint,
            target.wallet.publicKey,
            false
          );
  
          transaction.add(
            createAssociatedTokenAccountInstruction(
              sourceKeypair.publicKey, // Payer
              targetATA,
              target.wallet.publicKey, // Owner
              this.mint
            )
          );
  
          // 3. Transfer tokens to new wallet
          transaction.add(
            createTransferInstruction(
              sourceATA,
              targetATA,
              sourceKeypair.publicKey,
              target.tokenAmount,
              [],
              TOKEN_PROGRAM_ID
            )
          );
  
          distributedWallets.push({
            publicKey: target.wallet.publicKey.toBase58(),
            privateKey: Buffer.from(target.wallet.secretKey).toString('base64'),
            receivedTokens: Number(target.tokenAmount),
            receivedSOL: target.solAmount,
          });
  
          logger.info(`   ✅ Added instructions for target ${i + 1}: ${target.wallet.publicKey.toBase58().slice(0, 8)}...`);
        }
  
        // Send transaction
        logger.info(`📤 Sending distribution transaction...`);
        const signature = await this.connection.sendTransaction(transaction, [sourceKeypair], {
          skipPreflight: false,
          maxRetries: 3,
        });
  
        // Confirm transaction
        await this.connection.confirmTransaction(signature, 'confirmed');
        
        logger.info(`✅ Distribution completed: ${signature}`);
        logger.info(`   Distributed to ${plan.targets.length} new wallets`);
        logger.info(`   Total tokens distributed: ${plan.totalTokens.toString()}`);
        logger.info(`   Total SOL distributed: ${plan.totalSol.toFixed(6)}`);
  
        return {
          success: true,
          sourceWallet: plan.sourceWallet.publicKey,
          distributedWallets,
          signature,
        };
  
      } catch (error) {
        logger.error(`❌ Distribution failed for ${plan.sourceWallet.publicKey.slice(0, 8)}:`, error);
        
        return {
          success: false,
          sourceWallet: plan.sourceWallet.publicKey,
          distributedWallets: [],
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  
    /**
     * Execute all distribution plans
     */
    async executeAllDistributions(
      plans: DistributionPlan[],
      sourceKeypairs: Keypair[],
      delayBetweenDistributions: number = 2000
    ): Promise<DistributionResult[]> {
      logger.info(`🎯 Executing ${plans.length} distribution plans...`);
  
      const results: DistributionResult[] = [];
  
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        const sourceKeypair = sourceKeypairs[i];
  
        logger.info(`\n📦 Distribution ${i + 1}/${plans.length}...`);
        
        const result = await this.executeDistributionPlan(plan, sourceKeypair);
        results.push(result);
  
        // Add delay between distributions to avoid rate limits
        if (i < plans.length - 1 && delayBetweenDistributions > 0) {
          logger.info(`⏳ Waiting ${delayBetweenDistributions}ms before next distribution...`);
          await new Promise(resolve => setTimeout(resolve, delayBetweenDistributions));
        }
      }
  
      // Summary
      const successful = results.filter(r => r.success);
      const totalDistributedWallets = successful.reduce((sum, r) => sum + r.distributedWallets.length, 0);
  
      logger.info(`\n📊 DISTRIBUTION SUMMARY:`);
      logger.info(`   Successful distributions: ${successful.length}/${plans.length}`);
      logger.info(`   Total new wallets created: ${totalDistributedWallets}`);
      logger.info(`   Distribution success rate: ${((successful.length / plans.length) * 100).toFixed(1)}%`);
  
      if (successful.length > 0) {
        logger.info(`   ✅ Successful distributions:`);
        successful.forEach((result, i) => {
          logger.info(`     ${i + 1}. ${result.sourceWallet.slice(0, 8)}... → ${result.distributedWallets.length} wallets`);
        });
      }
  
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        logger.warn(`   ❌ Failed distributions:`);
        failed.forEach((result, i) => {
          logger.warn(`     ${i + 1}. ${result.sourceWallet.slice(0, 8)}...: ${result.error}`);
        });
      }
  
      return results;
    }
  
    /**
     * Get token balance for a wallet
     */
    async getTokenBalance(walletAddress: string): Promise<number> {
      try {
        const walletPubkey = new PublicKey(walletAddress);
        const ata = await getAssociatedTokenAddress(this.mint, walletPubkey, false);
        const account = await getAccount(this.connection, ata);
        return Number(account.amount);
      } catch (error) {
        logger.warn(`Could not get token balance for ${walletAddress.slice(0, 8)}:`, error);
        return 0;
      }
    }
  
    /**
     * Get SOL balance for a wallet
     */
    async getSolBalance(walletAddress: string): Promise<number> {
      try {
        const walletPubkey = new PublicKey(walletAddress);
        const balance = await this.connection.getBalance(walletPubkey);
        return balance / LAMPORTS_PER_SOL;
      } catch (error) {
        logger.warn(`Could not get SOL balance for ${walletAddress.slice(0, 8)}:`, error);
        return 0;
      }
    }
  
    /**
     * Save distribution results to file
     */
    saveDistributionResults(results: DistributionResult[], sessionId: string): string {
      const fs = require('fs');
      const path = require('path');
  
      const distributionData = {
        sessionId,
        timestamp: new Date().toISOString(),
        mint: this.mint.toBase58(),
        totalDistributions: results.length,
        successfulDistributions: results.filter(r => r.success).length,
        totalNewWallets: results.reduce((sum, r) => sum + r.distributedWallets.length, 0),
        results,
      };
  
      const filename = `distribution_${sessionId}_${Date.now()}.json`;
      const filepath = path.join(process.cwd(), 'wallets', filename);
      
      // Ensure directory exists
      const dir = path.dirname(filepath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
  
      fs.writeFileSync(filepath, JSON.stringify(distributionData, null, 2));
      logger.info(`💾 Distribution results saved to: ${filepath}`);
  
      return filepath;
    }
  }
  
  /**
   * Utility function to convert bundled wallets to distribution wallets
   */
  export async function convertBundledToDistributionWallets(
    bundledWallets: any[],
    connection: Connection,
    mint: string
  ): Promise<DistributionWallet[]> {
    logger.info(`🔄 Converting ${bundledWallets.length} bundled wallets to distribution format...`);
  
    const distributor = new TokenDistributor(connection, {} as BundlerConfig, mint);
    const distributionWallets: DistributionWallet[] = [];
  
    for (const wallet of bundledWallets) {
      const tokenBalance = await distributor.getTokenBalance(wallet.publicKey);
      const solBalance = await distributor.getSolBalance(wallet.publicKey);
  
      distributionWallets.push({
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
        tokenBalance,
        solBalance,
      });
  
      logger.info(`   ✅ ${wallet.publicKey.slice(0, 8)}... - ${tokenBalance.toLocaleString()} tokens, ${solBalance.toFixed(6)} SOL`);
    }
  
    return distributionWallets;
  }
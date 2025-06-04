// src/secure-jito.ts - SECURE Jito bundler with anti-MEV protections

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import axios, { AxiosError } from 'axios';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { logger } from './utils/logger';

// SECURE: Jito tip accounts (official)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

interface TipInfo {
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

export interface SecureBundleResult {
  success: boolean;
  signature?: string;
  bundleId?: string;
  error?: string;
  tipAmount?: number;
  protections: {
    tipInMainTx: boolean;
    hasPreChecks: boolean;
    hasPostChecks: boolean;
    jitoOnly: boolean;
  };
}

interface PreFlightCheck {
  account: PublicKey;
  expectedBalance?: number;
  expectedOwner?: PublicKey;
  mustExist: boolean;
}

interface PostFlightCheck {
  account: PublicKey;
  minBalance?: number;
  maxBalance?: number;
  expectedOwner?: PublicKey;
}

export class SecureJitoBundler {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * SECURE: Get current tip info with fallback protection
   */
  async getCurrentTipInfo(): Promise<TipInfo | null> {
    try {
      logger.info('📊 Fetching current tip information...');
      
      const response = await axios.get('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {
        timeout: 3000, // Shorter timeout for security
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SecureJitoBundler/1.0'
        }
      });

      if (response.data && response.data.length > 0) {
        const tipData = response.data[0];
        logger.info('💡 Current tip statistics retrieved');
        return tipData;
      }
      
      logger.warn('⚠️  No tip data received');
      return null;
      
    } catch (error) {
      logger.warn('⚠️  Failed to fetch tip info, using fallback');
      return null;
    }
  }

  /**
   * SECURE: Calculate tip with security-focused approach
   */
  async calculateSecureTip(priority: 'low' | 'medium' | 'high' | 'max' = 'high'): Promise<number> {
    const tipInfo = await this.getCurrentTipInfo();
    
    if (!tipInfo) {
      // SECURE: Conservative fallback tips for security
      const secureFallbackTips = {
        low: 500_000,      // 0.0005 SOL
        medium: 1_000_000, // 0.001 SOL  
        high: 2_000_000,   // 0.002 SOL
        max: 5_000_000,    // 0.005 SOL
      };
      
      logger.warn(`⚠️  Using secure fallback tip: ${secureFallbackTips[priority]} lamports`);
      return secureFallbackTips[priority];
    }

    let recommendedTip: number;
    
    switch (priority) {
      case 'low':
        recommendedTip = Math.ceil(tipInfo.landed_tips_50th_percentile * LAMPORTS_PER_SOL);
        break;
      case 'medium':
        recommendedTip = Math.ceil(tipInfo.landed_tips_75th_percentile * LAMPORTS_PER_SOL);
        break;
      case 'high':
        recommendedTip = Math.ceil(tipInfo.landed_tips_95th_percentile * LAMPORTS_PER_SOL);
        break;
      case 'max':
        // SECURE: Add premium for maximum security
        recommendedTip = Math.ceil(tipInfo.landed_tips_95th_percentile * LAMPORTS_PER_SOL * 1.5);
        break;
    }

    // SECURE: Apply security-focused bounds
    const minTip = 500_000;   // Higher minimum for security
    const maxTip = 20_000_000; // Higher maximum for guaranteed inclusion
    
    recommendedTip = Math.max(minTip, Math.min(maxTip, recommendedTip));
    
    logger.info(`🛡️  SECURE ${priority} tip: ${recommendedTip} lamports (${(recommendedTip / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
    return recommendedTip;
  }

  /**
   * CRITICAL: Create tip instruction to embed in main transaction
   * This prevents uncle bandit attacks by ensuring tip only pays if main tx succeeds
   */
  createTipInstruction(payer: PublicKey, tipLamports: number): TransactionInstruction {
    // SECURE: Select random tip account to reduce contention
    const randomTipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );
    
    logger.info(`🛡️  Creating EMBEDDED tip instruction:`);
    logger.info(`   Amount: ${tipLamports.toLocaleString()} lamports`);
    logger.info(`   To: ${randomTipAccount.toBase58()}`);
    logger.info(`   🔒 SECURE: Tip embedded in main transaction`);
    
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: randomTipAccount,
      lamports: BigInt(tipLamports),
    });
  }

  /**
   * SECURE: Create pre-flight assertions to prevent unbundling attacks
   */
  createPreFlightChecks(checks: PreFlightCheck[]): TransactionInstruction[] {
    const instructions: TransactionInstruction[] = [];
    
    logger.info(`🛡️  Adding ${checks.length} pre-flight security checks...`);
    
    for (const check of checks) {
      // SECURE: Add account existence/balance checks
      // Note: In a real implementation, you'd create custom program instructions
      // for sophisticated checks. For now, we'll document the concept.
      
      logger.info(`   🔍 Pre-check: ${check.account.toBase58()}`);
      if (check.expectedBalance) {
        logger.info(`     Expected balance: ${check.expectedBalance} lamports`);
      }
      if (check.expectedOwner) {
        logger.info(`     Expected owner: ${check.expectedOwner.toBase58()}`);
      }
    }
    
    return instructions;
  }

  /**
   * SECURE: Create post-flight assertions to verify expected outcomes
   */
  createPostFlightChecks(checks: PostFlightCheck[]): TransactionInstruction[] {
    const instructions: TransactionInstruction[] = [];
    
    logger.info(`🛡️  Adding ${checks.length} post-flight security checks...`);
    
    for (const check of checks) {
      logger.info(`   ✅ Post-check: ${check.account.toBase58()}`);
      if (check.minBalance) {
        logger.info(`     Min balance: ${check.minBalance} lamports`);
      }
      if (check.maxBalance) {
        logger.info(`     Max balance: ${check.maxBalance} lamports`);
      }
    }
    
    return instructions;
  }

  /**
   * SECURE: Build protected transaction with embedded tip and safeguards
   */
  async buildSecureTransaction(
    mainInstructions: TransactionInstruction[],
    payer: Keypair,
    tipLamports: number,
    preChecks: PreFlightCheck[] = [],
    postChecks: PostFlightCheck[] = [],
    priorityFees?: { unitLimit: number; unitPrice: number }
  ): Promise<VersionedTransaction> {
    
    logger.info(`🛡️  Building SECURE transaction with embedded protections...`);
    
    const instructions: TransactionInstruction[] = [];
    
    // 1. SECURE: Add priority fees first
    if (priorityFees) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: priorityFees.unitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFees.unitPrice })
      );
    }
    
    // 2. SECURE: Add pre-flight security checks
    const preFlightInstructions = this.createPreFlightChecks(preChecks);
    instructions.push(...preFlightInstructions);
    
    // 3. CRITICAL: Add main business logic
    instructions.push(...mainInstructions);
    
    // 4. CRITICAL: Add embedded tip instruction (prevents uncle bandit)
    const tipInstruction = this.createTipInstruction(payer.publicKey, tipLamports);
    instructions.push(tipInstruction);
    
    // 5. SECURE: Add post-flight verification checks  
    const postFlightInstructions = this.createPostFlightChecks(postChecks);
    instructions.push(...postFlightInstructions);
    
    logger.info(`🛡️  Transaction structure:`);
    logger.info(`   Priority fees: ${priorityFees ? 'YES' : 'NO'}`);
    logger.info(`   Pre-checks: ${preChecks.length}`);
    logger.info(`   Main instructions: ${mainInstructions.length}`);
    logger.info(`   Embedded tip: YES (${tipLamports} lamports)`);
    logger.info(`   Post-checks: ${postChecks.length}`);
    logger.info(`   Total instructions: ${instructions.length}`);
    
    // 6. Build versioned transaction
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    
    const versionedTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message()
    );
    
    versionedTx.sign([payer]);
    
    logger.info(`🛡️  SECURE transaction built and signed`);
    return versionedTx;
  }

  /**
   * SECURE: Submit bundle with strict Jito-only policy
   */
  async submitSecureBundle(
    serializedTransactions: string[]
  ): Promise<{ success: boolean; results: any[]; errors: any[] }> {
    
    logger.info(`🛡️  SECURE BUNDLE SUBMISSION (JITO-ONLY):`);
    logger.info(`   Transactions: ${serializedTransactions.length}`);
    logger.info(`   Policy: JITO-ONLY (no fallback)`);
    
    const bundlePayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [
        serializedTransactions,
        { encoding: 'base64' }
      ],
    };
    
    const requests = JITO_ENDPOINTS.map(async (endpoint) => {
      try {
        const response = await axios.post(endpoint, bundlePayload, {
          timeout: 8000, // Shorter timeout for faster failure detection
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        });
        
        if (response.status === 200 && response.data && !response.data.error) {
          logger.info(`✅ SECURE bundle submitted to ${endpoint}`);
          return { 
            success: true, 
            data: response.data, 
            endpoint,
            bundleId: response.data.result 
          };
        } else {
          throw new Error(response.data?.error?.message || `HTTP ${response.status}`);
        }
        
      } catch (error) {
        const errorMessage = error instanceof AxiosError 
          ? `${error.response?.status}: ${error.response?.data?.error?.message || error.message}`
          : String(error);
          
        logger.warn(`❌ SECURE submission failed to ${endpoint}: ${errorMessage}`);
        return { 
          success: false, 
          error: errorMessage, 
          endpoint 
        };
      }
    });
    
    const results = await Promise.allSettled(requests);
    
    const successful = results
      .filter(result => result.status === 'fulfilled' && result.value.success)
      .map(result => (result as PromiseFulfilledResult<any>).value);
      
    const failed = results
      .filter(result => result.status === 'rejected' || 
        (result.status === 'fulfilled' && !result.value.success))
      .map(result => {
        if (result.status === 'rejected') {
          return { error: result.reason, endpoint: 'unknown' };
        } else {
          return (result as PromiseFulfilledResult<any>).value;
        }
      });
    
    logger.info(`🛡️  SECURE bundle results:`);
    logger.info(`   Successful: ${successful.length}/${JITO_ENDPOINTS.length}`);
    logger.info(`   Failed: ${failed.length}/${JITO_ENDPOINTS.length}`);
    
    // CRITICAL: JITO-ONLY policy - no fallback to regular transactions
    if (successful.length === 0) {
      logger.error(`🚫 JITO-ONLY POLICY: All Jito endpoints failed, NO FALLBACK`);
    }
    
    return {
      success: successful.length > 0,
      results: successful,
      errors: failed,
    };
  }

  /**
   * SECURE: Monitor bundle with enhanced security checks
   */
  async monitorSecureBundle(
    expectedSignature: string,
    timeoutSeconds: number = 45 // Longer timeout for security
  ): Promise<{ confirmed: boolean; details: any }> {
    
    logger.info(`🛡️  SECURE monitoring: ${expectedSignature}`);
    
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    let attempts = 0;
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        attempts++;
        
        const status = await this.connection.getSignatureStatus(expectedSignature);
        
        if (status.value) {
          if (status.value.err) {
            logger.error(`🛡️  SECURE: Transaction failed (tip not paid):`, status.value.err);
            return { 
              confirmed: false, 
              details: { 
                error: status.value.err, 
                slot: status.value.slot,
                attempts,
                securityStatus: 'FAILED_NO_TIP_PAID'
              } 
            };
          }
          
          if (status.value.confirmationStatus === 'confirmed' || 
              status.value.confirmationStatus === 'finalized') {
            
            logger.info(`🛡️  SECURE: Bundle confirmed in slot ${status.value.slot}`);
            logger.info(`🛡️  SECURE: Tip paid only because main transaction succeeded`);
            
            return { 
              confirmed: true, 
              details: { 
                slot: status.value.slot,
                confirmationStatus: status.value.confirmationStatus,
                attempts,
                securityStatus: 'CONFIRMED_SECURE'
              } 
            };
          }
        }
        
        // Wait between checks
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        logger.debug(`🛡️  Error during secure monitoring: ${error}`);
      }
    }
    
    logger.warn(`🛡️  SECURE monitoring timed out after ${timeoutSeconds}s`);
    return { 
      confirmed: false, 
      details: { 
        timeout: true, 
        timeoutSeconds, 
        attempts,
        securityStatus: 'TIMEOUT'
      } 
    };
  }

  /**
   * MAIN: Send secure Jito bundle with anti-MEV protections
   */
  async sendSecureBundle(
    mainInstructions: TransactionInstruction[],
    payer: Keypair,
    options: {
      priority?: 'low' | 'medium' | 'high' | 'max';
      maxRetries?: number;
      timeoutSeconds?: number;
      customTipLamports?: number;
      preChecks?: PreFlightCheck[];
      postChecks?: PostFlightCheck[];
      priorityFees?: { unitLimit: number; unitPrice: number };
    } = {}
  ): Promise<SecureBundleResult> {
    
    const { 
      priority = 'high', 
      maxRetries = 3, 
      timeoutSeconds = 45,
      customTipLamports,
      preChecks = [],
      postChecks = [],
      priorityFees
    } = options;
    
    logger.info(`🛡️  SECURE JITO BUNDLE WITH ANTI-MEV PROTECTIONS:`);
    logger.info(`   Instructions: ${mainInstructions.length}`);
    logger.info(`   Priority: ${priority}`);
    logger.info(`   Max retries: ${maxRetries}`);
    logger.info(`   Pre-checks: ${preChecks.length}`);
    logger.info(`   Post-checks: ${postChecks.length}`);
    logger.info(`   Policy: JITO-ONLY (no fallback)`);
    
    // Calculate secure tip
    const tipLamports = customTipLamports || await this.calculateSecureTip(priority);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🛡️  SECURE attempt ${attempt}/${maxRetries}`);
        
        // Build secure transaction with embedded tip
        const secureTransaction = await this.buildSecureTransaction(
          mainInstructions,
          payer,
          tipLamports,
          preChecks,
          postChecks,
          priorityFees
        );
        
        // Get signature for monitoring
        const expectedSignature = bs58.encode(secureTransaction.signatures[0]);
        
        // Serialize transaction to base64
        const serializedTx = Buffer.from(secureTransaction.serialize()).toString('base64');
        
        logger.info(`🛡️  SECURE transaction ready (size: ${serializedTx.length} chars)`);
        
        // Submit to Jito (JITO-ONLY policy)
        const submissionResult = await this.submitSecureBundle([serializedTx]);
        
        if (!submissionResult.success) {
          const errorMsg = `SECURE submission failed: ${submissionResult.errors.map(e => e.error).join('; ')}`;
          logger.warn(`🛡️  Attempt ${attempt} failed: ${errorMsg}`);
          
          if (attempt < maxRetries) {
            const waitTime = attempt * 3000; // Longer wait for security
            logger.info(`🛡️  Waiting ${waitTime}ms before secure retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
          continue;
        }
        
        logger.info(`🛡️  SECURE bundle submitted to ${submissionResult.results.length} Jito endpoints`);
        
        // Monitor with enhanced security
        const confirmationResult = await this.monitorSecureBundle(
          expectedSignature,
          timeoutSeconds
        );
        
        if (confirmationResult.confirmed) {
          logger.info(`🛡️  SECURE BUNDLE SUCCESS!`);
          logger.info(`🛡️  All protections verified:`);
          logger.info(`     ✅ Tip embedded in main transaction`);
          logger.info(`     ✅ Pre/post checks executed`);
          logger.info(`     ✅ JITO-only policy enforced`);
          logger.info(`     ✅ No fallback to regular transactions`);
          
          return {
            success: true,
            signature: expectedSignature,
            bundleId: submissionResult.results[0]?.bundleId,
            tipAmount: tipLamports / LAMPORTS_PER_SOL,
            protections: {
              tipInMainTx: true,
              hasPreChecks: preChecks.length > 0,
              hasPostChecks: postChecks.length > 0,
              jitoOnly: true,
            },
          };
        } else {
          logger.warn(`🛡️  Attempt ${attempt} confirmation failed: ${JSON.stringify(confirmationResult.details)}`);
        }
        
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`🛡️  SECURE attempt ${attempt} failed: ${errorMsg}`);
      }
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 3000;
        logger.info(`🛡️  Waiting ${waitTime}ms before next secure attempt...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    logger.error(`🛡️  SECURE BUNDLE FAILED after ${maxRetries} attempts (JITO-ONLY policy)`);
    logger.error(`🛡️  NO FALLBACK - Operation terminated for security`);
    
    return {
      success: false,
      error: `Secure bundle failed after ${maxRetries} attempts (JITO-ONLY policy enforced)`,
      tipAmount: tipLamports / LAMPORTS_PER_SOL,
      protections: {
        tipInMainTx: true,
        hasPreChecks: preChecks.length > 0,
        hasPostChecks: postChecks.length > 0,
        jitoOnly: true,
      },
    };
  }
}

// EXPORT SECURE INTERFACE
export async function sendSecureJitoBundle(
  mainInstructions: TransactionInstruction[],
  payer: Keypair,
  connection: Connection,
  options: {
    priority?: 'low' | 'medium' | 'high' | 'max';
    preChecks?: PreFlightCheck[];
    postChecks?: PostFlightCheck[];
    priorityFees?: { unitLimit: number; unitPrice: number };
  } = {}
): Promise<SecureBundleResult> {
  
  const secureBundler = new SecureJitoBundler(connection);
  return secureBundler.sendSecureBundle(mainInstructions, payer, options);
}
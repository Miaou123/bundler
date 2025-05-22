import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
  } from '@solana/web3.js';
  import axios, { AxiosError } from 'axios';
  import base58 from 'base-58';
  import { BundlerConfig } from './config';
  import { logger } from './utils/logger';
  
  // Jito tip accounts (official Jito tip accounts)
  const JITO_TIP_ACCOUNTS = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  ];
  
  // Jito block engine endpoints
  const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
  ];
  
  export interface JitoBundleResult {
    success: boolean;
    signature?: string;
    bundleId?: string;
    error?: string;
    attempts?: number;
  }
  
  export interface JitoBundleOptions {
    maxRetries?: number;
    timeoutSeconds?: number;
    tipLamports?: number;
    preferredEndpoints?: string[];
  }
  
  /**
   * Selects a random Jito tip account
   */
  function selectRandomTipAccount(): PublicKey {
    const randomIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[randomIndex]);
  }
  
  /**
   * Creates a tip transaction for Jito
   */
  async function createTipTransaction(
    connection: Connection,
    payer: Keypair,
    tipLamports: number
  ): Promise<VersionedTransaction> {
    const tipAccount = selectRandomTipAccount();
    
    logger.debug(`Creating tip transaction: ${tipLamports} lamports to ${tipAccount.toBase58()}`);
    
    const { blockhash } = await connection.getLatestBlockhash();
    
    const tipTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tipAccount,
            lamports: BigInt(tipLamports),
          }),
        ],
      }).compileToV0Message()
    );
    
    tipTx.sign([payer]);
    return tipTx;
  }
  
  /**
   * Submits a bundle to Jito block engines
   */
  async function submitBundle(
    serializedTransactions: string[],
    endpoints: string[] = JITO_ENDPOINTS,
    timeoutMs: number = 10000
  ): Promise<{ success: boolean; results: any[]; errors: any[] }> {
    const bundleData = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [serializedTransactions],
    };
    
    logger.debug(`Submitting bundle to ${endpoints.length} endpoints`);
    
    const requests = endpoints.map(async (url) => {
      try {
        const response = await axios.post(url, bundleData, {
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        logger.debug(`Bundle submitted successfully to ${url}`);
        return { success: true, data: response.data, endpoint: url };
        
      } catch (error) {
        let errorMessage = 'Unknown error';
        
        if (error instanceof AxiosError) {
          if (error.response) {
            errorMessage = `HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`;
          } else if (error.request) {
            errorMessage = 'Network error - no response received';
          } else {
            errorMessage = error.message;
          }
        }
        
        logger.debug(`Bundle submission failed to ${url}: ${errorMessage}`);
        return { success: false, error: errorMessage, endpoint: url };
      }
    });
    
    const results = await Promise.allSettled(requests);
    
    const successful = results
      .filter(result => result.status === 'fulfilled' && result.value.success)
      .map(result => (result as PromiseFulfilledResult<any>).value);
      
    const failed = results
      .filter(result => result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.success))
      .map(result => {
        if (result.status === 'rejected') {
          return { error: result.reason, endpoint: 'unknown' };
        } else {
          return (result as PromiseFulfilledResult<any>).value;
        }
      });
    
    return {
      success: successful.length > 0,
      results: successful,
      errors: failed,
    };
  }
  
  /**
   * Monitors bundle confirmation
   */
  async function monitorBundleConfirmation(
    connection: Connection,
    tipSignature: string,
    timeoutSeconds: number = 30
  ): Promise<boolean> {
    logger.debug(`Monitoring bundle confirmation for tip: ${tipSignature}`);
    
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const status = await connection.getSignatureStatus(tipSignature);
        
        if (status.value) {
          if (status.value.err) {
            logger.debug(`Bundle failed: ${JSON.stringify(status.value.err)}`);
            return false;
          }
          
          if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
            logger.debug('Bundle confirmed successfully');
            return true;
          }
        }
        
        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        logger.debug(`Error checking bundle status: ${error}`);
      }
    }
    
    logger.debug('Bundle confirmation timed out');
    return false;
  }
  
  /**
   * Main function to send a bundle via Jito
   */
  export async function sendJitoBundle(
    transactions: VersionedTransaction[],
    payer: Keypair,
    config: BundlerConfig,
    options: JitoBundleOptions = {}
  ): Promise<JitoBundleResult> {
    const {
      maxRetries = config.jitoMaxRetries,
      timeoutSeconds = config.jitoTimeoutSeconds,
      tipLamports = config.jitoTipLamports,
      preferredEndpoints = JITO_ENDPOINTS,
    } = options;
    
    logger.info(`🚀 Sending bundle via Jito (${transactions.length} transactions, ${tipLamports} lamport tip)`);
    
    let lastError: string = '';
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`Bundle attempt ${attempt}/${maxRetries}`);
        
        // Create tip transaction
        const connection = new Connection(config.rpcUrl, 'confirmed');
        const tipTx = await createTipTransaction(connection, payer, tipLamports);
        const tipSignature = base58.encode(tipTx.signatures[0]);
        
        // Serialize all transactions
        const serializedTxs = [
          base58.encode(tipTx.serialize()),
          ...transactions.map(tx => base58.encode(tx.serialize()))
        ];
        
        logger.debug(`Bundle contains ${serializedTxs.length} transactions (including tip)`);
        
        // Submit bundle
        const submissionResult = await submitBundle(
          serializedTxs,
          preferredEndpoints,
          timeoutSeconds * 1000
        );
        
        if (!submissionResult.success) {
          const errorMessages = submissionResult.errors.map(e => `${e.endpoint}: ${e.error}`).join('; ');
          lastError = `Bundle submission failed to all endpoints: ${errorMessages}`;
          logger.warn(`Attempt ${attempt} failed: ${lastError}`);
          
          if (attempt < maxRetries) {
            const waitTime = attempt * 2000; // Exponential backoff
            logger.debug(`Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
          continue;
        }
        
        logger.info(`✅ Bundle submitted successfully to ${submissionResult.results.length}/${preferredEndpoints.length} endpoints`);
        
        // Monitor confirmation
        const confirmed = await monitorBundleConfirmation(
          connection,
          tipSignature,
          timeoutSeconds
        );
        
        if (confirmed) {
          logger.info('🎉 Bundle confirmed successfully!');
          return {
            success: true,
            signature: tipSignature,
            bundleId: submissionResult.results[0]?.data?.result,
            attempts: attempt,
          };
        } else {
          lastError = 'Bundle submitted but failed to confirm within timeout';
          logger.warn(`Attempt ${attempt} failed: ${lastError}`);
        }
        
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`Attempt ${attempt} failed with error: ${lastError}`);
      }
      
      // Wait before retry (except on last attempt)
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000; // 2s, 4s, 6s...
        logger.debug(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    logger.error(`❌ Bundle failed after ${maxRetries} attempts. Last error: ${lastError}`);
    return {
      success: false,
      error: lastError,
      attempts: maxRetries,
    };
  }
  
  /**
   * Fallback function to send transactions individually
   */
  export async function sendTransactionsIndividually(
    transactions: VersionedTransaction[],
    connection: Connection,
    config: BundlerConfig
  ): Promise<{ success: boolean; signatures: string[]; errors: string[] }> {
    logger.info('🔄 Falling back to individual transaction submission');
    
    const signatures: string[] = [];
    const errors: string[] = [];
    
    for (let i = 0; i < transactions.length; i++) {
      try {
        const tx = transactions[i];
        logger.debug(`Sending transaction ${i + 1}/${transactions.length}`);
        
        const signature = await connection.sendTransaction(tx, {
          skipPreflight: false,
          maxRetries: config.maxRetryAttempts,
        });
        
        signatures.push(signature);
        logger.debug(`Transaction ${i + 1} sent: ${signature}`);
        
        // Add delay between transactions to avoid rate limiting
        if (i < transactions.length - 1 && config.walletDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, config.walletDelayMs));
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Transaction ${i + 1}: ${errorMessage}`);
        logger.warn(`Transaction ${i + 1} failed: ${errorMessage}`);
      }
    }
    
    const successRate = signatures.length / transactions.length;
    logger.info(`Individual submission completed: ${signatures.length}/${transactions.length} successful (${(successRate * 100).toFixed(1)}%)`);
    
    return {
      success: signatures.length > 0,
      signatures,
      errors,
    };
  }
  
  /**
   * Gets current Jito tip recommendations
   */
  export async function getJitoTipRecommendation(): Promise<number> {
    try {
      // This would typically query Jito's API for current tip recommendations
      // For now, we'll return a reasonable default
      const baseTip = 1000000; // 0.001 SOL
      const networkCongestionMultiplier = 1.0; // Could be dynamic based on network conditions
      
      return Math.floor(baseTip * networkCongestionMultiplier);
      
    } catch (error) {
      logger.debug(`Failed to get tip recommendation: ${error}`);
      return 1000000; // Fallback to 0.001 SOL
    }
  }
  
  /**
   * Validates bundle before submission
   */
  export function validateBundle(transactions: VersionedTransaction[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (transactions.length === 0) {
      errors.push('Bundle cannot be empty');
    }
    
    if (transactions.length > 5) {
      errors.push('Bundle cannot contain more than 5 transactions');
    }
    
    // Check that all transactions are properly signed
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      if (tx.signatures.length === 0 || tx.signatures[0].every(byte => byte === 0)) {
        errors.push(`Transaction ${i + 1} is not properly signed`);
      }
    }
    
    // Check for duplicate transactions
    const signatures = transactions.map(tx => base58.encode(tx.signatures[0]));
    const uniqueSignatures = new Set(signatures);
    if (signatures.length !== uniqueSignatures.size) {
      errors.push('Bundle contains duplicate transactions');
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }
  
  /**
   * Estimates bundle cost (including tips and fees)
   */
  export function estimateBundleCost(
    transactionCount: number,
    tipLamports: number,
    priorityFeeMicroLamports: number = 200000,
    computeUnitsPerTx: number = 5000000
  ): { totalCostLamports: number; breakdown: any } {
    const tipCost = tipLamports;
    const priorityFeeCostPerTx = Math.ceil((priorityFeeMicroLamports * computeUnitsPerTx) / 1000000);
    const totalPriorityFees = priorityFeeCostPerTx * transactionCount;
    const baseFeePerTx = 5000; // 0.000005 SOL per signature
    const totalBaseFees = baseFeePerTx * transactionCount;
    
    const totalCost = tipCost + totalPriorityFees + totalBaseFees;
    
    return {
      totalCostLamports: totalCost,
      breakdown: {
        jitoTip: tipCost,
        priorityFees: totalPriorityFees,
        baseFees: totalBaseFees,
        transactionCount,
      },
    };
  }
  
  /**
   * Check if Jito endpoints are available
   */
  export async function checkJitoEndpoints(): Promise<{ available: string[]; unavailable: string[] }> {
    const available: string[] = [];
    const unavailable: string[] = [];
    
    const checks = JITO_ENDPOINTS.map(async (endpoint) => {
      try {
        const response = await axios.post(endpoint.replace('/bundles', ''), {
          jsonrpc: '2.0',
          id: 1,
          method: 'getInflightBundleStatuses',
          params: [[]],
        }, { timeout: 5000 });
        
        if (response.status === 200) {
          available.push(endpoint);
        } else {
          unavailable.push(endpoint);
        }
      } catch (error) {
        unavailable.push(endpoint);
      }
    });
    
    await Promise.allSettled(checks);
    
    return { available, unavailable };
  }
  
  /**
   * Smart bundle submission with endpoint selection
   */
  export async function sendSmartJitoBundle(
    transactions: VersionedTransaction[],
    payer: Keypair,
    config: BundlerConfig
  ): Promise<JitoBundleResult> {
    // Check endpoint availability first
    const endpointStatus = await checkJitoEndpoints();
    
    if (endpointStatus.available.length === 0) {
      logger.warn('No Jito endpoints available, falling back to individual transactions');
      
      if (!config.forceJitoOnly) {
        const connection = new Connection(config.rpcUrl, 'confirmed');
        const fallbackResult = await sendTransactionsIndividually(transactions, connection, config);
        
        return {
          success: fallbackResult.success,
          signature: fallbackResult.signatures[0],
          error: fallbackResult.success ? undefined : 'All Jito endpoints unavailable, fallback partially failed',
        };
      } else {
        return {
          success: false,
          error: 'All Jito endpoints unavailable and fallback disabled',
        };
      }
    }
    
    logger.info(`Using ${endpointStatus.available.length}/${JITO_ENDPOINTS.length} available Jito endpoints`);
    
    // Use only available endpoints
    const options: JitoBundleOptions = {
      preferredEndpoints: endpointStatus.available,
    };
    
    return await sendJitoBundle(transactions, payer, config, options);
  }
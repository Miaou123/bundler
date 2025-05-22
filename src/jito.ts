import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
  } from '@solana/web3.js';
  import axios, { AxiosError } from 'axios';
  import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
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
   * Validates a transaction before adding to bundle
   */
  function validateTransaction(tx: VersionedTransaction, index: number): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    try {
      // Check if transaction is properly signed
      if (tx.signatures.length === 0) {
        errors.push(`Transaction ${index} has no signatures`);
      }
      
      // Check if signature is not all zeros
      if (tx.signatures[0] && tx.signatures[0].every(byte => byte === 0)) {
        errors.push(`Transaction ${index} has invalid signature (all zeros)`);
      }
      
      // Check transaction size
      const serialized = tx.serialize();
      if (serialized.length > 1232) { // Solana transaction size limit
        errors.push(`Transaction ${index} too large: ${serialized.length} bytes (max 1232)`);
      }
      
      // Check if message is valid
      if (!tx.message) {
        errors.push(`Transaction ${index} has no message`);
      }
      
      logger.debug(`   TX ${index}: ${serialized.length} bytes, ${tx.signatures.length} signatures`);
      
    } catch (error) {
      errors.push(`Transaction ${index} validation error: ${error}`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
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
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    
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
    
    // Validate tip transaction
    const validation = validateTransaction(tipTx, 0);
    if (!validation.valid) {
      throw new Error(`Tip transaction validation failed: ${validation.errors.join(', ')}`);
    }
    
    logger.debug(`✅ Tip transaction created and validated`);
    logger.debug(`   Blockhash: ${blockhash}`);
    logger.debug(`   Last valid block height: ${lastValidBlockHeight}`);
    
    return tipTx;
  }
  
  /**
   * Submits a bundle to Jito block engines with detailed logging
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
    
    logger.info(`📦 Submitting bundle to ${endpoints.length} endpoints`);
    logger.debug(`📊 Bundle details:`);
    logger.debug(`   Transactions: ${serializedTransactions.length}`);
    logger.debug(`   Total bundle size: ${JSON.stringify(bundleData).length} bytes`);
    logger.debug(`   Timeout: ${timeoutMs}ms`);
    
    // Log first few chars of each transaction for debugging
    serializedTransactions.forEach((tx, index) => {
      logger.debug(`   TX ${index}: ${tx.substring(0, 20)}... (${tx.length} chars)`);
    });
    
    const requests = endpoints.map(async (url, index) => {
      const startTime = Date.now();
      
      try {
        logger.debug(`🚀 Submitting to endpoint ${index + 1}: ${url}`);
        
        const response = await axios.post(url, bundleData, {
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Solana-Bundle-Client/1.0',
          },
          validateStatus: () => true, // Don't throw on HTTP errors
        });
        
        const duration = Date.now() - startTime;
        
        logger.debug(`📤 Response from ${url}: ${response.status} in ${duration}ms`);
        
        if (response.status === 200) {
          logger.debug(`✅ Success response:`, response.data);
          return { success: true, data: response.data, endpoint: url, duration };
        } else {
          // Log the full error response for debugging
          logger.warn(`❌ HTTP ${response.status} from ${url}:`);
          logger.warn(`   Status text: ${response.statusText}`);
          logger.warn(`   Response data:`, response.data);
          
          if (response.data && typeof response.data === 'object') {
            if (response.data.error) {
              logger.warn(`   Error details:`, response.data.error);
            }
            if (response.data.message) {
              logger.warn(`   Message: ${response.data.message}`);
            }
          }
          
          return { 
            success: false, 
            error: `HTTP ${response.status}: ${response.statusText}`, 
            endpoint: url,
            responseData: response.data,
            duration 
          };
        }
        
      } catch (error) {
        const duration = Date.now() - startTime;
        
        if (error instanceof AxiosError) {
          logger.warn(`❌ Network error to ${url}:`);
          
          if (error.response) {
            logger.warn(`   HTTP ${error.response.status}: ${error.response.statusText}`);
            logger.warn(`   Response data:`, error.response.data);
            
            return { 
              success: false, 
              error: `HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`, 
              endpoint: url,
              responseData: error.response.data,
              duration 
            };
          } else if (error.request) {
            logger.warn(`   No response received (timeout/network)`);
            return { 
              success: false, 
              error: 'Network timeout or connection failed', 
              endpoint: url,
              duration 
            };
          } else {
            logger.warn(`   Request setup error: ${error.message}`);
            return { 
              success: false, 
              error: error.message, 
              endpoint: url,
              duration 
            };
          }
        }
        
        logger.warn(`❌ Unknown error to ${url}: ${error}`);
        return { 
          success: false, 
          error: String(error), 
          endpoint: url,
          duration 
        };
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
    
    // Log detailed summary
    logger.info(`📊 Bundle submission summary:`);
    logger.info(`   Successful: ${successful.length}/${endpoints.length}`);
    logger.info(`   Failed: ${failed.length}/${endpoints.length}`);
    
    if (failed.length > 0) {
      logger.warn(`❌ Failure details:`);
      failed.forEach((failure, index) => {
        logger.warn(`   ${index + 1}. ${failure.endpoint}: ${failure.error}`);
        if (failure.responseData) {
          logger.warn(`      Response:`, failure.responseData);
        }
      });
    }
    
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
    logger.debug(`👀 Monitoring bundle confirmation for tip: ${tipSignature}`);
    
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    let checkCount = 0;
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        checkCount++;
        const status = await connection.getSignatureStatus(tipSignature);
        
        logger.debug(`   Check ${checkCount}: ${status.value ? 'Found' : 'Not found'}`);
        
        if (status.value) {
          if (status.value.err) {
            logger.warn(`❌ Bundle transaction failed:`, status.value.err);
            return false;
          }
          
          if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
            logger.info(`✅ Bundle confirmed! Status: ${status.value.confirmationStatus}`);
            logger.info(`   Slot: ${status.value.slot}`);
            return true;
          }
          
          logger.debug(`   Status: ${status.value.confirmationStatus}, Slot: ${status.value.slot}`);
        }
        
        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        logger.debug(`⚠️  Error checking bundle status: ${error}`);
      }
    }
    
    logger.warn(`⏰ Bundle confirmation timed out after ${timeoutSeconds}s (${checkCount} checks)`);
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
    
    // Validate all transactions before proceeding
    logger.debug(`🔍 Validating ${transactions.length} transactions...`);
    let hasValidationErrors = false;
    
    for (let i = 0; i < transactions.length; i++) {
      const validation = validateTransaction(transactions[i], i + 1);
      if (!validation.valid) {
        logger.error(`❌ Transaction ${i + 1} validation failed:`);
        validation.errors.forEach(error => logger.error(`   ${error}`));
        hasValidationErrors = true;
      }
    }
    
    if (hasValidationErrors) {
      return {
        success: false,
        error: 'Transaction validation failed - check logs above',
        attempts: 0,
      };
    }
    
    let lastError: string = '';
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🎯 Bundle attempt ${attempt}/${maxRetries}`);
        
        // Create tip transaction
        const connection = new Connection(config.rpcUrl, 'confirmed');
        const tipTx = await createTipTransaction(connection, payer, tipLamports);
        const tipSignature = bs58.encode(tipTx.signatures[0]);
        
        logger.debug(`💰 Tip signature: ${tipSignature}`);
        
        // Serialize all transactions
        const serializedTxs = [
          bs58.encode(tipTx.serialize()),
          ...transactions.map((tx, index) => {
            const serialized = bs58.encode(tx.serialize());
            logger.debug(`📦 Transaction ${index + 1} serialized: ${serialized.length} chars`);
            return serialized;
          })
        ];
        
        logger.info(`📦 Bundle contains ${serializedTxs.length} transactions (including tip)`);
        
        // Submit bundle
        const submissionResult = await submitBundle(
          serializedTxs,
          preferredEndpoints,
          timeoutSeconds * 1000
        );
        
        if (!submissionResult.success) {
          const errorMessages = submissionResult.errors.map(e => `${e.endpoint}: ${e.error}`).join('; ');
          lastError = `Bundle submission failed to all endpoints: ${errorMessages}`;
          logger.warn(`❌ Attempt ${attempt} failed: ${lastError}`);
          
          // Log detailed error analysis
          const errorTypes: { [key: string]: number } = {};
          submissionResult.errors.forEach(error => {
            const errorType = error.error.split(':')[0];
            errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
          });
          
          logger.warn(`📊 Error analysis:`, errorTypes);
          
          if (attempt < maxRetries) {
            const waitTime = attempt * 2000; // Exponential backoff
            logger.debug(`⏳ Waiting ${waitTime}ms before retry...`);
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
          logger.warn(`⏰ Attempt ${attempt} failed: ${lastError}`);
        }
        
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`💥 Attempt ${attempt} failed with error: ${lastError}`);
        
        if (error instanceof Error && error.stack) {
          logger.debug(`Stack trace:`, error.stack);
        }
      }
      
      // Wait before retry (except on last attempt)
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000; // 2s, 4s, 6s...
        logger.debug(`⏳ Waiting ${waitTime}ms before retry...`);
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
  
  export { validateTransaction };

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
 * Check if Jito endpoints are available - FIXED VERSION
 */
export async function checkJitoEndpoints(): Promise<{ available: string[]; unavailable: string[] }> {
    const available: string[] = [];
    const unavailable: string[] = [];
    
    console.log('🔍 Testing Jito endpoints...');
    
    const checks = JITO_ENDPOINTS.map(async (endpoint, index) => {
      console.log(`Testing endpoint ${index + 1}: ${endpoint}`);
      
      try {
        // ✅ FIXED: Use the full endpoint URL, don't remove /bundles
        const response = await axios.post(endpoint, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getInflightBundleStatuses',
          params: [[]], // Empty array is fine - we just want to test connectivity
        }, { timeout: 5000 });
        
        console.log(`Response from endpoint ${index + 1}:`, response.status);
        
        // ✅ FIXED: Any valid JSON-RPC response means the endpoint works
        if (response.status === 200 && 
            response.data && 
            response.data.jsonrpc === '2.0') {
          // Even if there's an "error" about empty bundle list, the endpoint is working
          console.log(`✅ Endpoint ${index + 1} is available`);
          available.push(endpoint);
        } else {
          console.log(`❌ Endpoint ${index + 1} unexpected response`);
          unavailable.push(endpoint);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`❌ Endpoint ${index + 1} failed:`, errorMessage);
        unavailable.push(endpoint);
      }
    });
    
    await Promise.allSettled(checks);
    
    console.log(`📊 Jito endpoint check results:`);
    console.log(`   Available: ${available.length}/${JITO_ENDPOINTS.length}`);
    console.log(`   Unavailable: ${unavailable.length}/${JITO_ENDPOINTS.length}`);
    
    if (available.length > 0) {
      console.log(`✅ Using ${available.length} available Jito endpoints`);
    } else {
      console.log(`❌ No Jito endpoints available - will fallback to individual transactions`);
    }
    
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
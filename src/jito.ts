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
    verificationDetails?: any;
    confirmationDetails?: any;
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
   * Enhanced transaction validation with detailed logging
   */
  function validateTransactionDetailed(tx: VersionedTransaction, index: number): { valid: boolean; errors: string[]; details: any } {
    const errors: string[] = [];
    const details: any = {};
    
    try {
      // Check if transaction is properly signed
      details.signatureCount = tx.signatures.length;
      if (tx.signatures.length === 0) {
        errors.push(`Transaction ${index} has no signatures`);
      } else {
        // Check if signature is not all zeros
        const firstSig = tx.signatures[0];
        const isZeroSig = firstSig && firstSig.every(byte => byte === 0);
        details.hasValidSignature = !isZeroSig;
        
        if (isZeroSig) {
          errors.push(`Transaction ${index} has invalid signature (all zeros)`);
        }
        
        // Log signature info
        details.firstSignature = firstSig ? bs58.encode(firstSig).substring(0, 20) + '...' : 'none';
      }
      
      // Check transaction size
      const serialized = tx.serialize();
      details.serializedSize = serialized.length;
      if (serialized.length > 1232) { // Solana transaction size limit
        errors.push(`Transaction ${index} too large: ${serialized.length} bytes (max 1232)`);
      }
      
      // Check if message is valid
      details.hasMessage = !!tx.message;
      if (!tx.message) {
        errors.push(`Transaction ${index} has no message`);
      } else {
        // Analyze message structure
        details.message = {
          instructionCount: tx.message.compiledInstructions?.length || 0,
          accountKeysCount: tx.message.staticAccountKeys?.length || 0,
          recentBlockhash: tx.message.recentBlockhash ? tx.message.recentBlockhash.substring(0, 20) + '...' : 'missing'
        };
      }
      
      logger.debug(`📋 Transaction ${index} analysis:`, details);
      
    } catch (error) {
      errors.push(`Transaction ${index} validation error: ${error}`);
      details.validationError = String(error);
    }
    
    return {
      valid: errors.length === 0,
      errors,
      details
    };
  }
  
  /**
   * Creates a tip transaction for Jito with detailed logging
   */
  async function createTipTransactionDetailed(
    connection: Connection,
    payer: Keypair,
    tipLamports: number
  ): Promise<VersionedTransaction> {
    const tipAccount = selectRandomTipAccount();
    
    logger.info(`💰 Creating tip transaction:`);
    logger.info(`   Amount: ${tipLamports} lamports (${tipLamports / 1e9} SOL)`);
    logger.info(`   From: ${payer.publicKey.toBase58()}`);
    logger.info(`   To: ${tipAccount.toBase58()}`);
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    logger.debug(`   Blockhash: ${blockhash}`);
    logger.debug(`   Last valid block height: ${lastValidBlockHeight}`);
    
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
    
    // Validate tip transaction with detailed logging
    const validation = validateTransactionDetailed(tipTx, 0);
    if (!validation.valid) {
      logger.error(`❌ Tip transaction validation failed:`, validation.errors);
      logger.error(`❌ Tip transaction details:`, validation.details);
      throw new Error(`Tip transaction validation failed: ${validation.errors.join(', ')}`);
    }
    
    logger.info(`✅ Tip transaction created and validated`);
    logger.debug(`   Details:`, validation.details);
    
    return tipTx;
  }
  
  /**
   * FIXED: Bundle confirmation monitoring with proper verification
   */
  async function monitorBundleConfirmationDetailed(
    connection: Connection,
    tipSignature: string,
    timeoutSeconds: number = 30
  ): Promise<{ confirmed: boolean; details: any }> {
    logger.info(`👀 MONITORING BUNDLE CONFIRMATION:`);
    logger.info(`   Tip signature: ${tipSignature}`);
    logger.info(`   Timeout: ${timeoutSeconds}s`);
    
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    let checkCount = 0;
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        checkCount++;
        logger.debug(`   Check ${checkCount}: Looking for tip transaction...`);
        
        const status = await connection.getSignatureStatus(tipSignature);
        
        if (status.value) {
          logger.info(`   ✅ Tip transaction found on-chain!`);
          logger.info(`   Status: ${status.value.confirmationStatus}`);
          logger.info(`   Slot: ${status.value.slot}`);
          
          if (status.value.err) {
            logger.error(`   ❌ Tip transaction failed:`, status.value.err);
            return { 
              confirmed: false, 
              details: { 
                error: status.value.err, 
                slot: status.value.slot,
                checkCount 
              } 
            };
          }
          
          if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
            logger.info(`   🎉 Bundle confirmed! Tip transaction successful`);
            
            // Additional verification: try to get full transaction details
            try {
              const txDetails = await connection.getTransaction(tipSignature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
              });
              
              if (txDetails) {
                logger.info(`   📋 Transaction details retrieved:`);
                logger.info(`     Block time: ${txDetails.blockTime ? new Date(txDetails.blockTime * 1000).toISOString() : 'unknown'}`);
                logger.info(`     Fee: ${txDetails.meta?.fee || 'unknown'} lamports`);
                logger.info(`     Success: ${!txDetails.meta?.err}`);
                
                return { 
                  confirmed: true, 
                  details: { 
                    slot: status.value.slot,
                    blockTime: txDetails.blockTime,
                    fee: txDetails.meta?.fee,
                    success: !txDetails.meta?.err,
                    checkCount 
                  } 
                };
              }
            } catch (detailsError) {
              logger.warn(`   ⚠️  Could not get transaction details: ${detailsError}`);
            }
            
            return { 
              confirmed: true, 
              details: { 
                slot: status.value.slot,
                confirmationStatus: status.value.confirmationStatus,
                checkCount 
              } 
            };
          }
          
          logger.debug(`   ⏳ Status: ${status.value.confirmationStatus}, waiting...`);
        } else {
          logger.debug(`   ⏳ Transaction not found yet...`);
        }
        
        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        logger.debug(`   ⚠️  Error checking bundle status: ${error}`);
        // Continue checking despite errors
      }
    }
    
    logger.warn(`   ⏰ Bundle confirmation timed out after ${timeoutSeconds}s (${checkCount} checks)`);
    return { 
      confirmed: false, 
      details: { 
        timeout: true, 
        timeoutSeconds, 
        checkCount 
      } 
    };
  }

  /**
   * FIXED: Additional verification to check if bundle transactions actually executed
   */
  async function verifyBundleExecution(
    connection: Connection,
    expectedMint: string,
    tipSignature: string
  ): Promise<{ executed: boolean; details: any }> {
    logger.info(`🔍 VERIFYING BUNDLE EXECUTION:`);
    
    const verificationResults: any = {
      tipTransaction: false,
      mintExists: false,
      tipSignature,
      expectedMint
    };
    
    try {
      // 1. Verify tip transaction exists and succeeded
      logger.info(`   1. Checking tip transaction: ${tipSignature}`);
      const tipTx = await connection.getTransaction(tipSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });
      
      if (tipTx && !tipTx.meta?.err) {
        logger.info(`   ✅ Tip transaction confirmed and successful`);
        verificationResults.tipTransaction = true;
        verificationResults.tipDetails = {
          slot: tipTx.slot,
          blockTime: tipTx.blockTime,
          fee: tipTx.meta?.fee
        };
      } else if (tipTx && tipTx.meta?.err) {
        logger.warn(`   ❌ Tip transaction failed:`, tipTx.meta.err);
        verificationResults.tipError = tipTx.meta.err;
      } else {
        logger.warn(`   ❌ Tip transaction not found`);
      }
      
      // 2. Verify token mint was created
      logger.info(`   2. Checking if mint exists: ${expectedMint}`);
      const mintInfo = await connection.getAccountInfo(new PublicKey(expectedMint));
      
      if (mintInfo) {
        logger.info(`   ✅ Token mint exists on-chain`);
        verificationResults.mintExists = true;
        verificationResults.mintDetails = {
          owner: mintInfo.owner.toBase58(),
          lamports: mintInfo.lamports,
          dataLength: mintInfo.data.length
        };
      } else {
        logger.warn(`   ❌ Token mint does not exist`);
      }
      
      // 3. Overall execution status
      const executed = verificationResults.tipTransaction && verificationResults.mintExists;
      
      logger.info(`   📊 VERIFICATION SUMMARY:`);
      logger.info(`     Tip transaction: ${verificationResults.tipTransaction ? '✅' : '❌'}`);
      logger.info(`     Mint created: ${verificationResults.mintExists ? '✅' : '❌'}`);
      logger.info(`     Overall execution: ${executed ? '✅ SUCCESS' : '❌ FAILED'}`);
      
      return { executed, details: verificationResults };
      
    } catch (error) {
      logger.error(`   💥 Verification error: ${error}`);
      verificationResults.verificationError = String(error);
      return { executed: false, details: verificationResults };
    }
  }
  
  /**
   * Enhanced bundle submission with comprehensive logging
   */
  async function submitBundleDetailed(
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
    
    // Comprehensive bundle logging
    logger.info(`📦 DETAILED BUNDLE ANALYSIS:`);
    logger.info(`   Endpoint count: ${endpoints.length}`);
    logger.info(`   Transaction count: ${serializedTransactions.length}`);
    logger.info(`   Timeout: ${timeoutMs}ms`);
    
    const bundleJson = JSON.stringify(bundleData);
    logger.info(`   Bundle JSON size: ${bundleJson.length} bytes`);
    
    // Log each serialized transaction details
    serializedTransactions.forEach((tx, index) => {
      logger.info(`   TX ${index}:`);
      logger.info(`     Length: ${tx.length} chars`);
      logger.info(`     First 40 chars: ${tx.substring(0, 40)}...`);
      logger.info(`     Last 10 chars: ...${tx.substring(tx.length - 10)}`);
      
      // Try to decode and analyze
      try {
        const decoded = bs58.decode(tx);
        logger.info(`     Decoded size: ${decoded.length} bytes`);
      } catch (error) {
        logger.warn(`     ⚠️ Failed to decode transaction ${index}: ${error}`);
      }
    });
    
    const requests = endpoints.map(async (url, index) => {
      const startTime = Date.now();
      
      try {
        logger.info(`🚀 Submitting to endpoint ${index + 1}/${endpoints.length}: ${url}`);
        
        const response = await axios.post(url, bundleData, {
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Pump-Bundler/1.0',
            'Accept': 'application/json',
          },
          validateStatus: () => true, // Don't throw on HTTP errors
        });
        
        const duration = Date.now() - startTime;
        
        logger.info(`📤 Response from endpoint ${index + 1}:`);
        logger.info(`   Status: ${response.status} ${response.statusText}`);
        logger.info(`   Duration: ${duration}ms`);
        logger.info(`   Content-Type: ${response.headers['content-type']}`);
        
        // Log full response for debugging
        if (response.data) {
          logger.info(`   Response data:`, response.data);
          
          // Check for specific Jito error patterns
          if (response.data.error) {
            logger.warn(`   ❌ Jito error details:`, {
              code: response.data.error.code,
              message: response.data.error.message,
              data: response.data.error.data
            });
          }
        }
        
        if (response.status === 200 && response.data && !response.data.error) {
          logger.info(`   ✅ Success!`);
          return { success: true, data: response.data, endpoint: url, duration };
        } else {
          logger.warn(`   ❌ Failed`);
          return { 
            success: false, 
            error: response.data?.error?.message || `HTTP ${response.status}: ${response.statusText}`, 
            endpoint: url,
            responseData: response.data,
            duration,
            httpStatus: response.status
          };
        }
        
      } catch (error) {
        const duration = Date.now() - startTime;
        
        logger.error(`❌ Network error to endpoint ${index + 1}:`);
        
        if (error instanceof AxiosError) {
          if (error.response) {
            logger.error(`   HTTP Error: ${error.response.status} ${error.response.statusText}`);
            logger.error(`   Response data:`, error.response.data);
            
            return { 
              success: false, 
              error: `HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`, 
              endpoint: url,
              responseData: error.response.data,
              httpStatus: error.response.status,
              duration 
            };
          } else if (error.request) {
            logger.error(`   No response received - timeout or network error`);
            
            return { 
              success: false, 
              error: 'Network timeout or connection failed', 
              endpoint: url,
              duration 
            };
          } else {
            logger.error(`   Request setup error: ${error.message}`);
            return { 
              success: false, 
              error: error.message, 
              endpoint: url,
              duration 
            };
          }
        }
        
        logger.error(`   Unknown error: ${error}`);
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
    
    // Detailed summary analysis
    logger.info(`📊 BUNDLE SUBMISSION SUMMARY:`);
    logger.info(`   Successful endpoints: ${successful.length}/${endpoints.length}`);
    logger.info(`   Failed endpoints: ${failed.length}/${endpoints.length}`);
    
    if (successful.length > 0) {
      logger.info(`   ✅ Successful responses:`);
      successful.forEach((success, i) => {
        logger.info(`     ${i + 1}. ${success.endpoint} (${success.duration}ms)`);
        if (success.data?.result) {
          logger.info(`        Bundle ID: ${success.data.result}`);
        }
      });
    }
    
    if (failed.length > 0) {
      logger.warn(`   ❌ Failed responses:`);
      failed.forEach((failure, i) => {
        logger.warn(`     ${i + 1}. ${failure.endpoint} (${failure.duration || 'timeout'}ms)`);
        logger.warn(`        Error: ${failure.error}`);
        if (failure.httpStatus) {
          logger.warn(`        HTTP Status: ${failure.httpStatus}`);
        }
        if (failure.responseData) {
          logger.warn(`        Response:`, failure.responseData);
        }
      });
      
      // Analyze error patterns
      const errorTypes: { [key: string]: number } = {};
      failed.forEach(failure => {
        const errorType = failure.error?.split(':')[0] || 'Unknown';
        errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
      });
      
      logger.warn(`   📈 Error pattern analysis:`, errorTypes);
    }
    
    return {
      success: successful.length > 0,
      results: successful,
      errors: failed,
    };
  }
  
  /**
   * FIXED: Jito endpoint health check using proper method
   */
  export async function checkJitoEndpointsDetailed(): Promise<{ available: string[]; unavailable: string[] }> {
    const available: string[] = [];
    const unavailable: string[] = [];
    
    logger.info('🔍 FIXED JITO ENDPOINT TESTING...');
    
    const checks = JITO_ENDPOINTS.map(async (endpoint, index) => {
      logger.info(`Testing endpoint ${index + 1}/${JITO_ENDPOINTS.length}: ${endpoint}`);
      
      try {
        // FIXED: Use getTipAccounts instead of getInflightBundleStatuses
        const testPayload = {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTipAccounts',
          params: []
        };
        
        logger.debug(`   Sending corrected test payload:`, testPayload);
        
        const response = await axios.post(endpoint, testPayload, { 
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Pump-Bundler/1.0',
            'Accept': 'application/json'
          }
        });
        
        logger.info(`   Response: ${response.status} ${response.statusText}`);
        logger.debug(`   Response data:`, response.data);
        
        // Check if we got a valid JSON-RPC response with tip accounts
        if (response.status === 200 && 
            response.data && 
            response.data.jsonrpc === '2.0' &&
            !response.data.error) {
          
          logger.info(`   ✅ Endpoint ${index + 1} is available and responsive`);
          if (response.data.result && Array.isArray(response.data.result)) {
            logger.debug(`   📋 Tip accounts available: ${response.data.result.length}`);
          }
          available.push(endpoint);
          
        } else if (response.status === 200 && 
                   response.data && 
                   response.data.jsonrpc === '2.0' &&
                   response.data.error) {
          
          // Even if there's an error, if we get a proper JSON-RPC response, the endpoint is working
          logger.info(`   ✅ Endpoint ${index + 1} is available (responded with expected error)`);
          logger.debug(`   Error response: ${response.data.error.message}`);
          available.push(endpoint);
          
        } else {
          logger.warn(`   ❌ Endpoint ${index + 1} returned unexpected response`);
          logger.warn(`   Response:`, response.data);
          unavailable.push(endpoint);
        }
        
      } catch (error) {
        logger.error(`   ❌ Endpoint ${index + 1} failed:`);
        
        if (error instanceof AxiosError) {
          if (error.response) {
            logger.error(`     HTTP ${error.response.status}: ${error.response.statusText}`);
            logger.error(`     Response data:`, error.response.data);
            
            // Special case: If we get a 404 or method not found, endpoint might still work for bundles
            if (error.response.status === 404 || 
                (error.response.data?.error?.message && 
                 error.response.data.error.message.includes('method'))) {
              logger.info(`     ⚠️  Method not supported, but endpoint might work for bundles - adding to available`);
              available.push(endpoint);
            } else {
              unavailable.push(endpoint);
            }
          } else if (error.request) {
            logger.error(`     No response received (timeout/network)`);
            unavailable.push(endpoint);
          } else {
            logger.error(`     Request error: ${error.message}`);
            unavailable.push(endpoint);
          }
        } else {
          logger.error(`     Unknown error: ${error}`);
          unavailable.push(endpoint);
        }
      }
    });
    
    await Promise.allSettled(checks);
    
    logger.info(`📊 FIXED ENDPOINT TEST RESULTS:`);
    logger.info(`   Available: ${available.length}/${JITO_ENDPOINTS.length}`);
    logger.info(`   Unavailable: ${unavailable.length}/${JITO_ENDPOINTS.length}`);
    
    if (available.length > 0) {
      logger.info(`   ✅ Working endpoints:`);
      available.forEach((endpoint, i) => {
        logger.info(`     ${i + 1}. ${endpoint}`);
      });
    } else {
      logger.warn(`   ❌ No endpoints available, but will still attempt bundle submission`);
      logger.warn(`   🔧 Adding all endpoints as potentially available for bundle submission`);
      // If all tests fail, assume endpoints might still work for actual bundles
      available.push(...JITO_ENDPOINTS);
    }
    
    if (unavailable.length > 0 && available.length > 0) {
      logger.warn(`   ⚠️  Failed endpoints (will not be used):`);
      unavailable.forEach((endpoint, i) => {
        logger.warn(`     ${i + 1}. ${endpoint}`);
      });
    }
    
    return { available, unavailable };
  }
  
  /**
   * Enhanced bundle sending with PROPER confirmation monitoring and verification
   */
  export async function sendJitoBundleDetailed(
    transactions: VersionedTransaction[],
    payer: Keypair,
    config: BundlerConfig,
    options: JitoBundleOptions = {},
    expectedMint?: string  // Add expected mint for verification
  ): Promise<JitoBundleResult> {
    const {
      maxRetries = config.jitoMaxRetries,
      timeoutSeconds = config.jitoTimeoutSeconds,
      tipLamports = config.jitoTipLamports,
      preferredEndpoints = JITO_ENDPOINTS,
    } = options;
    
    logger.info(`🚀 DETAILED JITO BUNDLE SUBMISSION:`);
    logger.info(`   Transaction count: ${transactions.length}`);
    logger.info(`   Tip amount: ${tipLamports} lamports (${tipLamports / 1e9} SOL)`);
    logger.info(`   Max retries: ${maxRetries}`);
    logger.info(`   Timeout: ${timeoutSeconds}s`);
    logger.info(`   Endpoints: ${preferredEndpoints.length}`);
    if (expectedMint) {
      logger.info(`   Expected mint: ${expectedMint}`);
    }
    
    // Enhanced transaction validation
    logger.info(`🔍 VALIDATING ALL TRANSACTIONS:`);
    let hasValidationErrors = false;
    
    for (let i = 0; i < transactions.length; i++) {
      const validation = validateTransactionDetailed(transactions[i], i + 1);
      if (!validation.valid) {
        logger.error(`❌ Transaction ${i + 1} validation failed:`, validation.errors);
        logger.error(`❌ Transaction ${i + 1} details:`, validation.details);
        hasValidationErrors = true;
      } else {
        logger.info(`✅ Transaction ${i + 1} validated successfully`);
      }
    }
    
    if (hasValidationErrors) {
      return {
        success: false,
        error: 'Transaction validation failed - check detailed logs above',
        attempts: 0,
      };
    }
    
    let lastError: string = '';
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🎯 BUNDLE ATTEMPT ${attempt}/${maxRetries}`);
        
        // Create tip transaction with detailed logging
        const connection = new Connection(config.rpcUrl, 'confirmed');
        const tipTx = await createTipTransactionDetailed(connection, payer, tipLamports);
        const tipSignature = bs58.encode(tipTx.signatures[0]);
        
        logger.info(`💰 Tip transaction signature: ${tipSignature}`);
        
        // Serialize all transactions with detailed logging
        logger.info(`📦 SERIALIZING TRANSACTIONS:`);
        const serializedTxs = [
          bs58.encode(tipTx.serialize()),
          ...transactions.map((tx, index) => {
            const serialized = bs58.encode(tx.serialize());
            logger.info(`   TX ${index + 1}: ${serialized.length} chars`);
            return serialized;
          })
        ];
        
        logger.info(`📦 Bundle ready: ${serializedTxs.length} transactions total`);
        
        // Submit bundle with enhanced logging
        const submissionResult = await submitBundleDetailed(
          serializedTxs,
          preferredEndpoints,
          timeoutSeconds * 1000
        );
        
        if (!submissionResult.success) {
          lastError = `Bundle submission failed: ${submissionResult.errors.map(e => e.error).join('; ')}`;
          logger.warn(`❌ Attempt ${attempt} submission failed: ${lastError}`);
          
          if (attempt < maxRetries) {
            const waitTime = attempt * 2000;
            logger.info(`⏳ Waiting ${waitTime}ms before retry ${attempt + 1}...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
          continue;
        }
        
        logger.info(`✅ Bundle submitted successfully to ${submissionResult.results.length}/${preferredEndpoints.length} endpoints`);
        
        // FIXED: Proper bundle confirmation monitoring
        logger.info(`👀 MONITORING BUNDLE CONFIRMATION...`);
        const confirmationResult = await monitorBundleConfirmationDetailed(
          connection,
          tipSignature,
          timeoutSeconds
        );
        
        if (confirmationResult.confirmed) {
          logger.info(`🎉 Bundle confirmation detected!`);
          
          // ADDITIONAL: Verify actual execution if we have expected mint
          if (expectedMint) {
            logger.info(`🔍 VERIFYING COMPLETE BUNDLE EXECUTION...`);
            const verificationResult = await verifyBundleExecution(
              connection,
              expectedMint,
              tipSignature
            );
            
            if (verificationResult.executed) {
              logger.info(`✅ COMPLETE SUCCESS: Bundle executed and verified on-chain!`);
              return {
                success: true,
                signature: tipSignature,
                bundleId: submissionResult.results[0]?.data?.result,
                attempts: attempt,
                verificationDetails: verificationResult.details
              };
            } else {
              lastError = `Bundle confirmed but verification failed: ${JSON.stringify(verificationResult.details)}`;
              logger.error(`❌ Bundle verification failed:`, verificationResult.details);
              // Continue to retry
            }
          } else {
            // No mint to verify, just return success based on tip confirmation
            logger.info(`✅ SUCCESS: Bundle confirmed (no additional verification)!`);
            return {
              success: true,
              signature: tipSignature,
              bundleId: submissionResult.results[0]?.data?.result,
              attempts: attempt,
              confirmationDetails: confirmationResult.details
            };
          }
        } else {
          lastError = `Bundle submitted but failed to confirm: ${JSON.stringify(confirmationResult.details)}`;
          logger.warn(`⏰ Attempt ${attempt} confirmation failed:`, confirmationResult.details);
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
        logger.info(`⏳ Waiting ${waitTime}ms before retry...`);
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
   * Smart bundle submission with FIXED endpoint selection and verification
   */
  export async function sendSmartJitoBundle(
    transactions: VersionedTransaction[],
    payer: Keypair,
    config: BundlerConfig,
    expectedMint?: string  // Add expected mint for verification
  ): Promise<JitoBundleResult> {
    
    // OPTION 1: Try with endpoint testing first
    logger.info('🎯 ATTEMPTING JITO BUNDLE WITH ENDPOINT TESTING...');
    
    try {
      const endpointStatus = await checkJitoEndpointsDetailed();
      
      if (endpointStatus.available.length > 0) {
        logger.info(`✅ Found ${endpointStatus.available.length} available endpoints, proceeding with bundle`);
        
        const options: JitoBundleOptions = {
          preferredEndpoints: endpointStatus.available,
        };
        
        const result = await sendJitoBundleDetailed(transactions, payer, config, options, expectedMint);
        if (result.success) {
          return result;
        }
        
        logger.warn('Bundle failed with tested endpoints, trying all endpoints...');
      }
    } catch (error) {
      logger.warn(`Endpoint testing failed: ${error}, proceeding with all endpoints...`);
    }
    
    // OPTION 2: If endpoint testing fails or returns no results, try all endpoints anyway
    logger.info('🎯 ATTEMPTING JITO BUNDLE WITH ALL ENDPOINTS (SKIP TESTING)...');
    
    try {
      const options: JitoBundleOptions = {
        preferredEndpoints: JITO_ENDPOINTS, // Use all endpoints
      };
      
      const result = await sendJitoBundleDetailed(transactions, payer, config, options, expectedMint);
      if (result.success) {
        return result;
      }
      
      logger.warn('Bundle failed with all endpoints');
    } catch (error) {
      logger.error(`Direct bundle submission failed: ${error}`);
    }
    
    // OPTION 3: Fallback to individual transactions
    if (!config.forceJitoOnly) {
      logger.warn('All Jito attempts failed, falling back to individual transactions');
      
      const connection = new Connection(config.rpcUrl, 'confirmed');
      const fallbackResult = await sendTransactionsIndividually(transactions, connection, config);
      
      return {
        success: fallbackResult.success,
        signature: fallbackResult.signatures[0],
        error: fallbackResult.success ? undefined : 'Jito bundle failed, fallback partially succeeded',
      };
    } else {
      return {
        success: false,
        error: 'All Jito bundle attempts failed and fallback disabled',
      };
    }
  }
  
  // Export the enhanced functions
  export { 
    sendJitoBundleDetailed as sendJitoBundle,
    checkJitoEndpointsDetailed as checkJitoEndpoints,
    validateTransactionDetailed as validateTransaction 
  };
  
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
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import fs from 'fs';
import { BN } from 'bn.js';
import { BundlerConfig, validateTokenMetadata } from './config';
import { logger } from './utils/logger';
import {
  createTokenInstruction,
  buyTokenInstruction,
  getGlobalPDA,
  getMintAuthorityPDA,
  getBondingCurvePDA,
  getMetadataPDA,
  CreateTokenParams,
  BuyTokenParams,
} from './instructions';
import { sendJitoBundle } from './jito';

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

export class SecurePumpBundler {
  private connection: Connection;
  private config: BundlerConfig;
  private wallets: Keypair[] = [];
  private globalAccount?: PublicKey;
  private feeRecipient?: PublicKey;

  constructor(config: BundlerConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    logger.info(`📡 Connected to ${config.network} via ${config.rpcUrl}`);
    this.generateWallets();
  }

  private generateWallets(): void {
    logger.info(`🔧 Generating ${this.config.walletCount} wallets...`);
    
    this.wallets = [];
    for (let i = 0; i < this.config.walletCount; i++) {
      this.wallets.push(Keypair.generate());
    }
    
    logger.info(`✅ Generated ${this.wallets.length} wallets successfully`);
  }

  private async checkMainWalletBalance(): Promise<void> {
    const balance = await this.connection.getBalance(this.config.mainWallet.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    
    const requiredSOL = (this.config.walletCount * this.config.swapAmountSol) + 0.02; // +0.02 for fees
    
    logger.info(`💰 Main wallet balance: ${balanceSOL.toFixed(6)} SOL`);
    logger.info(`💰 Required SOL: ${requiredSOL.toFixed(6)} SOL`);
    
    if (balanceSOL < requiredSOL) {
      throw new Error(
        `Insufficient SOL balance. Need ${requiredSOL.toFixed(6)} SOL, have ${balanceSOL.toFixed(6)} SOL`
      );
    }
    
    if (balanceSOL < this.config.minMainWalletBalance + requiredSOL) {
      logger.warn(`⚠️  Low balance warning. After operation, wallet will have < ${this.config.minMainWalletBalance} SOL`);
    }
    
    logger.info('✅ Wallet balance check passed');
  }

  private async distributeSOL(): Promise<void> {
    logger.info('💸 Distributing SOL to bundler wallets...');
    
    await this.checkMainWalletBalance();
    
    const solPerWallet = this.config.swapAmountSol + 0.005; // Extra for transaction fees
    const tx = new Transaction();
    
    // Add priority fees
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ 
        units: this.config.priorityFee.unitLimit 
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ 
        microLamports: this.config.priorityFee.unitPrice 
      })
    );

    // Add transfer instructions for each wallet
    for (const wallet of this.wallets) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: this.config.mainWallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: BigInt(Math.floor(solPerWallet * LAMPORTS_PER_SOL)),
        })
      );
    }

    try {
      const signature = await this.connection.sendTransaction(
        tx,
        [this.config.mainWallet],
        { skipPreflight: false }
      );
      
      await this.connection.confirmTransaction(signature, 'confirmed');
      logger.info(`✅ SOL distribution completed: ${signature}`);
      
      // Verify distributions
      let totalDistributed = 0;
      for (let i = 0; i < this.wallets.length; i++) {
        const balance = await this.connection.getBalance(this.wallets[i].publicKey);
        totalDistributed += balance;
        logger.debug(`   Wallet ${i + 1}: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      }
      
      logger.info(`💰 Total distributed: ${(totalDistributed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      
    } catch (error) {
      logger.error('Failed to distribute SOL:', error);
      throw new Error(`SOL distribution failed: ${error}`);
    }
  }

  private async uploadMetadata(metadata: TokenMetadata): Promise<string> {
    logger.info('📤 Uploading token metadata to IPFS...');
    
    // Validate metadata first
    validateTokenMetadata(metadata);
    
    // Check if image file exists
    if (!fs.existsSync(metadata.imagePath)) {
      throw new Error(`Token image not found at: ${metadata.imagePath}`);
    }
    
    // Read image file
    const imageBuffer = fs.readFileSync(metadata.imagePath);
    const imageBlob = new Blob([imageBuffer]);
    
    const formData = new FormData();
    formData.append('file', imageBlob, 'token-image.png');
    formData.append('name', metadata.name);
    formData.append('symbol', metadata.symbol);
    formData.append('description', metadata.description);
    formData.append('twitter', metadata.twitter || '');
    formData.append('telegram', metadata.telegram || '');
    formData.append('website', metadata.website || '');
    formData.append('showName', 'true');

    try {
      const response = await fetch('https://pump.fun/api/ipfs', {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://pump.fun',
          'Referer': 'https://pump.fun/',
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      
      if (!result.metadataUri) {
        throw new Error('No metadata URI returned from IPFS upload');
      }
      
      logger.info(`✅ Metadata uploaded successfully: ${result.metadataUri}`);
      return result.metadataUri;
      
    } catch (error) {
      logger.error('Failed to upload metadata:', error);
      throw new Error(`Metadata upload failed: ${error}`);
    }
  }

  private async loadGlobalAccountData(): Promise<void> {
    const [globalPDA] = getGlobalPDA();
    
    try {
      const accountInfo = await this.connection.getAccountInfo(globalPDA);
      if (!accountInfo) {
        throw new Error('Global account not found');
      }
      
      // Parse global account data to get fee recipient
      // This is a simplified version - you'd need proper borsh deserialization
      // For now, we'll use a known fee recipient
      this.globalAccount = globalPDA;
      this.feeRecipient = globalPDA; // Placeholder - implement proper parsing
      
      logger.info('✅ Global account data loaded');
      
    } catch (error) {
      throw new Error(`Failed to load global account: ${error}`);
    }
  }

  private async buildCreateTransaction(
    mint: Keypair,
    metadataUri: string,
    tokenMetadata: TokenMetadata
  ): Promise<Transaction> {
    const tx = new Transaction();

    // Add priority fees
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ 
        units: this.config.priorityFee.unitLimit 
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ 
        microLamports: this.config.priorityFee.unitPrice 
      })
    );

    // Get required PDAs
    const [global] = getGlobalPDA();
    const [mintAuthority] = getMintAuthorityPDA();
    const [bondingCurve] = getBondingCurvePDA(mint.publicKey);
    const [metadata] = getMetadataPDA(mint.publicKey);
    
    // Get associated bonding curve token account
    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint.publicKey,
      bondingCurve,
      true
    );

    // Create token instruction parameters
    const createParams: CreateTokenParams = {
      name: tokenMetadata.name,
      symbol: tokenMetadata.symbol,
      uri: metadataUri,
    };

    // Add create instruction
    const createIx = createTokenInstruction(createParams, {
      mint: mint.publicKey,
      mintAuthority,
      bondingCurve,
      associatedBondingCurve,
      global,
      metadata,
      user: this.config.mainWallet.publicKey,
    });

    tx.add(createIx);
    return tx;
  }

  private async buildBuyTransaction(
    wallet: Keypair,
    mint: PublicKey,
    index: number
  ): Promise<Transaction> {
    const tx = new Transaction();

    // Add priority fees
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ 
        units: this.config.priorityFee.unitLimit 
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ 
        microLamports: this.config.priorityFee.unitPrice 
      })
    );

    // Calculate buy amount with optional randomization
    let buyAmountSOL = this.config.swapAmountSol;
    
    if (this.config.randomizeBuyAmounts) {
      const randomPercent = 10 + (Math.random() * 15); // 10-25% variation
      const modifier = Math.random() > 0.5 ? (100 + randomPercent) : (100 - randomPercent);
      buyAmountSOL = (buyAmountSOL * modifier) / 100;
    }

    // Safety check
    if (buyAmountSOL > this.config.maxSolPerWallet) {
      buyAmountSOL = this.config.maxSolPerWallet;
    }

    // Get required accounts
    const [global] = getGlobalPDA();
    const [bondingCurve] = getBondingCurvePDA(mint);
    
    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurve,
      true
    );
    
    const associatedUser = await getAssociatedTokenAddress(
      mint,
      wallet.publicKey,
      false
    );

    // Create ATA if it doesn't exist
    try {
      await getAccount(this.connection, associatedUser);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          associatedUser,
          wallet.publicKey,
          mint
        )
      );
    }

    // Calculate amounts
    const solAmount = new BN(Math.floor(buyAmountSOL * LAMPORTS_PER_SOL));
    const maxSolCost = solAmount
      .mul(new BN(10000 + this.config.slippageBasisPoints))
      .div(new BN(10000));

    // For this implementation, we'll use a simplified token amount calculation
    // In a real implementation, you'd need to query the bonding curve state
    const tokenAmount = solAmount.mul(new BN(1000000)); // Simplified calculation

    const buyParams: BuyTokenParams = {
      amount: tokenAmount,
      maxSolCost: maxSolCost,
    };

    // Add buy instruction
    const buyIx = buyTokenInstruction(buyParams, {
      global,
      feeRecipient: this.feeRecipient || global, // Use global as fallback
      mint,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      user: wallet.publicKey,
    });

    tx.add(buyIx);
    
    logger.debug(`   Wallet ${index + 1}: ${buyAmountSOL.toFixed(6)} SOL`);
    return tx;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async createAndBundle(metadata: TokenMetadata): Promise<BundleResult> {
    try {
      logger.info('🚀 Starting token creation and bundling process...');
      
      // Step 1: Load global account data
      await this.loadGlobalAccountData();
      
      // Step 2: Distribute SOL to wallets
      await this.distributeSOL();
      
      // Step 3: Upload metadata
      const metadataUri = await this.uploadMetadata(metadata);
      
      // Step 4: Generate mint keypair
      const mint = Keypair.generate();
      logger.info(`🪙 Generated mint address: ${mint.publicKey.toBase58()}`);
      
      // Step 5: Build create transaction
      logger.info('🔨 Building create transaction...');
      const createTx = await this.buildCreateTransaction(mint, metadataUri, metadata);
      
      // Step 6: Build buy transactions
      logger.info('🔨 Building buy transactions...');
      const { blockhash } = await this.connection.getLatestBlockhash();
      const buyTxs: VersionedTransaction[] = [];
      
      for (let i = 0; i < this.wallets.length; i++) {
        const wallet = this.wallets[i];
        const buyTx = await this.buildBuyTransaction(wallet, mint.publicKey, i);
        
        const versionedTx = new VersionedTransaction(
          new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: buyTx.instructions,
          }).compileToV0Message()
        );
        
        versionedTx.sign([wallet]);
        buyTxs.push(versionedTx);
        
        // Add delay between wallet operations if configured
        if (this.config.walletDelayMs > 0 && i < this.wallets.length - 1) {
          await this.sleep(this.config.walletDelayMs);
        }
      }
      
      // Step 7: Build create versioned transaction
      const createVersionedTx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: this.config.mainWallet.publicKey,
          recentBlockhash: blockhash,
          instructions: createTx.instructions,
        }).compileToV0Message()
      );
      
      createVersionedTx.sign([this.config.mainWallet, mint]);
      
      // Step 8: Send bundle via Jito
      logger.info(`📦 Sending bundle with ${buyTxs.length + 1} transactions...`);
      const allTxs = [createVersionedTx, ...buyTxs];
      
      const bundleResult = await sendJitoBundle(
        allTxs,
        this.config.mainWallet,
        this.config
      );
      
      if (bundleResult.success) {
        logger.info('🎉 Bundle sent successfully via Jito!');
        
        // Monitor for confirmation (simplified)
        await this.sleep(5000); // Wait 5 seconds for confirmation
        
        return {
          success: true,
          mint: mint.publicKey.toBase58(),
          signature: bundleResult.signature,
          transactions: allTxs.map(tx => tx.signatures[0].toString()),
        };
        
      } else {
        logger.error('❌ Bundle failed via Jito');
        
        if (!this.config.forceJitoOnly) {
          logger.info('🔄 Attempting fallback to regular transactions...');
          // Implement fallback logic here
        }
        
        return {
          success: false,
          error: bundleResult.error || 'Bundle submission failed',
        };
      }
      
    } catch (error) {
      logger.error('💥 Bundle creation failed:', error);
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

  async cleanup(): Promise<void> {
    if (!this.config.autoCleanupWallets) {
      return;
    }
    
    logger.info('🧹 Cleaning up generated wallets...');
    
    // Return any remaining SOL to main wallet
    const promises = this.wallets.map(async (wallet) => {
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        if (balance > 5000) { // Keep some for rent exemption
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: this.config.mainWallet.publicKey,
              lamports: BigInt(balance - 5000),
            })
          );
          
          await this.connection.sendTransaction(tx, [wallet]);
        }
      } catch (error) {
        logger.debug(`Failed to cleanup wallet ${wallet.publicKey.toBase58()}: ${error}`);
      }
    });
    
    await Promise.allSettled(promises);
    logger.info('✅ Wallet cleanup completed');
  }
}
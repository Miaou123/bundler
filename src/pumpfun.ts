// src/pumpfun.ts - Fixed version that works with your existing structure

import {
  Commitment,
  Connection,
  Finality,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { Program, Provider } from "@coral-xyz/anchor";
import { GlobalAccount } from "./sdk/globalAccount";
import {
  CompleteEvent,
  CreateEvent,
  CreateTokenMetadata,
  PriorityFee,
  PumpFunEventHandlers,
  PumpFunEventType,
  SetParamsEvent,
  TradeEvent,
  TransactionResult,
} from "./sdk/types";
import {
  toCompleteEvent,
  toCreateEvent,
  toSetParamsEvent,
  toTradeEvent,
} from "./sdk/events";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { BondingCurveAccount } from "./sdk/bondingCurveAccount";
import { BN } from "bn.js";
import {
  DEFAULT_COMMITMENT,
  DEFAULT_FINALITY,
  calculateWithSlippageBuy,
  calculateWithSlippageSell,
  sendTx,
} from "./sdk/util";
import { Pump, IDL } from "./sdk/IDL/index"; // Use your existing import structure
import type { BundlerConfig } from "./config"; // Import the type

const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MPL_TOKEN_METADATA_PROGRAM_ID =
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const GLOBAL_ACCOUNT_SEED = "global";
export const MINT_AUTHORITY_SEED = "mint-authority";
export const BONDING_CURVE_SEED = "bonding-curve";
export const METADATA_SEED = "metadata";

export const DEFAULT_DECIMALS = 6;

// Interface for bundled buys
export interface BundledBuy {
  wallet: Keypair;
  solAmount: bigint;
}

export class PumpFunSDK {
  public program: Program<Pump>;
  public connection: Connection;
  
  constructor(provider?: Provider) {
    this.program = new Program<Pump>(IDL as Pump, provider);
    this.connection = this.program.provider.connection;
  }

  // Your existing createAndBuy method (keep as is for compatibility)
  async createAndBuy(
    creator: Keypair,
    mint: Keypair,
    createTokenMetadata: CreateTokenMetadata,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);

    let createTx = await this.getCreateInstructions(
      creator.publicKey,
      createTokenMetadata.name,
      createTokenMetadata.symbol,
      tokenMetadata.metadataUri,
      mint
    );

    let newTx = new Transaction().add(createTx);

    if (buyAmountSol > 0) {
      const globalAccount = await this.getGlobalAccount(commitment);
      const buyAmount = globalAccount.getInitialBuyPrice(buyAmountSol);
      const buyAmountWithSlippage = calculateWithSlippageBuy(
        buyAmountSol,
        slippageBasisPoints
      );

      const buyTx = await this.getBuyInstructions(
        creator.publicKey,
        mint.publicKey,
        globalAccount.feeRecipient,
        buyAmount,
        buyAmountWithSlippage
      );

      newTx.add(buyTx);
    }

    let createResults = await sendTx(
      this.connection,
      newTx,
      creator.publicKey,
      [creator, mint],
      priorityFees,
      commitment,
      finality
    );
    return createResults;
  }

  // NEW: Bundled create and buy method using Jito bundles
  async createAndBuyBundled(
    creator: Keypair,
    mint: Keypair,
    createTokenMetadata: CreateTokenMetadata,
    creatorBuyAmountSol: bigint,
    additionalBuys: BundledBuy[],
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    
    console.log(`🚀 Creating Jito bundled transactions with ${additionalBuys.length} additional buys`);
    
    // Upload metadata
    let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);

    // Get global account for fee recipient
    const globalAccount = await this.getGlobalAccount(commitment);

    // Array to hold all transactions for Jito bundle
    const bundleTransactions: Transaction[] = [];
    
    // 1. CREATE + Creator BUY transaction
    let createAndCreatorBuyTx = new Transaction();
    
    // Add CREATE instruction
    let createIx = await this.getCreateInstructionOnly(
      creator.publicKey,
      createTokenMetadata.name,
      createTokenMetadata.symbol,
      tokenMetadata.metadataUri,
      mint
    );
    createAndCreatorBuyTx.add(createIx);

    // Add creator's buy (if any)
    if (creatorBuyAmountSol > 0) {
      // CRITICAL FIX: Create ATA for creator BEFORE the buy instruction
      const creatorATA = await getAssociatedTokenAddress(
        mint.publicKey,
        creator.publicKey,
        false
      );
      
      const createCreatorATAIx = createAssociatedTokenAccountInstruction(
        creator.publicKey, // payer
        creatorATA,        // ata address  
        creator.publicKey, // owner
        mint.publicKey     // mint
      );
      createAndCreatorBuyTx.add(createCreatorATAIx);

      // Now add the buy instruction (ATA exists!)
      const buyAmount = globalAccount.getInitialBuyPrice(creatorBuyAmountSol);
      const buyAmountWithSlippage = calculateWithSlippageBuy(
        creatorBuyAmountSol,
        slippageBasisPoints
      );

      const creatorBuyIx = await this.getBuyInstructionOnly(
        creator.publicKey,
        mint.publicKey,
        globalAccount.feeRecipient,
        buyAmount,
        buyAmountWithSlippage
      );
      createAndCreatorBuyTx.add(creatorBuyIx);
    }

    bundleTransactions.push(createAndCreatorBuyTx);
    console.log(`✅ Added CREATE + Creator ATA + Creator BUY transaction`);

    // 2. Individual transactions for each additional wallet
    for (let i = 0; i < additionalBuys.length; i++) {
      const buyData = additionalBuys[i];
      const walletTx = new Transaction();
      
      // Create ATA for buyer
      const associatedUser = await getAssociatedTokenAddress(
        mint.publicKey,
        buyData.wallet.publicKey,
        false
      );
      
      const createATAIx = createAssociatedTokenAccountInstruction(
        buyData.wallet.publicKey,
        associatedUser,
        buyData.wallet.publicKey,
        mint.publicKey
      );
      walletTx.add(createATAIx);

      // Add buy instruction
      const buyAmount = globalAccount.getInitialBuyPrice(buyData.solAmount);
      const buyAmountWithSlippage = calculateWithSlippageBuy(
        buyData.solAmount,
        slippageBasisPoints
      );

      const buyIx = await this.getBuyInstructionOnly(
        buyData.wallet.publicKey,
        mint.publicKey,
        globalAccount.feeRecipient,
        buyAmount,
        buyAmountWithSlippage
      );
      walletTx.add(buyIx);
      
      bundleTransactions.push(walletTx);
      console.log(`✅ Added wallet ${i + 1} transaction: ${buyData.wallet.publicKey.toBase58().slice(0, 8)}... - ${Number(buyData.solAmount) / 1e9} SOL`);
    }

    console.log(`📦 Jito bundle prepared: ${bundleTransactions.length} transactions`);

    // 3. Convert to VersionedTransactions and add signers
    const versionedTransactions: VersionedTransaction[] = [];
    
    // First transaction: CREATE + Creator BUY (signed by creator and mint)
    const createTxVersioned = await this.buildVersionedTransaction(
      bundleTransactions[0],
      creator.publicKey,
      [creator, mint]
    );
    versionedTransactions.push(createTxVersioned);

    // Additional transactions: each signed by respective wallet
    for (let i = 1; i < bundleTransactions.length; i++) {
      const walletTx = bundleTransactions[i];
      const wallet = additionalBuys[i - 1].wallet;
      
      const walletTxVersioned = await this.buildVersionedTransaction(
        walletTx,
        wallet.publicKey,
        [wallet]
      );
      versionedTransactions.push(walletTxVersioned);
    }

    console.log(`🎯 Built ${versionedTransactions.length} versioned transactions for Jito bundle`);

    // 4. FIXED: Import and use the ENHANCED Jito bundling system with detailed logging
    const { sendSmartJitoBundle } = await import('./jito');
    
    // Create a minimal config object for Jito (using your BundlerConfig structure)
    // We'll create a partial config with only the fields needed by Jito functions
    const jitoConfig: BundlerConfig = {
      rpcUrl: this.connection.rpcEndpoint,
      network: 'mainnet-beta',
      mainWallet: creator,
      walletCount: additionalBuys.length,
      swapAmountSol: Number(creatorBuyAmountSol) / 1e9,
      randomizeBuyAmounts: false,
      walletDelayMs: 100,
      priorityFee: {
        unitLimit: priorityFees?.unitLimit || 5000000,
        unitPrice: priorityFees?.unitPrice || 200000,
      },
      jitoTipLamports: 1000000,
      jitoMaxRetries: 3,
      jitoTimeoutSeconds: 30,
      forceJitoOnly: false,
      slippageBasisPoints: Number(slippageBasisPoints),
      maxSolPerWallet: 0.01,
      minMainWalletBalance: 0.1,
      maxTotalSolSpend: 0.1,
      maxRetryAttempts: 3,
      retryCooldownSeconds: 5,
      debugMode: false,
      logLevel: 'info',
      saveLogsToFile: true,
      autoCleanupWallets: false,
      requireConfirmation: false,
      monitorBalances: false,
      balanceCheckInterval: 10,
    };

    // 5. Send via Jito bundle with enhanced debugging and verification
    console.log(`🚀 Sending Jito bundle with enhanced debugging and verification...`);
    const jitoResult = await sendSmartJitoBundle(
      versionedTransactions,
      creator, // Payer
      jitoConfig,
      mint.publicKey.toBase58() // Pass expected mint for verification
    );

    if (jitoResult.success) {
      console.log(`🎉 Jito bundle successful!`);
      console.log(`   Signature: ${jitoResult.signature}`);
      console.log(`   Bundle ID: ${jitoResult.bundleId}`);
      console.log(`   Attempts: ${jitoResult.attempts}`);
      
      return {
        success: true,
        signature: jitoResult.signature,
        // You can access the mint here since it's the same mint keypair
      };
    } else {
      throw new Error(`Jito bundle failed: ${jitoResult.error}`);
    }
  }

  // Helper method to build versioned transactions
  private async buildVersionedTransaction(
    transaction: Transaction,
    payer: PublicKey,
    signers: Keypair[]
  ): Promise<VersionedTransaction> {
    const { buildVersionedTx } = await import('./sdk/util');
    
    const versionedTx = await buildVersionedTx(
      this.connection,
      payer,
      transaction,
      'confirmed'
    );
    
    versionedTx.sign(signers);
    return versionedTx;
  }

  // Your existing buy method (unchanged)
  async buy(
    buyer: Keypair,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    let buyTx = await this.getBuyInstructionsBySolAmount(
      buyer.publicKey,
      mint,
      buyAmountSol,
      slippageBasisPoints,
      commitment
    );

    let buyResults = await sendTx(
      this.connection,
      buyTx,
      buyer.publicKey,
      [buyer],
      priorityFees,
      commitment,
      finality
    );
    return buyResults;
  }

  // Your existing sell method (unchanged)
  async sell(
    seller: Keypair,
    mint: PublicKey,
    sellTokenAmount: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    let sellTx = await this.getSellInstructionsByTokenAmount(
      seller.publicKey,
      mint,
      sellTokenAmount,
      slippageBasisPoints,
      commitment
    );

    let sellResults = await sendTx(
      this.connection,
      sellTx,
      seller.publicKey,
      [seller],
      priorityFees,
      commitment,
      finality
    );
    return sellResults;
  }

  // Your existing method (unchanged)
  async getCreateInstructions(
    creator: PublicKey,
    name: string,
    symbol: string,
    uri: string,
    mint: Keypair
  ) {
    const mplTokenMetadata = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);

    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(METADATA_SEED),
        mplTokenMetadata.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      mplTokenMetadata
    );

    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.publicKey.toBuffer()],
      this.program.programId
    );

    const [mintAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_AUTHORITY_SEED)],
      this.program.programId
    );

    const [globalPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );

    const [eventAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.program.programId
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint.publicKey,
      bondingCurvePDA,
      true
    );

    return this.program.methods
      .create(name, symbol, uri, creator)
      .accountsStrict({
        mint: mint.publicKey,
        mintAuthority: mintAuthorityPDA,
        bondingCurve: bondingCurvePDA,
        associatedBondingCurve: associatedBondingCurve,
        global: globalPDA,
        mplTokenMetadata: mplTokenMetadata,
        metadata: metadataPDA,
        user: creator,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        eventAuthority: eventAuthorityPDA,
        program: this.program.programId,
      })
      .signers([mint])
      .transaction();
  }

  // NEW: Get create instruction only (for bundling)
  async getCreateInstructionOnly(
    creator: PublicKey,
    name: string,
    symbol: string,
    uri: string,
    mint: Keypair
  ): Promise<TransactionInstruction> {
    const mplTokenMetadata = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);

    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(METADATA_SEED),
        mplTokenMetadata.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      mplTokenMetadata
    );

    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.publicKey.toBuffer()],
      this.program.programId
    );

    const [mintAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_AUTHORITY_SEED)],
      this.program.programId
    );

    const [globalPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );

    const [eventAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.program.programId
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint.publicKey,
      bondingCurvePDA,
      true
    );

    return this.program.methods
      .create(name, symbol, uri, creator)
      .accountsStrict({
        mint: mint.publicKey,
        mintAuthority: mintAuthorityPDA,
        bondingCurve: bondingCurvePDA,
        associatedBondingCurve: associatedBondingCurve,
        global: globalPDA,
        mplTokenMetadata: mplTokenMetadata,
        metadata: metadataPDA,
        user: creator,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        eventAuthority: eventAuthorityPDA,
        program: this.program.programId,
      })
      .instruction(); // Return instruction, not transaction
  }

  // Your existing method (unchanged)
  async getBuyInstructionsBySolAmount(
    buyer: PublicKey,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    let bondingCurveAccount = await this.getBondingCurveAccount(
      mint,
      commitment
    );
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }

    let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
    let buyAmountWithSlippage = calculateWithSlippageBuy(
      buyAmountSol,
      slippageBasisPoints
    );

    let globalAccount = await this.getGlobalAccount(commitment);

    return await this.getBuyInstructions(
      buyer,
      mint,
      globalAccount.feeRecipient,
      buyAmount,
      buyAmountWithSlippage
    );
  }

  // Your existing method (unchanged)
  async getBuyInstructions(
    buyer: PublicKey,
    mint: PublicKey,
    feeRecipient: PublicKey,
    amount: bigint,
    solAmount: bigint,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      this.program.programId
    );

    const [globalPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );

    const [eventAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.program.programId
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );
  
    const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);

    // Get bonding curve account to find creator
    const bondingCurveAccount = await this.connection.getAccountInfo(bondingCurvePDA);
    if (!bondingCurveAccount) {
      throw new Error('Bonding curve account not found');
    }
    
    // Parse bonding curve to get creator (at offset 93 according to IDL)
    const creatorBytes = bondingCurveAccount.data.slice(93, 93 + 32);
    const creator = new PublicKey(creatorBytes);
    
    const [creatorVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      this.program.programId
    );
  
    let transaction = new Transaction();
  
    try {
      await getAccount(this.connection, associatedUser, commitment);
    } catch (e) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          buyer,
          associatedUser,
          buyer,
          mint
        )
      );
    }
  
    transaction.add(
      await this.program.methods
        .buy(new BN(amount.toString()), new BN(solAmount.toString()))
        .accountsStrict({
          global: globalPDA,
          feeRecipient: feeRecipient,
          mint: mint,
          bondingCurve: bondingCurvePDA,
          associatedBondingCurve: associatedBondingCurve,
          associatedUser: associatedUser,
          user: buyer,
          systemProgram: new PublicKey("11111111111111111111111111111111"),
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          creatorVault: creatorVaultPDA,
          eventAuthority: eventAuthorityPDA,
          program: this.program.programId,
        })
        .transaction()
    );
  
    return transaction;
  }

  // NEW: Get buy instruction only (for bundling)
  async getBuyInstructionOnly(
    buyer: PublicKey,
    mint: PublicKey,
    feeRecipient: PublicKey,
    amount: bigint,
    solAmount: bigint
  ): Promise<TransactionInstruction> {
    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      this.program.programId
    );

    const [globalPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );

    const [eventAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.program.programId
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );
  
    const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);

    // For bundled transactions, we know the creator is the main wallet
    const creator = this.program.provider.publicKey!;
    const [creatorVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      this.program.programId
    );
  
    return this.program.methods
      .buy(new BN(amount.toString()), new BN(solAmount.toString()))
      .accountsStrict({
        global: globalPDA,
        feeRecipient: feeRecipient,
        mint: mint,
        bondingCurve: bondingCurvePDA,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: buyer,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        creatorVault: creatorVaultPDA,
        eventAuthority: eventAuthorityPDA,
        program: this.program.programId,
      })
      .instruction(); // Return instruction, not transaction
  }

  // Your existing sell methods (unchanged)
  async getSellInstructionsByTokenAmount(
    seller: PublicKey,
    mint: PublicKey,
    sellTokenAmount: bigint,
    slippageBasisPoints: bigint = 500n,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    let bondingCurveAccount = await this.getBondingCurveAccount(
      mint,
      commitment
    );
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }

    let globalAccount = await this.getGlobalAccount(commitment);
    let minSolOutput = bondingCurveAccount.getSellPrice(
      sellTokenAmount,
      globalAccount.feeBasisPoints
    );

    let sellAmountWithSlippage = calculateWithSlippageSell(
      minSolOutput,
      slippageBasisPoints
    );

    return await this.getSellInstructions(
      seller,
      mint,
      globalAccount.feeRecipient,
      sellTokenAmount,
      sellAmountWithSlippage
    );
  }

  async getSellInstructions(
    seller: PublicKey,
    mint: PublicKey,
    feeRecipient: PublicKey,
    amount: bigint,
    minSolOutput: bigint
  ) {
    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      this.program.programId
    );

    const [globalPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );

    const [eventAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.program.programId
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );

    const associatedUser = await getAssociatedTokenAddress(mint, seller, false);

    // Get bonding curve account to find creator
    const bondingCurveAccount = await this.connection.getAccountInfo(bondingCurvePDA);
    if (!bondingCurveAccount) {
      throw new Error('Bonding curve account not found');
    }
    
    // Parse bonding curve to get creator (at offset 93 according to IDL)
    const creatorBytes = bondingCurveAccount.data.slice(93, 93 + 32);
    const creator = new PublicKey(creatorBytes);
    
    const [creatorVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      this.program.programId
    );

    return this.program.methods
      .sell(new BN(amount.toString()), new BN(minSolOutput.toString()))
      .accountsStrict({
        global: globalPDA,
        feeRecipient: feeRecipient,
        mint: mint,
        bondingCurve: bondingCurvePDA,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: seller,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
        creatorVault: creatorVaultPDA,
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        eventAuthority: eventAuthorityPDA,
        program: this.program.programId,
      })
      .transaction();
  }

  // Your existing methods (unchanged)
  async getBondingCurveAccount(
    mint: PublicKey,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    const tokenAccount = await this.connection.getAccountInfo(
      this.getBondingCurvePDA(mint),
      commitment
    );
    if (!tokenAccount) {
      return null;
    }
    return BondingCurveAccount.fromBuffer(tokenAccount!.data);
  }

  async getGlobalAccount(commitment: Commitment = DEFAULT_COMMITMENT) {
    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      new PublicKey(PROGRAM_ID)
    );

    const tokenAccount = await this.connection.getAccountInfo(
      globalAccountPDA,
      commitment
    );

    return GlobalAccount.fromBuffer(tokenAccount!.data);
  }

  getBondingCurvePDA(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      this.program.programId
    )[0];
  }

  // Your existing method (unchanged)
  async createTokenMetadata(create: CreateTokenMetadata) {
    if (!(create.file instanceof Blob)) {
        throw new Error('File must be a Blob or File object');
    }

    let formData = new FormData();
    formData.append("file", create.file, 'image.png');
    formData.append("name", create.name);
    formData.append("symbol", create.symbol);
    formData.append("description", create.description);
    formData.append("twitter", create.twitter || "");
    formData.append("telegram", create.telegram || "");
    formData.append("website", create.website || "");
    formData.append("showName", "true");

    try {
        const request = await fetch("https://pump.fun/api/ipfs", {
            method: "POST",
            headers: {
                'Accept': 'application/json',
            },
            body: formData,
            credentials: 'same-origin'
        });

        if (request.status === 500) {
            const errorText = await request.text();
            throw new Error(`Server error (500): ${errorText || 'No error details available'}`);
        }

        if (!request.ok) {
            throw new Error(`HTTP error! status: ${request.status}`);
        }

        const responseText = await request.text();
        if (!responseText) {
            throw new Error('Empty response received from server');
        }

        try {
            return JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Invalid JSON response: ${responseText}`);
        }
    } catch (error) {
        console.error('Error in createTokenMetadata:', error);
        throw error;
    }
  }

  // Your existing event methods (unchanged)
  addEventListener<T extends PumpFunEventType>(
    eventType: T,
    callback: (
      event: PumpFunEventHandlers[T],
      slot: number,
      signature: string
    ) => void
  ) {
    return this.program.addEventListener(
      eventType,
      (event: any, slot: number, signature: string) => {
        let processedEvent;
        switch (eventType) {
          case "createEvent":
            processedEvent = toCreateEvent(event as CreateEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "tradeEvent":
            processedEvent = toTradeEvent(event as TradeEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "completeEvent":
            processedEvent = toCompleteEvent(event as CompleteEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "setParamsEvent":
            processedEvent = toSetParamsEvent(event as SetParamsEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          default:
            console.error("Unhandled event type:", eventType);
        }
      }
    );
  }

  removeEventListener(eventId: number) {
    this.program.removeEventListener(eventId);
  }
}
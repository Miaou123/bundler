// src/pumpfun.ts - SECURE version with anti-MEV protections

import {
  Commitment,
  Connection,
  Finality,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
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
import { Pump, IDL } from "./sdk/IDL/index";
import { sendSecureJitoBundle } from './jito';

const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const GLOBAL_ACCOUNT_SEED = "global";
export const MINT_AUTHORITY_SEED = "mint-authority";
export const BONDING_CURVE_SEED = "bonding-curve";
export const METADATA_SEED = "metadata";
export const DEFAULT_DECIMALS = 6;

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

  // SECURE: Main bundled create and buy method with anti-MEV protections
  async createAndBuyBundledSecure(
    creator: Keypair,
    mint: Keypair,
    createTokenMetadata: CreateTokenMetadata,
    creatorBuyAmountSol: bigint,
    additionalBuys: BundledBuy[],
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    jitoPriority: 'low' | 'medium' | 'high' | 'max' = 'high',
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    
    console.log(`🛡️  SECURE: Creating protected Jito bundle with ${additionalBuys.length} buys`);
    
    // 1. Upload metadata
    let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);
    const globalAccount = await this.getGlobalAccount(commitment);

    // 2. SECURE: Build single transaction with embedded tip
    const allInstructions = await this.buildSecureTokenInstructions(
      creator,
      mint,
      createTokenMetadata,
      tokenMetadata.metadataUri,
      creatorBuyAmountSol,
      additionalBuys,
      globalAccount,
      slippageBasisPoints,
      priorityFees
    );

    console.log(`🛡️  Built ${allInstructions.length} instructions for secure bundle`);

    // 3. SECURE: Define protection checks
    const preChecks = [
      {
        account: creator.publicKey,
        expectedBalance: Number(creatorBuyAmountSol) + 50_000_000, // Ensure sufficient balance
        mustExist: true,
      },
      {
        account: globalAccount.authority,
        mustExist: true,
      }
    ];

    const postChecks = [
      {
        account: mint.publicKey,
        minBalance: 1, // Ensure mint was created
      }
    ];

    // 4. SECURE: Send via protected Jito bundle (JITO-ONLY)
    console.log(`🛡️  Sending via SECURE Jito bundle system...`);
    
    const secureResult = await sendSecureJitoBundle(
      allInstructions,
      creator,
      this.connection,
      {
        priority: jitoPriority,
        preChecks,
        postChecks,
        priorityFees: priorityFees ? {
          unitLimit: priorityFees.unitLimit,
          unitPrice: priorityFees.unitPrice
        } : undefined,
      }
    );

    if (secureResult.success) {
      console.log(`🛡️  SECURE bundle successful!`);
      console.log(`   Signature: ${secureResult.signature}`);
      console.log(`   Bundle ID: ${secureResult.bundleId}`);
      console.log(`   Tip Amount: ${secureResult.tipAmount} SOL`);
      console.log(`   🛡️  Protections verified:`);
      console.log(`     Tip in main TX: ${secureResult.protections.tipInMainTx}`);
      console.log(`     Pre-checks: ${secureResult.protections.hasPreChecks}`);
      console.log(`     Post-checks: ${secureResult.protections.hasPostChecks}`);
      console.log(`     JITO-only: ${secureResult.protections.jitoOnly}`);
      
      return {
        success: true,
        signature: secureResult.signature,
      };
    } else {
      throw new Error(`SECURE Jito bundle failed: ${secureResult.error}`);
    }
  }

  // SECURE: Build all instructions for a single protected transaction
  private async buildSecureTokenInstructions(
    creator: Keypair,
    mint: Keypair,
    createTokenMetadata: CreateTokenMetadata,
    metadataUri: string,
    creatorBuyAmountSol: bigint,
    additionalBuys: BundledBuy[],
    globalAccount: any,
    slippageBasisPoints: bigint,
    priorityFees?: PriorityFee
  ): Promise<TransactionInstruction[]> {
    
    const instructions: TransactionInstruction[] = [];
    
    // 1. SECURE: Add priority fees first
    if (priorityFees) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: priorityFees.unitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFees.unitPrice })
      );
    }
    
    // 2. Add CREATE instruction
    const createIx = await this.getCreateInstructionOnly(
      creator.publicKey,
      createTokenMetadata.name,
      createTokenMetadata.symbol,
      metadataUri,
      mint
    );
    instructions.push(createIx);

    // 3. SECURE: Add creator buy with ATA creation
    if (creatorBuyAmountSol > 0) {
      const creatorATA = await getAssociatedTokenAddress(
        mint.publicKey,
        creator.publicKey,
        false
      );
      
      instructions.push(
        createAssociatedTokenAccountInstruction(
          creator.publicKey,
          creatorATA,
          creator.publicKey,
          mint.publicKey
        )
      );

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
      instructions.push(creatorBuyIx);
    }

    // 4. SECURE: Add all additional buys (with ATA creation)
    for (let i = 0; i < additionalBuys.length; i++) {
      const buyData = additionalBuys[i];
      
      // Create ATA for buyer
      const buyerATA = await getAssociatedTokenAddress(
        mint.publicKey,
        buyData.wallet.publicKey,
        false
      );
      
      instructions.push(
        createAssociatedTokenAccountInstruction(
          buyData.wallet.publicKey,
          buyerATA,
          buyData.wallet.publicKey,
          mint.publicKey
        )
      );

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
      instructions.push(buyIx);
    }
    
    console.log(`🛡️  SECURE transaction structure:`);
    console.log(`   Priority fees: ${priorityFees ? 'YES' : 'NO'}`);
    console.log(`   CREATE instruction: 1`);
    console.log(`   Creator ATA + BUY: ${creatorBuyAmountSol > 0 ? 2 : 0}`);
    console.log(`   Additional buys: ${additionalBuys.length * 2} (ATA + BUY each)`);
    console.log(`   Total instructions: ${instructions.length}`);
    console.log(`   🛡️  Tip will be embedded by secure bundler`);
    
    return instructions;
  }

  // ===========================================
  // EXISTING METHODS (keeping them unchanged)
  // ===========================================

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
      .instruction();
  }

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

    const bondingCurveAccount = await this.connection.getAccountInfo(bondingCurvePDA);
    if (!bondingCurveAccount) {
      throw new Error('Bonding curve account not found');
    }
    
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
      .instruction();
  }

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

    const bondingCurveAccount = await this.connection.getAccountInfo(bondingCurvePDA);
    if (!bondingCurveAccount) {
      throw new Error('Bonding curve account not found');
    }
    
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
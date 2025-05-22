// src/pumpfun-sdk.ts - Extracted working PumpFun SDK integrated into your bundler

import {
    Commitment,
    Connection,
    Finality,
    Keypair,
    PublicKey,
    Transaction,
    VersionedTransaction,
  } from "@solana/web3.js";
  import { Program, Provider, BN } from "@coral-xyz/anchor";
  import { GlobalAccount } from "./accounts/globalAccount";
  import { BondingCurveAccount } from "./accounts/bondingCurveAccount";
  import {
    createAssociatedTokenAccountInstruction,
    getAccount,
    getAssociatedTokenAddress,
  } from "@solana/spl-token";
  import {
    buildTx,
    calculateWithSlippageBuy,
    calculateWithSlippageSell,
  } from "./utils/transaction-utils";
  import { PumpFun, IDL } from "./IDL";
  import { logger } from './utils/logger';
  
  const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
  
  export const GLOBAL_ACCOUNT_SEED = "global";
  export const MINT_AUTHORITY_SEED = "mint-authority";
  export const BONDING_CURVE_SEED = "bonding-curve";
  export const METADATA_SEED = "metadata";
  export const DEFAULT_DECIMALS = 6;
  
  export interface CreateTokenMetadata {
    name: string;
    symbol: string;
    description: string;
    file: Blob | Buffer | any;
    twitter?: string;
    telegram?: string;
    website?: string;
  }
  
  export interface PriorityFee {
    unitLimit: number;
    unitPrice: number;
  }
  
  export interface TransactionResult {
    success: boolean;
    signature?: string;
    error?: unknown;
  }
  
  export class PumpFunSDK {
    public program: Program<PumpFun>;
    public connection: Connection;
  
    constructor(provider: Provider) {
      this.program = new Program<PumpFun>(IDL as PumpFun, provider);
      this.connection = this.program.provider.connection;
    }
  
    async createAndBuy(
      creator: Keypair,
      mint: Keypair,
      buyers: Keypair[],
      createTokenMetadata: CreateTokenMetadata,
      buyAmountSol: bigint,
      slippageBasisPoints: bigint = 300n,
      priorityFees?: PriorityFee,
      commitment: Commitment = "confirmed"
    ) {
      logger.info('🔧 Creating token and preparing buy transactions...');
      
      // Step 1: Use fallback metadata for testing (skip upload)
      logger.warn('⚠️ Using fallback metadata URI for testing');
      const tokenMetadata = {
        metadataUri: "https://ipfs.io/ipfs/QmdSZ4qRo44Zg4Ju181dD6SAnR1bnr8wTYy1rHqCwb9ZEg"
      };
  
      // Get fresh blockhash for all transactions
      const { blockhash } = await this.connection.getLatestBlockhash(commitment);
  
      // Step 2: Create token transaction
      let createTx = await this.getCreateInstructions(
        creator.publicKey,
        createTokenMetadata.name,
        createTokenMetadata.symbol,
        tokenMetadata.metadataUri,
        mint
      );
  
      let newTx = new Transaction().add(createTx);
  
      // Build create transaction with fresh blockhash
      let createVersionedTx = await buildTx(
        this.connection,
        newTx,
        creator.publicKey,
        [creator, mint],
        priorityFees,
        commitment
      );
  
      // Step 3: Create buy transactions for each buyer
      let buyTxs: VersionedTransaction[] = [];
      
      if (buyAmountSol > 0) {
        // Get global account for fee recipient
        const globalAccount = await this.getGlobalAccount(commitment);
        
        for (let i = 0; i < buyers.length; i++) {
          // Add some randomization to buy amounts (10-30% variance)
          const randomPercent = Math.floor(Math.random() * 21) + 10; // 10-30%
          const variance = Math.random() < 0.5 ? (100 + randomPercent) : (100 - randomPercent);
          const buyAmountSolWithRandom = buyAmountSol * BigInt(variance) / BigInt(100);
  
          // Calculate estimated token amount (use global account initial parameters)
          const estimatedTokenAmount = globalAccount.getInitialBuyPrice(buyAmountSolWithRandom);
          const maxSolCost = calculateWithSlippageBuy(buyAmountSolWithRandom, slippageBasisPoints);
  
          // Build buy transaction directly without ATA creation (it will be created automatically)
          let buyTx = await this.getBuyInstructionsSimple(
            buyers[i].publicKey,
            mint.publicKey,
            globalAccount.feeRecipient,
            estimatedTokenAmount,
            maxSolCost
          );
  
          const buyVersionedTx = await buildTx(
            this.connection,
            buyTx,
            buyers[i].publicKey,
            [buyers[i]],
            priorityFees,
            commitment
          );
          buyTxs.push(buyVersionedTx);
        }
      }
  
      return {
        createTx: createVersionedTx,
        buyTxs: buyTxs,
        mint: mint.publicKey,
        metadata: tokenMetadata
      };
    }
  
    // Simplified buy instructions without ATA checking
    async getBuyInstructionsSimple(
      buyer: PublicKey,
      mint: PublicKey,
      feeRecipient: PublicKey,
      amount: bigint,
      solAmount: bigint
    ) {
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mint,
        this.getBondingCurvePDA(mint),
        true
      );
  
      const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);
  
      let transaction = new Transaction();
  
      // Always add ATA creation instruction - it will succeed if needed, or be ignored if exists
      transaction.add(
        createAssociatedTokenAccountInstruction(
          buyer,
          associatedUser,
          buyer,
          mint
        )
      );
  
      // Add buy instruction
      transaction.add(
        await this.program.methods
          .buy(new BN(amount.toString()), new BN(solAmount.toString()))
          .accounts({
            feeRecipient: feeRecipient,
            mint: mint,
            associatedBondingCurve: associatedBondingCurve,
            associatedUser: associatedUser,
            user: buyer,
          })
          .transaction()
      );
  
      return transaction;
    }
  
    async buy(
      buyer: Keypair,
      mint: PublicKey,
      buyAmountSol: bigint,
      slippageBasisPoints: bigint = 500n,
      priorityFees?: PriorityFee,
      commitment: Commitment = "confirmed"
    ): Promise<TransactionResult> {
      try {
        let buyTx = await this.getBuyInstructionsBySolAmount(
          buyer.publicKey,
          mint,
          buyAmountSol,
          slippageBasisPoints,
          commitment
        );
  
        const versionedTx = await buildTx(
          this.connection,
          buyTx,
          buyer.publicKey,
          [buyer],
          priorityFees,
          commitment
        );
  
        const signature = await this.connection.sendTransaction(versionedTx);
        await this.connection.confirmTransaction(signature, commitment);
  
        return {
          success: true,
          signature: signature,
        };
      } catch (error) {
        return {
          success: false,
          error: error,
        };
      }
    }
  
    // Note: Sell functionality not available in this Pump.fun program version
    async sell(
      seller: Keypair,
      mint: PublicKey,
      sellTokenAmount: bigint,
      slippageBasisPoints: bigint = 500n,
      priorityFees?: PriorityFee,
      commitment: Commitment = "confirmed"
    ): Promise<TransactionResult> {
      return {
        success: false,
        error: "Sell functionality not available in this Pump.fun program version",
      };
    }
  
    //create token instructions
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
  
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mint.publicKey,
        this.getBondingCurvePDA(mint.publicKey),
        true
      );
  
      return this.program.methods
        .create(name, symbol, uri)
        .accounts({
          mint: mint.publicKey,
          associatedBondingCurve: associatedBondingCurve,
          metadata: metadataPDA,
          user: creator,
        })
        .signers([mint])
        .transaction();
    }
  
    async getBuyInstructionsBySolAmount(
      buyer: PublicKey,
      mint: PublicKey,
      buyAmountSol: bigint,
      slippageBasisPoints: bigint = 500n,
      commitment: Commitment = "confirmed"
    ) {
      let bondingCurveAccount = await this.getBondingCurveAccount(mint, commitment);
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
        buyAmountWithSlippage,
      );
    }
  
    //buy
    async getBuyInstructions(
      buyer: PublicKey,
      mint: PublicKey,
      feeRecipient: PublicKey,
      amount: bigint,
      solAmount: bigint,
      commitment: Commitment = "confirmed",
    ) {
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mint,
        this.getBondingCurvePDA(mint),
        true
      );
  
      const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);
  
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
          .accounts({
            feeRecipient: feeRecipient,
            mint: mint,
            associatedBondingCurve: associatedBondingCurve,
            associatedUser: associatedUser,
            user: buyer,
          })
          .transaction()
      );
  
      return transaction;
    }
  
    // Note: Sell functionality not available in this Pump.fun program version
    async getSellInstructionsByTokenAmount(
      seller: PublicKey,
      mint: PublicKey,
      sellTokenAmount: bigint,
      slippageBasisPoints: bigint = 500n,
      commitment: Commitment = "confirmed"
    ) {
      throw new Error("Sell functionality not available in this Pump.fun program version");
    }
  
    async getSellInstructions(
      seller: PublicKey,
      mint: PublicKey,
      feeRecipient: PublicKey,
      amount: bigint,
      minSolOutput: bigint
    ) {
      throw new Error("Sell functionality not available in this Pump.fun program version");
    }
  
    async getBondingCurveAccount(
      mint: PublicKey,
      commitment: Commitment = "confirmed"
    ) {
      const bondingCurvePDA = this.getBondingCurvePDA(mint);
      const tokenAccount = await this.connection.getAccountInfo(
        bondingCurvePDA,
        commitment
      );
      if (!tokenAccount) {
        return null;
      }
      return BondingCurveAccount.fromBuffer(tokenAccount.data);
    }
  
    async getGlobalAccount(commitment: Commitment = "confirmed") {
      const [globalAccountPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from(GLOBAL_ACCOUNT_SEED)],
        new PublicKey(PROGRAM_ID)
      );
  
      const tokenAccount = await this.connection.getAccountInfo(
        globalAccountPDA,
        commitment
      );
  
      if (!tokenAccount) {
        throw new Error('Global account not found');
      }
  
      return GlobalAccount.fromBuffer(tokenAccount.data);
    }
  
    getBondingCurvePDA(mint: PublicKey) {
      return PublicKey.findProgramAddressSync(
        [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
        this.program.programId
      )[0];
    }
  
    async createTokenMetadata(create: CreateTokenMetadata) {
      let formData = new FormData();
      formData.append("file", create.file);
      formData.append("name", create.name);
      formData.append("symbol", create.symbol);
      formData.append("description", create.description);
      formData.append("twitter", create.twitter || "");
      formData.append("telegram", create.telegram || "");
      formData.append("website", create.website || "");
      formData.append("showName", "true");
  
      let request = await fetch("https://pump.fun/api/ipfs", {
        method: "POST",
        headers: {
          "Host": "www.pump.fun",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br, zstd",
          "Referer": "https://www.pump.fun/create",
          "Origin": "https://www.pump.fun",
          "Connection": "keep-alive",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "Priority": "u=1",
          "TE": "trailers"
        },
        body: formData,
      });
  
      const result = await request.json();
      return result;
    }
  }
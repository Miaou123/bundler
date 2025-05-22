import {
    PublicKey,
    TransactionInstruction,
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
  } from '@solana/web3.js';
  import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  } from '@solana/spl-token';
  import { BN } from 'bn.js';
  
  // Program constants
  export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  export const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
  export const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  
  // Seeds for PDAs
  export const GLOBAL_SEED = 'global';
  export const MINT_AUTHORITY_SEED = 'mint-authority';
  export const BONDING_CURVE_SEED = 'bonding-curve';
  export const METADATA_SEED = 'metadata';
  
  // Instruction discriminators (first 8 bytes of instruction data)
  const DISCRIMINATORS = {
    CREATE: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]),
    BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
    SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  };
  
  // Helper functions for PDAs
  export function getGlobalPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_SEED)],
      PUMP_PROGRAM_ID
    );
  }
  
  export function getMintAuthorityPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_AUTHORITY_SEED)],
      PUMP_PROGRAM_ID
    );
  }
  
  export function getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      PUMP_PROGRAM_ID
    );
  }
  
  export function getMetadataPDA(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(METADATA_SEED),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );
  }
  
  // Instruction parameter interfaces
  export interface CreateTokenParams {
    name: string;
    symbol: string;
    uri: string;
  }
  
  export interface CreateTokenAccounts {
    mint: PublicKey;
    mintAuthority: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    global: PublicKey;
    metadata: PublicKey;
    user: PublicKey;
  }
  
  export interface BuyTokenParams {
    amount: BN; // Token amount to buy
    maxSolCost: BN; // Maximum SOL to spend (slippage protection)
  }
  
  export interface BuyTokenAccounts {
    global: PublicKey;
    feeRecipient: PublicKey;
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    user: PublicKey;
  }
  
  export interface SellTokenParams {
    amount: BN; // Token amount to sell
    minSolOutput: BN; // Minimum SOL to receive (slippage protection)
  }
  
  export interface SellTokenAccounts {
    global: PublicKey;
    feeRecipient: PublicKey;
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    user: PublicKey;
  }
  
  // Utility functions for data encoding
  function encodeString(str: string): Buffer {
    const stringBuffer = Buffer.from(str, 'utf8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(stringBuffer.length, 0);
    return Buffer.concat([lengthBuffer, stringBuffer]);
  }
  
  function encodeBN(bn: BN): Buffer {
    return bn.toArrayLike(Buffer, 'le', 8);
  }
  
  // Instruction builders
  export function createTokenInstruction(
    params: CreateTokenParams,
    accounts: CreateTokenAccounts
  ): TransactionInstruction {
    // Encode instruction data
    const nameData = encodeString(params.name);
    const symbolData = encodeString(params.symbol);
    const uriData = encodeString(params.uri);
  
    // Create instruction data buffer
    const data = Buffer.concat([
      DISCRIMINATORS.CREATE,
      nameData,
      symbolData,
      uriData,
    ]);
  
    return new TransactionInstruction({
      keys: [
        { pubkey: accounts.mint, isSigner: true, isWritable: true },
        { pubkey: accounts.mintAuthority, isSigner: false, isWritable: false },
        { pubkey: accounts.bondingCurve, isSigner: false, isWritable: true },
        { pubkey: accounts.associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: accounts.global, isSigner: false, isWritable: false },
        { pubkey: MPL_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: accounts.metadata, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: PUMP_PROGRAM_ID,
      data,
    });
  }
  
  export function buyTokenInstruction(
    params: BuyTokenParams,
    accounts: BuyTokenAccounts
  ): TransactionInstruction {
    // Create instruction data buffer
    const data = Buffer.concat([
      DISCRIMINATORS.BUY,
      encodeBN(params.amount),
      encodeBN(params.maxSolCost),
    ]);
  
    return new TransactionInstruction({
      keys: [
        { pubkey: accounts.global, isSigner: false, isWritable: false },
        { pubkey: accounts.feeRecipient, isSigner: false, isWritable: true },
        { pubkey: accounts.mint, isSigner: false, isWritable: false },
        { pubkey: accounts.bondingCurve, isSigner: false, isWritable: true },
        { pubkey: accounts.associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: accounts.associatedUser, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: PUMP_PROGRAM_ID,
      data,
    });
  }
  
  export function sellTokenInstruction(
    params: SellTokenParams,
    accounts: SellTokenAccounts
  ): TransactionInstruction {
    // Create instruction data buffer
    const data = Buffer.concat([
      DISCRIMINATORS.SELL,
      encodeBN(params.amount),
      encodeBN(params.minSolOutput),
    ]);
  
    return new TransactionInstruction({
      keys: [
        { pubkey: accounts.global, isSigner: false, isWritable: false },
        { pubkey: accounts.feeRecipient, isSigner: false, isWritable: true },
        { pubkey: accounts.mint, isSigner: false, isWritable: false },
        { pubkey: accounts.bondingCurve, isSigner: false, isWritable: true },
        { pubkey: accounts.associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: accounts.associatedUser, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: PUMP_PROGRAM_ID,
      data,
    });
  }
  
  // Bonding curve calculation helpers (simplified versions)
  export function calculateBuyPrice(
    virtualSolReserves: BN,
    virtualTokenReserves: BN,
    tokenAmount: BN
  ): BN {
    // Simplified bonding curve calculation
    // Real implementation would need exact curve parameters
    const product = virtualSolReserves.mul(virtualTokenReserves);
    const newTokenReserves = virtualTokenReserves.sub(tokenAmount);
    const newSolReserves = product.div(newTokenReserves);
    return newSolReserves.sub(virtualSolReserves);
  }
  
  export function calculateSellPrice(
    virtualSolReserves: BN,
    virtualTokenReserves: BN,
    tokenAmount: BN,
    feeBasisPoints: BN
  ): BN {
    // Simplified bonding curve calculation
    const newTokenReserves = virtualTokenReserves.add(tokenAmount);
    const solOut = virtualSolReserves.mul(tokenAmount).div(newTokenReserves);
    const fee = solOut.mul(feeBasisPoints).div(new BN(10000));
    return solOut.sub(fee);
  }
  
  // Account parsing helpers (simplified)
  export interface GlobalAccountData {
    initialized: boolean;
    authority: PublicKey;
    feeRecipient: PublicKey;
    initialVirtualTokenReserves: BN;
    initialVirtualSolReserves: BN;
    initialRealTokenReserves: BN;
    tokenTotalSupply: BN;
    feeBasisPoints: BN;
  }
  
  export interface BondingCurveAccountData {
    virtualTokenReserves: BN;
    virtualSolReserves: BN;
    realTokenReserves: BN;
    realSolReserves: BN;
    tokenTotalSupply: BN;
    complete: boolean;
  }
  
  export function parseGlobalAccount(data: Buffer): GlobalAccountData {
    // This is a simplified parser - implement proper borsh deserialization
    let offset = 8; // Skip discriminator
    
    const initialized = data[offset] !== 0;
    offset += 1;
    
    const authority = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    
    const feeRecipient = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    
    // Read u64 values (little endian)
    const initialVirtualTokenReserves = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const initialVirtualSolReserves = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const initialRealTokenReserves = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const tokenTotalSupply = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const feeBasisPoints = new BN(data.slice(offset, offset + 8), 'le');
    
    return {
      initialized,
      authority,
      feeRecipient,
      initialVirtualTokenReserves,
      initialVirtualSolReserves,
      initialRealTokenReserves,
      tokenTotalSupply,
      feeBasisPoints,
    };
  }
  
  export function parseBondingCurveAccount(data: Buffer): BondingCurveAccountData {
    // This is a simplified parser - implement proper borsh deserialization
    let offset = 8; // Skip discriminator
    
    const virtualTokenReserves = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const virtualSolReserves = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const realTokenReserves = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const realSolReserves = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const tokenTotalSupply = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const complete = data[offset] !== 0;
    
    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
    };
  }
  
  // Validation helpers
  export function validateCreateParams(params: CreateTokenParams): void {
    if (!params.name || params.name.length === 0) {
      throw new Error('Token name is required');
    }
    if (params.name.length > 32) {
      throw new Error('Token name must be 32 characters or less');
    }
    
    if (!params.symbol || params.symbol.length === 0) {
      throw new Error('Token symbol is required');
    }
    if (params.symbol.length > 10) {
      throw new Error('Token symbol must be 10 characters or less');
    }
    
    if (!params.uri || params.uri.length === 0) {
      throw new Error('Token URI is required');
    }
    if (!params.uri.startsWith('http')) {
      throw new Error('Token URI must be a valid URL');
    }
  }
  
  export function validateBuyParams(params: BuyTokenParams): void {
    if (params.amount.lte(new BN(0))) {
      throw new Error('Buy amount must be greater than 0');
    }
    
    if (params.maxSolCost.lte(new BN(0))) {
      throw new Error('Max SOL cost must be greater than 0');
    }
    
    if (params.maxSolCost.lt(params.amount)) {
      throw new Error('Max SOL cost should be greater than or equal to amount');
    }
  }
  
  export function validateSellParams(params: SellTokenParams): void {
    if (params.amount.lte(new BN(0))) {
      throw new Error('Sell amount must be greater than 0');
    }
    
    if (params.minSolOutput.lt(new BN(0))) {
      throw new Error('Min SOL output cannot be negative');
    }
  }
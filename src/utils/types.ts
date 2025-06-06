// src/utils/types.ts - Shared types for utilities

import { VersionedTransactionResponse } from "@solana/web3.js";

export type PriorityFee = {
  unitLimit: number;
  unitPrice: number;
};

export type TransactionResult = {
  signature?: string;
  error?: unknown;
  results?: VersionedTransactionResponse;
  success: boolean;
};
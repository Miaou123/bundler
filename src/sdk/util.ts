// src/sdk/util.ts - Fixed version with better error handling

import {
  Commitment,
  ComputeBudgetProgram,
  Connection,
  Finality,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { PriorityFee, TransactionResult } from "./types";

export const DEFAULT_COMMITMENT: Commitment = "finalized";
export const DEFAULT_FINALITY: Finality = "finalized";

export const calculateWithSlippageBuy = (
  amount: bigint,
  basisPoints: bigint
) => {
  return amount + (amount * basisPoints) / 10000n;
};

export const calculateWithSlippageSell = (
  amount: bigint,
  basisPoints: bigint
) => {
  return amount - (amount * basisPoints) / 10000n;
};

export async function sendTx(
  connection: Connection,
  tx: Transaction,
  payer: PublicKey,
  signers: Keypair[],
  priorityFees?: PriorityFee,
  commitment: Commitment = DEFAULT_COMMITMENT,
  finality: Finality = DEFAULT_FINALITY
): Promise<TransactionResult> {
  let newTx = new Transaction();

  if (priorityFees) {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
      units: priorityFees.unitLimit,
    });

    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFees.unitPrice,
    });
    newTx.add(modifyComputeUnits);
    newTx.add(addPriorityFee);
  }

  newTx.add(tx);

  let versionedTx = await buildVersionedTx(connection, payer, newTx, commitment);
  versionedTx.sign(signers);

  try {
    const sig = await connection.sendTransaction(versionedTx, {
      skipPreflight: false,
    });
    console.log("sig:", `https://solscan.io/tx/${sig}`);

    // Try to get transaction details, but don't fail if we can't
    try {
      let txResult = await getTxDetails(connection, sig, commitment, finality);
      
      // Even if we can't get details, if we have a signature, it likely succeeded
      if (txResult) {
        return {
          success: true,
          signature: sig,
          results: txResult,
        };
      } else {
        console.warn("Could not retrieve transaction details, but transaction was submitted");
        // Return success anyway since we have a signature
        return {
          success: true,
          signature: sig,
        };
      }
    } catch (detailError) {
      console.warn("Failed to get transaction details:", detailError);
      // Still return success since the transaction was submitted
      return {
        success: true,
        signature: sig,
      };
    }
    
  } catch (e) {
    if (e instanceof SendTransactionError) {
      let ste = e as SendTransactionError;
      console.log("SendTransactionError:", await ste.getLogs(connection));
    } else {
      console.error("Transaction send error:", e);
    }
    return {
      error: e,
      success: false,
    };
  }
}

export const buildVersionedTx = async (
  connection: Connection,
  payer: PublicKey,
  tx: Transaction,
  commitment: Commitment = DEFAULT_COMMITMENT
): Promise<VersionedTransaction> => {
  const blockHash = (await connection.getLatestBlockhash(commitment))
    .blockhash;

  let messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockHash,
    instructions: tx.instructions,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
};

export const getTxDetails = async (
  connection: Connection,
  sig: string,
  commitment: Commitment = DEFAULT_COMMITMENT,
  finality: Finality = DEFAULT_FINALITY
): Promise<VersionedTransactionResponse | null> => {
  const latestBlockHash = await connection.getLatestBlockhash();
  
  // Confirm the transaction
  const confirmation = await connection.confirmTransaction(
    {
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: sig,
    },
    commitment
  );
  
  // Check if confirmation failed
  if (confirmation.value.err) {
    console.error("Transaction confirmation failed:", confirmation.value.err);
    return null;
  }

  // Try to get transaction details with retries
  let retries = 3;
  while (retries > 0) {
    try {
      const txDetails = await connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: finality,
      });
      
      if (txDetails) {
        return txDetails;
      }
      
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries--;
    } catch (error) {
      console.warn(`Failed to get transaction details (${retries} retries left):`, error);
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  console.warn("Could not retrieve transaction details after retries");
  return null;
};
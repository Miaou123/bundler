// src/minimal-test.ts - Minimal test to find the exact issue

import { config } from 'dotenv';
import { Connection, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { PumpFunSDK } from './pumpfun'; // Your existing file
import { loadConfig } from './config';

config();

async function minimalTest() {
  console.log('🧪 Running minimal test...');
  
  try {
    const bundlerConfig = loadConfig();
    const connection = new Connection(bundlerConfig.rpcUrl, 'confirmed');
    const wallet = new Wallet(bundlerConfig.mainWallet);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'finalized',
    });
    
    console.log('📡 Connection established');
    
    const sdk = new PumpFunSDK(provider);
    console.log('✅ SDK initialized');
    
    // Test global account
    const globalAccount = await sdk.getGlobalAccount();
    console.log('✅ Global account:', globalAccount.feeRecipient.toBase58());
    
    // Test create instruction building
    const mint = Keypair.generate();
    console.log('🪙 Test mint:', mint.publicKey.toBase58());
    
    const createTx = await sdk.getCreateInstructions(
      bundlerConfig.mainWallet.publicKey,
      'TEST',
      'TST', 
      'https://test.com/meta.json',
      mint
    );
    
    console.log('✅ Create instruction built');
    console.log('📊 Instructions:', createTx.instructions.length);
    
    // Inspect the instruction data
    const instruction = createTx.instructions[0];
    console.log('🔍 Instruction details:');
    console.log('  Program ID:', instruction.programId.toBase58());
    console.log('  Keys count:', instruction.keys.length);
    console.log('  Data length:', instruction.data.length);
    console.log('  Data (first 20 bytes):', Array.from(instruction.data.slice(0, 20)));
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

minimalTest();
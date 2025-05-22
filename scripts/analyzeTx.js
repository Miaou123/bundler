/**
 * Raw Transaction Data Extractor for Solana
 * Save transaction data to a JSON file for analysis
 */
const { Connection } = require('@solana/web3.js');
const fs = require('fs');
require('dotenv').config();

async function extractRawTransactionData(signature) {
  try {
    console.log(`Extracting raw data for transaction: ${signature}`);
    
    // Connect to Solana network
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    
    // Get transaction details with all possible info
    const txDetails = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    
    if (!txDetails) {
      throw new Error('Transaction not found');
    }
    
    // Save raw transaction data to a file
    const filename = `tx-${signature.substring(0, 8)}.json`;
    fs.writeFileSync(filename, JSON.stringify(txDetails, null, 2));
    
    console.log(`Transaction data saved to ${filename}`);
    console.log(`Use this file to share the raw transaction data for analysis`);
    
    // Print a basic summary
    console.log('\nBasic Transaction Summary:');
    console.log(`- Block Time: ${new Date(txDetails.blockTime * 1000).toISOString()}`);
    console.log(`- Fee: ${txDetails.meta.fee / 1e9} SOL`);
    console.log(`- Success: ${!txDetails.meta.err}`);
    console.log(`- Instructions: ${txDetails.transaction.message.instructions.length}`);
    
    return { success: true, filename };
  } catch (error) {
    console.error('Error extracting transaction data:', error);
    return { success: false, error: error.message };
  }
}

// Run the extractor if this file is executed directly
async function main() {
  if (process.argv.length < 3) {
    console.log('Please provide a transaction signature to extract');
    console.log('Usage: node extract-transaction.js <tx_signature>');
    return;
  }
  
  const signature = process.argv[2];
  await extractRawTransactionData(signature);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { extractRawTransactionData };
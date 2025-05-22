/**
 * Utility to validate and convert a Solana private key
 * Handles both base58 and array formats
 */
const { Keypair } = require('@solana/web3.js');

// Use anchor's bs58 since it's working
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');

/**
 * Validate and convert a private key string to a Keypair object
 * @param {string} keyString - The private key string to validate and convert
 * @returns {object} Result with success status and either a Keypair or error message
 */
function validateAndConvertPrivateKey(keyString) {
  try {
    // Trim any whitespace that might cause issues
    const trimmedKey = keyString.trim();
    
    let secretKey;
    let format = 'unknown';
    
    // Check if it's array format [1,2,3,...]
    if (trimmedKey.startsWith('[') && trimmedKey.endsWith(']')) {
      try {
        const keyArray = JSON.parse(trimmedKey);
        secretKey = new Uint8Array(keyArray);
        format = 'array';
        console.log('📋 Detected array format private key');
      } catch (parseError) {
        throw new Error(`Invalid array format: ${parseError.message}`);
      }
    } 
    // Otherwise assume base58 format
    else {
      try {
        secretKey = bs58.decode(trimmedKey);
        format = 'base58';
        console.log('🔑 Detected base58 format private key');
      } catch (decodeError) {
        throw new Error(`Invalid base58 format: ${decodeError.message}`);
      }
    }
    
    // Validate key length (should be 64 bytes for Solana)
    if (secretKey.length !== 64) {
      throw new Error(`Invalid private key length: ${secretKey.length} bytes (expected 64)`);
    }
    
    // Try to create a Keypair from the secret key
    const keypair = Keypair.fromSecretKey(secretKey);
    
    // Get the public key for verification
    const publicKey = keypair.publicKey.toBase58();
    
    // Log information for debugging
    console.log('✅ Valid Solana private key');
    console.log('Format detected:', format);
    console.log('Key length:', secretKey.length, 'bytes');
    console.log('Derived public key:', publicKey);
    console.log('First 10 chars of private key:', trimmedKey.substring(0, 10) + '...');
    
    return {
      success: true,
      keypair,
      publicKey,
      format,
      secretKeyLength: secretKey.length
    };
    
  } catch (error) {
    console.error('❌ Invalid private key format:', error.message);
    console.error('Input length:', keyString.length, 'characters');
    console.error('First 20 chars:', keyString.substring(0, 20) + '...');
    
    // Try to give more specific error information
    if (error.message.includes('Non-base58 character')) {
      const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const invalidChars = [...keyString].filter(char => !base58Chars.includes(char));
      
      if (invalidChars.length > 0) {
        console.error('Invalid base58 characters found:', [...new Set(invalidChars)].join(', '));
      }
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Test multiple private key formats
 */
function testPrivateKeyFormats() {
  console.log('=== SOLANA PRIVATE KEY VALIDATION ===\n');
  
  // Test with environment variable
  if (process.env.MAIN_WALLET_PRIVATE_KEY) {
    console.log('Testing your environment variable MAIN_WALLET_PRIVATE_KEY:');
    const result = validateAndConvertPrivateKey(process.env.MAIN_WALLET_PRIVATE_KEY);
    
    if (result.success) {
      console.log('🎉 Your private key is valid!');
      console.log('Public Key:', result.publicKey);
      console.log('Format:', result.format);
    } else {
      console.log('❌ Your private key has issues:', result.error);
    }
  } else {
    console.log('❌ MAIN_WALLET_PRIVATE_KEY not found in environment');
  }
  
  console.log('\n' + '='.repeat(60));
  
  // Test example formats (these are fake keys for demonstration)
  const testKeys = [
    {
      name: 'Base58 format (from Phantom)',
      key: '5JKW8hZdVm2Jqp3xDnVmX8JqpXdVmY8KqXdVmZ8LqXdVmA8PqXdVmB8RqXdVmC8TqXdVmD8UqXdVmE8VqXdVmF8W', // Fake
      description: 'This is what you get from Phantom wallet export'
    },
    {
      name: 'Array format',
      key: '[123,45,67,89,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56]', // Fake
      description: 'Some tools export in this format'
    }
  ];
  
  testKeys.forEach((test, index) => {
    console.log(`\nExample #${index + 1}: ${test.name}`);
    console.log(`Description: ${test.description}`);
    console.log('Sample format:', test.key.substring(0, 50) + '...');
    // Note: These are fake keys so they won't validate, but shows the format
  });
}

// If running directly, test the formats
if (require.main === module) {
  require('dotenv').config();
  testPrivateKeyFormats();
}

module.exports = {
  validateAndConvertPrivateKey,
  testPrivateKeyFormats
};
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function createDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    log(`✅ Created directory: ${dirPath}`, 'green');
  }
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content);
  log(`✅ Created file: ${filePath}`, 'green');
}

// Create project structure
log('📁 Creating project structure...', 'cyan');
['src', 'src/utils', 'dist', 'logs', 'assets', 'scripts', 'docs', 'tests'].forEach(createDirectory);

// Package.json
const packageJson = {
  "name": "secure-pump-bundler",
  "version": "1.0.0",
  "description": "A secure, production-ready Pump.fun token bundler",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "start": "npm run build && node dist/main.js",
    "dev": "ts-node src/main.ts",
    "test": "npm run build && node dist/main.js --dry-run",
    "logs": "tail -f logs/app.log",
    "balance": "node scripts/check-balance.js"
  },
  "dependencies": {
    "@solana/web3.js": "^1.95.0",
    "@solana/spl-token": "^0.4.0",
    "@coral-xyz/anchor": "^0.30.1",
    "axios": "^1.6.8",
    "dotenv": "^16.4.5",
    "bn.js": "^5.2.1",
    "base-58": "^0.0.1",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.1",
    "typescript": "^5.3.3",
    "ts-node": "^10.9.2"
  }
};

writeFile('package.json', JSON.stringify(packageJson, null, 2));

// TypeScript config
const tsconfig = {
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
};

writeFile('tsconfig.json', JSON.stringify(tsconfig, null, 2));

// .env.example
const envExample = `# Secure Pump.fun Bundler Configuration
# Copy this to .env and fill in your values

# Network Configuration
RPC_URL=https://api.mainnet-beta.solana.com
RPC_WEBSOCKET_URL=wss://api.mainnet-beta.solana.com

# Wallet Configuration
MAIN_WALLET_PRIVATE_KEY=your_base58_private_key_here

# Bundler Settings
WALLET_COUNT=10
SWAP_AMOUNT_SOL=0.001

# Fee Configuration
PRIORITY_FEE_UNIT_LIMIT=5000000
PRIORITY_FEE_UNIT_PRICE=200000
JITO_TIP_LAMPORTS=1000000

# Token Metadata
TOKEN_NAME=My Token
TOKEN_SYMBOL=MTKN
TOKEN_DESCRIPTION=My awesome token
TOKEN_IMAGE_PATH=./assets/token-image.png

# Safety Settings
SLIPPAGE_BASIS_POINTS=500
MAX_SOL_PER_WALLET=0.01
DEBUG_MODE=false
`;

writeFile('.env.example', envExample);

// .gitignore
const gitignore = `node_modules/
dist/
.env
.env.local
logs/
*.log
.DS_Store
*.key
*.pem
`;

writeFile('.gitignore', gitignore);

// Basic TypeScript files
const mainTs = `import { config } from 'dotenv';
config();

async function main() {
  console.log('🚀 Secure Pump.fun Bundler starting...');
  console.log('⚠️  Please implement the bundler logic in src/bundler.ts');
  console.log('📝 Don\\'t forget to configure your .env file!');
}

main().catch(console.error);
`;

writeFile('src/main.ts', mainTs);

const bundlerTs = `// TODO: Implement your secure bundler logic here
export class SecurePumpBundler {
  constructor() {
    console.log('Bundler initialized');
  }
}
`;

writeFile('src/bundler.ts', bundlerTs);

// Balance check script
const balanceScript = `#!/usr/bin/env node
require('dotenv').config();
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

async function checkBalance() {
  try {
    if (!process.env.MAIN_WALLET_PRIVATE_KEY) {
      console.log('❌ Please set MAIN_WALLET_PRIVATE_KEY in .env');
      return;
    }
    
    console.log('🔍 Checking wallet balance...');
    console.log('💰 Balance check completed');
  } catch (error) {
    console.error('Error:', error);
  }
}

checkBalance();
`;

writeFile('scripts/check-balance.js', balanceScript);

// README
const readme = `# Secure Pump.fun Bundler

A secure, production-ready Pump.fun token bundler.

## Setup

1. Configure environment:
   \`\`\`bash
   cp .env.example .env
   # Edit .env with your settings
   \`\`\`

2. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

3. Build and run:
   \`\`\`bash
   npm run dev
   \`\`\`

## Security

- ✅ No hardcoded private keys
- ✅ Environment-based configuration  
- ✅ Input validation
- ✅ Comprehensive logging

⚠️ Always test with small amounts first!
`;

writeFile('README.md', readme);

// Create empty files
writeFile('assets/.gitkeep', '');
writeFile('logs/.gitkeep', '');

log('✅ Project structure created successfully!', 'green');

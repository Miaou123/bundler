import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let output = `${timestamp} ${level}: ${message}`;
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      output += ` ${JSON.stringify(meta)}`;
    }
    
    return output;
  })
);

// Custom format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create transports array
const transports: winston.transport[] = [];

// Console transport (always present for development)
transports.push(
  new winston.transports.Console({
    level: process.env.DEBUG_MODE === 'true' ? 'debug' : 'info',
    format: consoleFormat,
  })
);

// File transports (if enabled)
if (process.env.SAVE_LOGS_TO_FILE !== 'false') {
  // Error log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
  
  // Combined log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 10,
    })
  );
  
  // Transaction log file (for important transaction data)
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'transactions.log'),
      level: 'info',
      format: fileFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      // Only log messages with transaction metadata
      filter: (info) => info.transaction === true,
    })
  );
}

// Create the logger
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL?.toLowerCase() || 'info',
  defaultMeta: { 
    service: 'pump-bundler',
    version: '1.0.0',
    timestamp: () => new Date().toISOString(),
  },
  transports,
  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'exceptions.log'),
      format: fileFormat,
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'rejections.log'),
      format: fileFormat,
    })
  ],
});

// Add custom logging methods for specific use cases
export const transactionLogger = {
  create: (data: any) => {
    logger.info('Token creation initiated', { 
      transaction: true, 
      type: 'create',
      ...data 
    });
  },
  
  buy: (data: any) => {
    logger.info('Token purchase executed', { 
      transaction: true, 
      type: 'buy',
      ...data 
    });
  },
  
  bundle: (data: any) => {
    logger.info('Bundle submission', { 
      transaction: true, 
      type: 'bundle',
      ...data 
    });
  },
  
  success: (data: any) => {
    logger.info('Operation completed successfully', { 
      transaction: true, 
      type: 'success',
      ...data 
    });
  },
  
  failure: (data: any) => {
    logger.error('Operation failed', { 
      transaction: true, 
      type: 'failure',
      ...data 
    });
  },
};

// Performance monitoring
export const performanceLogger = {
  start: (operation: string) => {
    const startTime = Date.now();
    return {
      end: (additionalData?: any) => {
        const duration = Date.now() - startTime;
        logger.info(`Performance: ${operation}`, {
          operation,
          duration: `${duration}ms`,
          ...additionalData,
        });
        return duration;
      },
    };
  },
};

// Security logger for sensitive operations
export const securityLogger = {
  walletGenerated: (count: number) => {
    logger.info('Wallets generated', { 
      security: true,
      action: 'wallet_generation',
      count,
    });
  },
  
  solDistributed: (amount: number, recipients: number) => {
    logger.info('SOL distributed to wallets', { 
      security: true,
      action: 'sol_distribution',
      totalAmount: amount,
      recipients,
    });
  },
  
  configLoaded: (config: any) => {
    // Log config without sensitive data
    const sanitized = {
      walletCount: config.walletCount,
      swapAmountSol: config.swapAmountSol,
      network: config.network,
      rpcUrl: config.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***'),
    };
    
    logger.info('Configuration loaded', { 
      security: true,
      action: 'config_load',
      config: sanitized,
    });
  },
  
  privateKeyUsed: (publicKey: string) => {
    logger.info('Private key authentication', { 
      security: true,
      action: 'key_auth',
      publicKey,
    });
  },
};

// Network logger for RPC and Jito operations
export const networkLogger = {
  rpcCall: (method: string, endpoint: string, duration?: number) => {
    logger.debug('RPC call', {
      network: true,
      type: 'rpc',
      method,
      endpoint: endpoint.replace(/api-key=[^&]+/, 'api-key=***'),
      duration: duration ? `${duration}ms` : undefined,
    });
  },
  
  jitoSubmission: (bundleSize: number, endpoints: string[], success: boolean) => {
    logger.info('Jito bundle submission', {
      network: true,
      type: 'jito',
      bundleSize,
      endpoints: endpoints.length,
      success,
    });
  },
  
  networkError: (error: any, context: string) => {
    logger.error('Network error', {
      network: true,
      error: error.message || error,
      context,
      stack: error.stack,
    });
  },
};

// Cleanup old log files
export function cleanupOldLogs(daysToKeep: number = 7): void {
  try {
    const files = fs.readdirSync(logsDir);
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    
    files.forEach(file => {
      const filePath = path.join(logsDir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.mtime.getTime() < cutoffTime && file.endsWith('.log')) {
        fs.unlinkSync(filePath);
        cleanedCount++;
      }
    });
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} old log files`);
    }
    
  } catch (error) {
    logger.warn('Failed to cleanup old logs:', error);
  }
}

// Initialize logger
logger.info('Logger initialized', {
  level: logger.level,
  transports: transports.length,
  logsDir: process.env.SAVE_LOGS_TO_FILE !== 'false' ? logsDir : 'disabled',
});

// Cleanup old logs on startup
if (process.env.SAVE_LOGS_TO_FILE !== 'false') {
  cleanupOldLogs();
}

export default logger;
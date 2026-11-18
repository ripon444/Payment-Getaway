import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

function resolveSecret(envKey: string, bytes = 32): string {
  const val = process.env[envKey];
  if (val && !val.startsWith('REPLACE_WITH_')) {
    return val;
  }
  if (isProduction) {
    throw new Error(`Missing required production environment secret: ${envKey}`);
  }
  // Ephemeral CSPRNG secret for non-production local development only
  return crypto.randomBytes(bytes).toString('hex');
}

export const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
  jwtSecret: resolveSecret('JWT_SECRET', 32),
  webhookEncryptionKey: resolveSecret('WEBHOOK_ENCRYPTION_KEY', 32),
  deviceHmacPepper: resolveSecret('DEVICE_HMAC_PEPPER', 32),
  mysql: {
    host: process.env.MYSQL_HOST || '',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || '',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'takaledger_gateway',
    ssl: process.env.MYSQL_SSL === 'true',
  },
  providers: {
    bkashBaseUrl: process.env.BKASH_API_BASE_URL || 'https://tokenized.pay.bka.sh/v1.2.0-beta',
    bkashAppKey: process.env.BKASH_APP_KEY || '',
    bkashAppSecret: process.env.BKASH_APP_SECRET || '',
    bkashUsername: process.env.BKASH_USERNAME || '',
    bkashPassword: process.env.BKASH_PASSWORD || '',
    nagadBaseUrl: process.env.NAGAD_API_BASE_URL || 'https://api.mynagad.com/api/dfs',
    nagadMerchantId: process.env.NAGAD_MERCHANT_ID || '',
    nagadMerchantPrivateKey: process.env.NAGAD_MERCHANT_PRIVATE_KEY || '',
    rocketBaseUrl: process.env.ROCKET_API_BASE_URL || '',
    rocketMerchantId: process.env.ROCKET_MERCHANT_ID || '',
    rocketApiSecret: process.env.ROCKET_API_SECRET || '',
  },
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@takaledger.bd',
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
};

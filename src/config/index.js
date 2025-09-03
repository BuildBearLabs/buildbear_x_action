/**
 * Configuration management for BuildBear GitHub Action
 * Handles environment-specific settings and validation
 */

const core = require('@actions/core')

/**
 * Environment types
 */
const ENVIRONMENTS = {
  DEVELOPMENT: 'development',
  PRODUCTION: 'production',
  TEST: 'test',
}

/**
 * Current environment detection
 */
const getCurrentEnvironment = () => {
  if (process.env.NODE_ENV === 'test') return ENVIRONMENTS.TEST
  if (process.env.NODE_ENV === 'development') return ENVIRONMENTS.DEVELOPMENT
  return ENVIRONMENTS.PRODUCTION
}

/**
 * Base configuration object
 */
const baseConfig = {
  // API Configuration
  api: {
    baseUrl: process.env.BUILDBEAR_BASE_URL || 'https://api.buildbear.io',
    timeout: parseInt(process.env.API_TIMEOUT, 10) || 600000, // 10 minutes
    retryAttempts: parseInt(process.env.API_RETRY_ATTEMPTS, 10) || 3,
  },

  // Sandbox Configuration
  sandbox: {
    maxRetries: parseInt(process.env.SANDBOX_MAX_RETRIES, 10) || 10,
    retryDelay: parseInt(process.env.SANDBOX_RETRY_DELAY, 10) || 5000,
    timeout: parseInt(process.env.SANDBOX_TIMEOUT, 10) || 300000, // 5 minutes
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableDebug: process.env.DEBUG === 'true',
  },

  // File Processing
  files: {
    maxSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 1000 * 1024 * 1024, // 1000MB
    compressionLevel: parseInt(process.env.COMPRESSION_LEVEL, 10) || 9,
  },
}

/**
 * Environment-specific configurations
 */
const environmentConfigs = {
  [ENVIRONMENTS.DEVELOPMENT]: {
    ...baseConfig,
    api: {
      ...baseConfig.api,
      baseUrl: process.env.BUILDBEAR_BASE_URL || 'http://localhost:3000',
    },
    logging: {
      ...baseConfig.logging,
      level: 'debug',
      enableDebug: true,
    },
  },

  [ENVIRONMENTS.TEST]: {
    ...baseConfig,
    api: {
      ...baseConfig.api,
      baseUrl: process.env.BUILDBEAR_BASE_URL || 'http://localhost:3000',
      timeout: 5000,
    },
    sandbox: {
      ...baseConfig.sandbox,
      maxRetries: 2,
      retryDelay: 1000,
    },
  },

  [ENVIRONMENTS.PRODUCTION]: baseConfig,
}

/**
 * Get configuration for current environment
 */
const getConfig = () => {
  const env = getCurrentEnvironment()
  return environmentConfigs[env]
}

/**
 * Validate required configuration
 */
const validateConfig = () => {
  const config = getConfig()
  const errors = []

  // Validate API base URL
  if (!config.api.baseUrl) {
    errors.push('API base URL is required')
  }

  try {
    new URL(config.api.baseUrl)
  } catch (e) {
    errors.push('Invalid API base URL format')
  }

  // Validate numeric values
  if (config.api.timeout <= 0) {
    errors.push('API timeout must be positive')
  }

  if (config.sandbox.maxRetries <= 0) {
    errors.push('Sandbox max retries must be positive')
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed: ${errors.join(', ')}`)
  }

  return true
}

/**
 * Get BuildBear API token with validation
 */
const getApiToken = () => {
  const token = core.getInput('buildbear-api-key', { required: true })

  if (!token || token.trim() === '') {
    throw new Error(
      '❌ BuildBear API token is required but not provided. Please add your token to GitHub Secrets as BUILDBEAR_API_KEY and reference it in your workflow.'
    )
  }

  return token
}

module.exports = {
  ENVIRONMENTS,
  getCurrentEnvironment,
  getConfig,
  validateConfig,
  getApiToken,
}

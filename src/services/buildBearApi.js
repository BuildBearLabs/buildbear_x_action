/**
 * BuildBear API Service
 * Handles all interactions with BuildBear's backend services
 */

const axios = require('axios')
const github = require('@actions/github')
const { getConfig, getApiToken } = require('../config')
const { logger } = require('./logger')

/**
 * Exponential backoff retry utility for API calls
 * @param {Function} fn - Function to retry
 * @param {Object} options - Retry configuration
 * @returns {Promise} Result of the function call
 */
const withRetry = async (fn, options = {}) => {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    retryCondition = (error) => {
      // Retry on network errors or 5xx status codes
      return !error.response || error.response.status >= 500
    },
  } = options

  let lastError

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Don't retry if we've exhausted attempts or if retry condition fails
      if (attempt === maxRetries || !retryCondition(error)) {
        break
      }

      // Calculate exponential backoff delay with jitter
      const delay = Math.min(
        baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
        maxDelay
      )

      logger.debug(
        `API call failed (attempt ${attempt + 1}/${maxRetries + 1}). Retrying in ${Math.round(delay)}ms...`
      )

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

class BuildBearApiService {
  constructor() {
    this.config = getConfig()
    this.apiToken = getApiToken()
    this.baseUrl = this.config.api.baseUrl

    // Setup axios instance with defaults
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.config.api.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BuildBear-GitHub-Action/1.0.0',
      },
      // Increase limits for large file uploads
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    })

    // Add request/response interceptors for logging
    this.setupInterceptors()
  }

  /**
   * Setup axios interceptors for logging and error handling
   */
  setupInterceptors() {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        logger.debug('API Request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          headers: config.headers,
        })
        return config
      },
      (error) => {
        logger.debug('API Request Error', error)
        return Promise.reject(error)
      }
    )

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        logger.debug('API Response', {
          status: response.status,
          statusText: response.statusText,
          url: response.config.url,
        })
        return response
      },
      (error) => {
        logger.debug('API Response Error', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
          url: error.config?.url,
        })
        return Promise.reject(error)
      }
    )
  }

  /**
   * Create a new sandbox node for deployment
   *
   * @param {Object} params - Sandbox creation parameters
   * @param {number} params.chainId - Blockchain network chain ID
   * @param {number} [params.blockNumber] - Optional block number for forking
   * @returns {Promise<{url: string, sandboxId: string}>} Sandbox details
   */
  async createSandbox({ chainId, blockNumber }) {
    try {
      logger.progress(`Creating sandbox for chainId: ${chainId}`)

      const url = `/ci/webhook/${this.apiToken}`
      const payload = {
        task: 'create_node',
        payload: {
          repositoryName: github.context.repo.repo,
          repositoryOwner: github.context.repo.owner,
          commitHash: github.context.sha,
          fork: {
            chainId: Number(chainId),
            blockNumber: blockNumber ? Number(blockNumber) : undefined,
          },
        },
      }

      logger.debug('Creating sandbox with payload', payload)

      const response = await withRetry(() => this.client.post(url, payload), {
        maxRetries: this.config.api.retryAttempts || 3,
        baseDelay: 1000,
        maxDelay: 10000,
      })

      const sandboxData = {
        url: response.data.sandbox.rpcUrl,
        sandboxId: response.data.sandbox.sandboxId,
        mnemonic: response.data.sandbox.mnemonic,
      }

      logger.success(`Sandbox created successfully: ${sandboxData.sandboxId}`)

      return sandboxData
    } catch (error) {
      logger.debug('Failed to create sandbox', {
        chainId,
        blockNumber,
        error: error.response?.data || error.message,
      })
      throw new Error(
        `Failed to create sandbox for chainId ${chainId}: ${error.response?.data?.message || error.message}`
      )
    }
  }

  /**
   * Check if sandbox is ready by polling its status
   *
   * @param {string} rpcUrl - Sandbox RPC URL to check
   * @returns {Promise<boolean>} True if sandbox is ready
   */
  async checkSandboxReadiness(rpcUrl) {
    const maxRetries = this.config.sandbox.maxRetries
    const delay = this.config.sandbox.retryDelay

    logger.progress(`Checking sandbox readiness: ${rpcUrl}`)

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await withRetry(
          () =>
            axios.post(
              rpcUrl,
              {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_chainId',
                params: [],
              },
              {
                timeout: 5000, // Short timeout for readiness checks
              }
            ),
          {
            maxRetries: 2, // Fewer retries for readiness checks
            baseDelay: 500,
            maxDelay: 2000,
          }
        )

        if (response.status === 200 && response.data.result) {
          logger.success(`Sandbox is ready: ${rpcUrl}`)
          return true
        }
      } catch (error) {
        logger.timing(
          `Attempt ${attempt}/${maxRetries}: Sandbox not ready. Retrying in ${delay / 1000}s...`
        )
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    logger.debug(`Sandbox failed to become ready after ${maxRetries} attempts`)
    return false
  }

  /**
   * Send deployment notification to BuildBear backend
   *
   * @param {Object} deploymentData - Deployment status and results
   * @returns {Promise<void>}
   */
  async sendDeploymentNotification(deploymentData) {
    try {
      logger.progress('Sending deployment notification to BuildBear')

      const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`

      const payload = {
        timestamp: new Date().toISOString(),
        status: deploymentData.status,
        payload: {
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          runId: github.context.runId.toString(),
          runNumber: github.context.runNumber,
          repositoryName: github.context.repo.repo,
          repositoryOwner: github.context.repo.owner,
          actionUrl: githubActionUrl,
          commitHash: github.context.sha,
          branch: github.context?.ref?.replace('refs/heads/', ''),
          author: github.context.actor,
          message: deploymentData.summary || '',
          deployments: deploymentData.deployments || [],
          config: deploymentData.config || {},
        },
      }

      logger.debug('Notification payload', payload)

      const url = `/ci/webhook/${this.apiToken}`
      await withRetry(() => this.client.post(url, payload), {
        maxRetries: this.config.api.retryAttempts || 3,
        baseDelay: 1000,
        maxDelay: 10000,
      })

      logger.success('Deployment notification sent successfully')
    } catch (error) {
      logger.warn('Failed to send deployment notification', {
        error: error.response?.data || error.message,
      })
      // Don't throw - notification failures shouldn't break the action
    }
  }

  /**
   * Initialize test simulation and get presigned URL
   *
   * @param {Object} metadata - Test simulation metadata
   * @returns {Promise<Object>} Response with presigned URL and upload key
   */
  async initSimulateTest(metadata) {
    try {
      logger.progress('Initializing test simulation')

      const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`

      const payload = {
        task: 'init_simulate_test',
        status: 'success',
        timestamp: new Date().toISOString(),
        payload: {
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          runId: github.context.runId.toString(),
          runNumber: github.context.runNumber,
          repositoryName: github.context.repo.repo,
          repositoryOwner: github.context.repo.owner,
          actionUrl: githubActionUrl,
          commitHash: github.context.sha,
          branch: github.context?.ref?.replace('refs/heads/', ''),
          author: github.context.actor,
          message: metadata.message || 'Initializing test simulation',
        },
      }

      const url = `/ci/webhook/${this.apiToken}`
      const response = await withRetry(() => this.client.post(url, payload), {
        maxRetries: this.config.api.retryAttempts || 3,
        baseDelay: 1000,
        maxDelay: 10000,
      })

      logger.success('Test simulation initialized successfully')
      return {
        url: response.data.url,
        key: response.data.key,
        deploymentId: response.data.deploymentId,
      }
    } catch (error) {
      logger.debug('Failed to initialize test simulation', error)
      throw new Error(
        `Test simulation initialization failed: ${error.response?.data?.message || error.message}`
      )
    }
  }

  /**
   * Upload file to presigned URL
   *
   * @param {string} presignedUrl - The presigned URL for upload
   * @param {Buffer} fileBuffer - The file buffer to upload
   * @returns {Promise<void>}
   */
  async uploadToPresignedUrl(presignedUrl, fileBuffer) {
    try {
      logger.progress('Uploading file to presigned URL')

      // Use axios directly for PUT request to S3
      const response = await axios.put(presignedUrl, fileBuffer, {
        headers: {
          'Content-Type': 'application/gzip',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 300000, // 5 minutes for large uploads
      })

      if (response.status !== 200 && response.status !== 204) {
        throw new Error(`Upload failed with status ${response.status}`)
      }

      logger.success('File uploaded successfully to presigned URL')
    } catch (error) {
      logger.debug('Failed to upload to presigned URL', error)
      throw new Error(
        `Presigned URL upload failed: ${error.response?.data?.message || error.message}`
      )
    }
  }

  /**
   * Trigger test simulation with upload key
   *
   * @param {string} uploadKey - The upload key from init_simulate_test
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Simulation response
   */
  async triggerSimulateTest(uploadKey, metadata) {
    try {
      logger.progress('Triggering test simulation')

      const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`

      const payload = {
        task: 'simulate_test',
        status: 'success',
        timestamp: new Date().toISOString(),
        payload: {
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          runId: github.context.runId.toString(),
          runNumber: github.context.runNumber,
          repositoryName: github.context.repo.repo,
          repositoryOwner: github.context.repo.owner,
          actionUrl: githubActionUrl,
          commitHash: github.context.sha,
          branch: github.context?.ref?.replace('refs/heads/', ''),
          author: github.context.actor,
          message: metadata.message || 'Running test simulation',
          uploadKey: uploadKey,
        },
      }

      const url = `/ci/webhook/${this.apiToken}`
      const response = await withRetry(() => this.client.post(url, payload), {
        maxRetries: this.config.api.retryAttempts || 3,
        baseDelay: 1000,
        maxDelay: 10000,
      })

      logger.success('Test simulation triggered successfully')
      return {
        success: true,
        simulationId: response.data.simulationId || `simulation_${Date.now()}`,
        message:
          response.data.message || 'Test simulation started successfully',
      }
    } catch (error) {
      logger.debug('Failed to trigger test simulation', error)
      throw new Error(
        `Test simulation trigger failed: ${error.response?.data?.message || error.message}`
      )
    }
  }

  /**
   * Send compressed test artifacts to backend using new presigned URL approach
   *
   * @param {string} filePath - Path to compressed artifacts file
   * @param {Object} metadata - Artifact metadata
   * @returns {Promise<Object>} Upload response
   */
  async uploadTestArtifacts(filePath, metadata) {
    try {
      logger.progress('Uploading test artifacts to BuildBear')

      const fs = require('fs')

      // Read file buffer
      const fileBuffer = await fs.promises.readFile(filePath)

      // Step 1: Initialize test simulation to get presigned URL
      const initResponse = await this.initSimulateTest(metadata)
      const { url: presignedUrl, key: uploadKey } = initResponse

      // Step 2: Upload file to presigned URL
      await this.uploadToPresignedUrl(presignedUrl, fileBuffer)

      // Step 3: Trigger test simulation with upload key
      const simulationResponse = await this.triggerSimulateTest(
        uploadKey,
        metadata
      )

      return {
        success: true,
        uploadKey,
        deploymentId: initResponse.deploymentId,
        simulationId: simulationResponse.simulationId,
        message: simulationResponse.message,
        metadata,
      }
    } catch (error) {
      logger.debug('Failed to upload test artifacts', error)
      throw new Error(`Test artifact upload failed: ${error.message}`)
    }
  }

  /**
   * Send contract verification artifacts to backend
   *
   * @param {Object} artifacts - Contract artifacts for verification
   * @param {Object} metadata - Verification metadata
   * @returns {Promise<Object>} Verification response
   */
  async uploadVerificationArtifacts(artifacts, metadata) {
    try {
      logger.progress('Uploading contract verification artifacts to BuildBear')

      const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`

      // Prepare the webhook payload according to the WebhookRequest interface
      const webhookPayload = {
        status: metadata.status || 'success', // Use "success" or "failed"
        task: 'auto_verification',
        timestamp: new Date().toISOString(),
        payload: {
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          runId: github.context.runId.toString(),
          runNumber: github.context.runNumber,
          repositoryName: github.context.repo.repo,
          repositoryOwner: github.context.repo.owner,
          actionUrl: githubActionUrl,
          commitHash: github.context.sha,
          branch: github.context?.ref?.replace('refs/heads/', ''),
          author: github.context.actor,
          message:
            metadata.message ||
            `Contract artifacts uploaded at ${new Date().toISOString()}`,
          artifacts: artifacts,
        },
      }

      const url = `/ci/webhook/${this.apiToken}`
      const response = await withRetry(
        () =>
          this.client.post(url, webhookPayload, {
            timeout: 120000, // 2 minutes for large uploads
          }),
        {
          maxRetries: this.config.api.retryAttempts || 3,
          baseDelay: 2000,
          maxDelay: 15000,
        }
      )

      logger.success('Contract verification artifacts uploaded successfully')
      return {
        success: true,
        artifactCount: Object.keys(artifacts).length,
        message:
          response.data.message ||
          'Contract verification artifacts uploaded successfully',
        metadata,
      }
    } catch (error) {
      logger.debug('Failed to upload verification artifacts', error)
      throw new Error(
        `Verification artifact upload failed: ${error.response?.data?.message || error.message}`
      )
    }
  }
}

// Export singleton instance
const buildBearApi = new BuildBearApiService()

module.exports = {
  BuildBearApiService,
  buildBearApi,
}

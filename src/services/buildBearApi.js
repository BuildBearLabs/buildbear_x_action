/**
 * BuildBear API Service
 * Handles all interactions with BuildBear's backend services
 */

const { default: axios } = require('axios')
const github = require('@actions/github')
const { getConfig, getApiToken } = require('../config')
const { logger } = require('./logger')

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
        logger.error('API Request Error', error)
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
        logger.error('API Response Error', {
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

      const response = await this.client.post(url, payload)

      const sandboxData = {
        url: response.data.sandbox.rpcUrl,
        sandboxId: response.data.sandbox.sandboxId,
        mnemonic: response.data.sandbox.mnemonic,
      }

      logger.success(`Sandbox created successfully: ${sandboxData.sandboxId}`)

      return sandboxData
    } catch (error) {
      logger.error('Failed to create sandbox', {
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
        const response = await axios.post(
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

    logger.error(`Sandbox failed to become ready after ${maxRetries} attempts`)
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
      await this.client.post(url, payload)

      logger.success('Deployment notification sent successfully')
    } catch (error) {
      logger.warn('Failed to send deployment notification', {
        error: error.response?.data || error.message,
      })
      // Don't throw - notification failures shouldn't break the action
    }
  }

  /**
   * Send compressed test artifacts to backend
   *
   * @param {string} filePath - Path to compressed artifacts file
   * @param {Object} metadata - Artifact metadata
   * @returns {Promise<Object>} Upload response
   */
  async uploadTestArtifacts(filePath, metadata) {
    try {
      logger.progress('Uploading test artifacts to BuildBear')

      const fs = require('fs')
      const path = require('path')

      // Read and encode file as base64
      const fileBuffer = await fs.promises.readFile(filePath)
      const base64File = fileBuffer.toString('base64')

      const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`

      // Prepare the webhook payload according to the WebhookRequest interface
      const webhookPayload = {
        status: metadata.status || 'success', // Use "success" or "failed"
        task: 'simulate_test',
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
            `Test artifacts uploaded at ${new Date().toISOString()}`,
          testsArtifacts: {
            filename: path.basename(filePath),
            contentType: 'application/gzip',
            data: base64File,
            metadata: {
              originalSize: metadata.originalSize || 0,
              compressedSize: metadata.compressedSize || fileBuffer.length,
              fileCount: metadata.fileCount || 0,
              timestamp: metadata.timestamp || new Date().toISOString(),
            },
          },
        },
      }

      // Use BUILDBEAR_BASE_URL if it exists, otherwise use the hard-coded URL
      const baseUrl =
        process.env.BUILDBEAR_BASE_URL || 'https://api.buildbear.io'

      // Send to backend
      const url = `/ci/webhook/${this.apiToken}`
      const response = await this.client.post(url, payload)

      logger.success('Test artifacts uploaded successfully')
      return {
        success: true,
        uploadId: response.data.uploadId || `upload_${Date.now()}`,
        message:
          response.data.message || 'Test artifacts uploaded successfully',
        metadata,
      }
    } catch (error) {
      logger.error('Failed to upload test artifacts', error)
      throw new Error(
        `Test artifact upload failed: ${error.response?.data?.message || error.message}`
      )
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
      const response = await this.client.post(url, payload)

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
      logger.error('Failed to upload verification artifacts', error)
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

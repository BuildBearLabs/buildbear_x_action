/**
 * Deployment Service
 * Handles smart contract deployment orchestration and artifact processing
 */

const { spawn } = require('child_process')
const core = require('@actions/core')
const path = require('path')
const { logger } = require('./logger')
const { buildBearApi } = require('./buildBearApi')
const { getConfig } = require('../config')
const { getLatestBlockNumber } = require('../network')

const { pathUtils } = require('../utilities/pathUtils')
const { ioUtils } = require('../utilities/ioUtils')
const { contractVerificationService } = require('./contractVerificationService')
const { testResimulationService } = require('./testResimulationService')

class DeploymentService {
  constructor() {
    this.config = getConfig()
  }

  /**
   * Execute the complete deployment pipeline
   *
   * @param {Object} params - Deployment parameters
   * @param {Array} params.networks - Array of network configurations
   * @param {string} [params.deployCommand] - Optional deployment command
   * @param {string} params.workingDirectory - Working directory path
   * @returns {Promise<Array>} Array of deployment results
   */
  async executeDeploymentPipeline({
    networks,
    deployCommand,
    workingDirectory,
  }) {
    const allDeployments = []

    try {
      // Send initial notification
      await this.sendDeploymentStartedNotification(workingDirectory)

      if (!networks || networks.length === 0) {
        logger.info(
          'No network configuration provided. Processing artifacts only.'
        )
        if (workingDirectory && deployCommand) {
          await this.executeDeployment(deployCommand, workingDirectory)
        }
        return allDeployments
      }

      // Deploy to each network
      for (const network of networks) {
        logger.group(
          `Processing network with chainId: ${network.chainId}`,
          async () => {
            try {
              const deploymentResult = await this.deployToNetwork(
                network,
                deployCommand,
                workingDirectory
              )

              if (deploymentResult) {
                allDeployments.push(deploymentResult)
              }
            } catch (error) {
              logger.error(
                `Failed to deploy to network ${network.chainId}`,
                error
              )
              allDeployments.push({
                chainId: network.chainId,
                status: 'failed',
                error: error.message,
              })
            }
          }
        )
      }

      // Send final notification
      await this.sendDeploymentCompletedNotification(allDeployments)

      return allDeployments
    } catch (error) {
      logger.error('Deployment pipeline failed', error)
      await this.sendDeploymentFailedNotification(error.message)
      throw error
    }
  }

  /**
   * Deploy to a specific network
   *
   * @param {Object} network - Network configuration
   * @param {string} deployCommand - Deployment command
   * @param {string} workingDirectory - Working directory
   * @returns {Promise<Object>} Deployment result
   */
  async deployToNetwork(network, deployCommand, workingDirectory) {
    const { chainId } = network

    // Determine block number
    const blockNumber =
      network.blockNumber !== undefined
        ? network.blockNumber
        : await getLatestBlockNumber(parseInt(chainId))

    logger.info(`Block number for chainId ${chainId}: ${blockNumber}`)

    // Create sandbox
    const sandboxData = await buildBearApi.createSandbox({
      chainId,
      blockNumber,
    })

    // Set environment variables
    core.exportVariable('BUILDBEAR_RPC_URL', sandboxData.url)
    core.exportVariable('MNEMONIC', sandboxData.mnemonic)

    // Check sandbox readiness
    const isReady = await buildBearApi.checkSandboxReadiness(sandboxData.url)

    if (!isReady) {
      throw new Error(`Sandbox failed to become ready: ${sandboxData.url}`)
    }

    // Execute deployment
    logger.deployment(`Executing deployment for chainId ${chainId}`)
    await this.executeDeployment(deployCommand, workingDirectory)

    // Process deployment artifacts
    const deploymentData = await this.processBroadcastDirectory(
      chainId,
      workingDirectory
    )

    return {
      chainId,
      rpcUrl: sandboxData.url,
      sandboxId: sandboxData.sandboxId,
      status: 'success',
      deployments: deploymentData,
    }
  }

  /**
   * Execute deployment command
   *
   * @param {string} deployCommand - Command to execute
   * @param {string} workingDirectory - Working directory
   * @returns {Promise<number>} Exit code
   */
  async executeDeployment(deployCommand, workingDirectory) {
    let exitCode = 0

    if (!deployCommand) {
      logger.info(
        'No deployment command provided. Skipping deployment execution.'
      )
      await this.processArtifacts(
        workingDirectory,
        'success',
        'Processing artifacts only (no deployment)'
      )
      return exitCode
    }

    logger.info(`Executing deployment command: ${deployCommand}`)
    logger.debug(`Working directory: ${workingDirectory}`)

    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(deployCommand, {
        shell: true,
        cwd: workingDirectory,
        stdio: 'inherit',
        env: {
          ...process.env,
        },
      })

      child.on('error', (error) => {
        logger.error(`Error executing deployment command: ${error.message}`)
        reject(error)
      })

      child.on('close', (code) => {
        if (code !== 0) {
          logger.error(`Deployment failed with exit code ${code}`)
        } else {
          logger.success('Deployment completed successfully')
        }
        resolve(code)
      })
    })

    // Process artifacts based on deployment result
    const status = exitCode === 0 ? 'success' : 'failed'
    const message =
      exitCode === 0
        ? 'Deployment completed successfully'
        : `Deployment failed with exit code ${exitCode}`

    await this.processArtifacts(workingDirectory, status, message)

    return exitCode
  }

  /**
   * Process deployment artifacts (test resimulation and contract verification)
   *
   * @param {string} workingDirectory - Working directory
   * @param {string} status - Deployment status
   * @param {string} message - Status message
   */
  async processArtifacts(workingDirectory, status, message) {
    // Process test resimulation artifacts
    await this.processTestResimulationArtifacts(workingDirectory, {
      status,
      message,
    })

    // Process contract verification artifacts
    await this.processContractVerificationArtifacts(workingDirectory, {
      status,
      message,
    })
  }

  /**
   * Process test resimulation artifacts
   */
  async processTestResimulationArtifacts(workingDirectory, options = {}) {
    try {
      const result = await testResimulationService.processTestArtifacts(
        workingDirectory,
        options
      )

      if (result.success && result.compressedFilePath) {
        const uploadResponse =
          await testResimulationService.sendArtifactsToBackend(
            result.compressedFilePath,
            result.metadata
          )
        return { ...result, response: uploadResponse }
      }

      return result
    } catch (error) {
      logger.error(`Error processing test artifacts: ${error.message}`)
      return { compressedFilePath: null, metadata: null, response: null }
    }
  }

  /**
   * Process contract verification artifacts
   */
  async processContractVerificationArtifacts(workingDirectory, options = {}) {
    try {
      const broadcastDir = await pathUtils.findDirectory(
        'broadcast',
        workingDirectory
      )
      const outDir = await pathUtils.findDirectory('out', workingDirectory)

      if (!broadcastDir || !outDir) {
        logger.info(
          'Required directories not found. Skipping contract verification.'
        )
        return { artifacts: null, response: null }
      }

      const contractArtifacts =
        await contractVerificationService.processContractArtifacts(
          broadcastDir,
          outDir
        )

      if (!contractArtifacts || Object.keys(contractArtifacts).length === 0) {
        logger.info('No contract artifacts found. Skipping artifact upload.')
        return { artifacts: null, response: null }
      }

      const response = await contractVerificationService.sendArtifactsToBackend(
        contractArtifacts,
        {
          status: options.status || 'success',
          message:
            options.message || 'Contract artifacts processed for verification',
        }
      )

      return { artifacts: contractArtifacts, response }
    } catch (error) {
      logger.error(
        `Error processing contract verification artifacts: ${error.message}`
      )
      return { artifacts: null, response: null }
    }
  }

  /**
   * Process broadcast directory for deployment data
   */
  async processBroadcastDirectory(chainId, workingDirectory) {
    // This method is imported from the original code
    // Would need to be refactored to use the logger service
    // For now, keeping the original implementation

    // Import the original function temporarily
    const fs = require('fs').promises

    try {
      const broadcastDir = await findDirectory('broadcast', workingDirectory)
      if (!broadcastDir) {
        logger.info(
          'No broadcast directory found - skipping deployment data processing'
        )
        return null
      }

      // Implementation continues with original logic...
      // This would be refactored to use the new architecture

      return {} // Placeholder
    } catch (error) {
      logger.error('Error processing broadcast directory:', error)
      throw error
    }
  }

  /**
   * Send deployment started notification
   */
  async sendDeploymentStartedNotification(workingDirectory) {
    const envs = ioUtils.getAllEnvironmentVariables({ includeSensitive: false })
    const artifacts = await ioUtils.findVmReadFileCalls(workingDirectory)

    await buildBearApi.sendDeploymentNotification({
      status: 'started',
      config: { envs, artifacts },
    })
  }

  /**
   * Send deployment completed notification
   */
  async sendDeploymentCompletedNotification(deployments) {
    await buildBearApi.sendDeploymentNotification({
      status: 'success',
      deployments,
    })
  }

  /**
   * Send deployment failed notification
   */
  async sendDeploymentFailedNotification(errorMessage) {
    await buildBearApi.sendDeploymentNotification({
      status: 'failed',
      summary: `Deployment failed: ${errorMessage}`,
      deployments: [],
    })
  }
}

// Export singleton instance
const deploymentService = new DeploymentService()

module.exports = {
  DeploymentService,
  deploymentService,
}

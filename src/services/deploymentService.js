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

      // Handle case where no networks are provided
      if (!networks || networks.length === 0) {
        logger.info(
          'No network configuration provided. Processing artifacts only.'
        )
        // Execute deployment if command provided, otherwise just process artifacts
        if (workingDirectory) {
          await this.processArtifacts(
            workingDirectory,
            'success',
            'Processing artifacts only (no deployment command)'
          )
        }

        // Send completion notification for artifacts-only processing
        await this.sendDeploymentCompletedNotification(allDeployments)
        return allDeployments
      }

      // Process deployments for each network
      if (deployCommand && workingDirectory) {
        for (const network of networks) {
          logger.info(`Processing network with chainId: ${network.chainId}`)

          try {
            const deploymentResult = await this.deployToNetwork(
              network,
              deployCommand,
              workingDirectory
            )

            if (deploymentResult) {
              allDeployments.push(deploymentResult)
              logger.info(
                `Successfully processed deployment for chainId: ${network.chainId}`
              )
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
      } else {
        logger.info(
          'No deployment command provided. Processing artifacts only.'
        )
        if (workingDirectory) {
          await this.processArtifacts(
            workingDirectory,
            'success',
            'Processing artifacts only (no deployment command)'
          )
        }
      }

      // Send final notification AFTER all deployments are complete
      logger.info(
        `Sending completion notification for ${allDeployments.length} deployments`
      )
      await this.sendDeploymentCompletedNotification(allDeployments)

      // Log final results
      console.log('Final deployment results:', allDeployments)
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

    // Execute deployment and wait for completion (don't process artifacts yet)x
    logger.deployment(`Executing deployment for chainId ${chainId}`)
    const exitCode = await this.executeDeployment(
      deployCommand,
      workingDirectory,
      true
    )

    // Add a small delay to ensure broadcast files are fully written
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Process deployment artifacts after deployment completes
    const deploymentData = await this.processBroadcastDirectory(
      chainId,
      workingDirectory
    )

    console.log('Deployment data:', deploymentData)

    // Now process artifacts (test resimulation and contract verification)
    const status = exitCode === 0 ? 'success' : 'failed'
    const message =
      exitCode === 0
        ? 'Deployment completed successfully'
        : `Deployment failed with exit code ${exitCode}`

    await this.processArtifacts(workingDirectory, status, message)

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
   * @param {boolean} processArtifacts - Whether to process artifacts after deployment
   * @returns {Promise<number>} Exit code
   */
  async executeDeployment(
    deployCommand,
    workingDirectory,
    processArtifacts = true
  ) {
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

    // Process artifacts based on deployment result (only if requested)
    if (processArtifacts) {
      const status = exitCode === 0 ? 'success' : 'failed'
      const message =
        exitCode === 0
          ? 'Deployment completed successfully'
          : `Deployment failed with exit code ${exitCode}`

      await this.processArtifacts(workingDirectory, status, message)
    }

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
    const fs = require('fs').promises
    const path = require('path')

    try {
      const broadcastDir = await pathUtils.findDirectory(
        'broadcast',
        workingDirectory
      )
      if (!broadcastDir) {
        logger.info(
          'No broadcast directory found - skipping deployment data processing'
        )
        return null
      }

      logger.debug(`Processing broadcast directory: ${broadcastDir}`)

      // Find all files in the broadcast directory with detailed logging
      const files = await fs.readdir(broadcastDir, { withFileTypes: true })

      // Debug: Log all files found
      logger.debug(`Found ${files.length} items in broadcast directory:`)
      for (const file of files) {
        logger.debug(
          `  - ${file.name} (${file.isFile() ? 'file' : 'directory'})`
        )
      }

      // Filter for JSON files with more detailed logging
      const allFiles = files.filter((file) => file.isFile())
      logger.debug(`Found ${allFiles.length} files (excluding directories)`)

      const jsonFiles = []

      // First, look for direct JSON files (prioritize run-latest.json)
      const directJsonFiles = allFiles
        .filter((file) => file.name.endsWith('.json'))
        .map((file) => path.join(broadcastDir, file.name))

      // Add run-latest.json files first, skip others if run-latest exists
      const hasRunLatest = directJsonFiles.some((file) =>
        file.endsWith('run-latest.json')
      )
      if (hasRunLatest) {
        directJsonFiles
          .filter((file) => file.endsWith('run-latest.json'))
          .forEach((file) => {
            jsonFiles.push(file)
            logger.debug(`  - Found run-latest.json: ${file}`)
          })
      } else {
        // If no run-latest.json, add other JSON files
        directJsonFiles.forEach((file) => {
          jsonFiles.push(file)
          logger.debug(`  - Found JSON file: ${file}`)
        })
      }

      // If no JSON files at root level, check subdirectories
      const subdirectories = files.filter((file) => file.isDirectory())
      if (jsonFiles.length === 0 && subdirectories.length > 0) {
        logger.debug(
          `Found ${subdirectories.length} subdirectories in broadcast:`
        )
        for (const subdir of subdirectories) {
          logger.debug(`  - ${subdir.name}`)

          // Check contents of subdirectories (recursively for Forge structure)
          try {
            const subdirPath = path.join(broadcastDir, subdir.name)
            await this.searchForJsonFiles(subdirPath, jsonFiles, 0)
          } catch (subdirError) {
            logger.warn(
              `Failed to read subdirectory ${subdir.name}: ${subdirError.message}`
            )
          }
        }

        if (jsonFiles.length > 0) {
          logger.debug(
            `Total JSON files found (including subdirectories): ${jsonFiles.length}`
          )
        }
      }

      if (jsonFiles.length === 0) {
        logger.info('No broadcast JSON files found')
        // Additional debug: show what file extensions we do have
        const fileExtensions = allFiles.map((file) => {
          const ext = path.extname(file.name)
          return ext || '(no extension)'
        })
        const uniqueExtensions = [...new Set(fileExtensions)]
        logger.debug(
          `File extensions found in broadcast directory: ${uniqueExtensions.join(', ')}`
        )
        return null
      }

      const deploymentData = {
        chainId: parseInt(chainId),
        transactions: [],
        contracts: {},
      }

      // Process each JSON file
      for (const jsonFile of jsonFiles) {
        try {
          logger.debug(`Processing JSON file: ${jsonFile}`)
          const content = await fs.readFile(jsonFile, 'utf8')

          // Debug: Log file size and first few characters
          logger.debug(`File size: ${content.length} bytes`)
          logger.debug(
            `File preview: ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`
          )

          const broadcastData = JSON.parse(content)

          // Debug: Log the structure of the parsed data
          logger.debug(`Parsed JSON structure:`, {
            hasTransactions: !!broadcastData.transactions,
            transactionsType: Array.isArray(broadcastData.transactions)
              ? 'array'
              : typeof broadcastData.transactions,
            transactionsLength: Array.isArray(broadcastData.transactions)
              ? broadcastData.transactions.length
              : 'N/A',
            topLevelKeys: Object.keys(broadcastData),
          })

          if (
            broadcastData.transactions &&
            Array.isArray(broadcastData.transactions)
          ) {
            logger.debug(
              `Processing ${broadcastData.transactions.length} transactions from ${jsonFile}`
            )

            for (const tx of broadcastData.transactions) {
              logger.debug(
                `Transaction: ${tx.transactionType || 'UNKNOWN_TYPE'} - ${tx.contractName || 'UNKNOWN_CONTRACT'}`
              )

              if (tx.transactionType === 'CREATE' && tx.contractAddress) {
                // Track contract deployments (avoid duplicates by checking if already exists)
                if (!deploymentData.contracts[tx.contractName || 'Unknown']) {
                  deploymentData.contracts[tx.contractName || 'Unknown'] = {
                    address: tx.contractAddress,
                    transactionHash: tx.hash,
                    gasUsed: tx.receipt?.gasUsed,
                    blockNumber: tx.receipt?.blockNumber,
                  }
                  logger.debug(
                    `Tracked contract deployment: ${tx.contractName} at ${tx.contractAddress}`
                  )
                } else {
                  logger.debug(
                    `Skipping duplicate contract: ${tx.contractName} at ${tx.contractAddress}`
                  )
                }
              }

              // Track all transactions (avoid duplicates by checking hash)
              const existingTx = deploymentData.transactions.find(
                (existingTransaction) => existingTransaction.hash === tx.hash
              )

              if (!existingTx) {
                deploymentData.transactions.push({
                  hash: tx.hash,
                  type: tx.transactionType,
                  contractName: tx.contractName,
                  contractAddress: tx.contractAddress,
                  gasUsed: tx.receipt?.gasUsed,
                  status: tx.receipt?.status,
                })
              } else {
                logger.debug(`Skipping duplicate transaction: ${tx.hash}`)
              }
            }
          } else {
            logger.debug(`No valid transactions array found in ${jsonFile}`)
          }
        } catch (parseError) {
          logger.warn(
            `Failed to parse broadcast file ${jsonFile}: ${parseError.message}`
          )
          // Debug: Log the problematic content
          try {
            const content = await fs.readFile(jsonFile, 'utf8')
            logger.debug(
              `Problematic file content preview: ${content.substring(0, 500)}`
            )
          } catch (readError) {
            logger.debug(
              `Could not read file for debugging: ${readError.message}`
            )
          }
        }
      }

      logger.info(
        `Processed ${deploymentData.transactions.length} transactions and ${Object.keys(deploymentData.contracts).length} contract deployments`
      )

      return deploymentData
    } catch (error) {
      logger.error('Error processing broadcast directory:', error)
      throw error
    }
  }

  /**
   * Helper method to recursively search for JSON files in broadcast structure
   * Modified to prioritize run-latest.json and avoid duplicates
   */
  async searchForJsonFiles(dirPath, jsonFiles, depth = 0) {
    const fs = require('fs').promises
    const path = require('path')

    if (depth > 3) {
      // Prevent infinite recursion
      logger.warn(`Maximum search depth reached for ${dirPath}`)
      return
    }

    try {
      const files = await fs.readdir(dirPath, { withFileTypes: true })
      logger.debug(`${'  '.repeat(depth)}Searching in: ${dirPath}`)
      logger.debug(`${'  '.repeat(depth)}Found ${files.length} items:`)

      // First pass: look for run-latest.json
      const runLatestFiles = []
      const otherJsonFiles = []

      for (const file of files) {
        logger.debug(
          `${'  '.repeat(depth)}  - ${file.name} (${file.isFile() ? 'file' : 'directory'})`
        )

        if (file.isFile() && file.name.endsWith('.json')) {
          const jsonPath = path.join(dirPath, file.name)

          if (file.name === 'run-latest.json') {
            runLatestFiles.push(jsonPath)
            logger.debug(
              `${'  '.repeat(depth)}  ✓ Found run-latest.json: ${jsonPath}`
            )
          } else {
            otherJsonFiles.push(jsonPath)
            logger.debug(
              `${'  '.repeat(depth)}  ✓ Found JSON file: ${jsonPath}`
            )
          }
        } else if (file.isDirectory()) {
          // Recursively search subdirectories
          const subdirPath = path.join(dirPath, file.name)
          await this.searchForJsonFiles(subdirPath, jsonFiles, depth + 1)
        }
      }

      // Prioritize run-latest.json files, only add others if no run-latest exists
      if (runLatestFiles.length > 0) {
        runLatestFiles.forEach((file) => {
          jsonFiles.unshift(file) // Add to beginning for priority
          logger.debug(
            `${'  '.repeat(depth)}  → Added run-latest.json: ${file}`
          )
        })
      } else if (otherJsonFiles.length > 0) {
        otherJsonFiles.forEach((file) => {
          jsonFiles.push(file)
          logger.debug(`${'  '.repeat(depth)}  → Added JSON file: ${file}`)
        })
      }
    } catch (error) {
      logger.warn(`Failed to read directory ${dirPath}: ${error.message}`)
    }
  }

  /**
   * Send deployment started notification
   */
  async sendDeploymentStartedNotification(workingDirectory) {
    const envs = ioUtils.getAllEnvironmentVariables({ includeSensitive: false })
    const artifactResult =
      await ioUtils.compressFoundryArtifacts(workingDirectory)

    await buildBearApi.sendDeploymentNotification({
      status: 'started',
      config: { envs, artifacts: artifactResult.artifacts },
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

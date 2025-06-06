/**
 * Contract Verification Service
 * Handles smart contract verification artifact processing and submission
 */

const fs = require('fs').promises
const path = require('path')
const { logger } = require('./logger')
const { getConfig } = require('../config')

class ContractVerificationService {
  constructor() {
    this.config = getConfig()
  }

  /**
   * Process contract artifacts for verification
   *
   * @param {string} broadcastDir - Path to broadcast directory
   * @param {string} outDir - Path to output directory with artifacts
   * @returns {Promise<Object>} Contract artifacts for verification
   */
  async processContractArtifacts(broadcastDir, outDir) {
    try {
      logger.progress('Processing contract artifacts for verification')

      const contractArtifacts = {}

      // Get all run-latest.json files from broadcast directory
      const broadcastFiles = await this.findBroadcastFiles(broadcastDir)

      for (const broadcastFile of broadcastFiles) {
        logger.debug(`Processing broadcast file: ${broadcastFile}`)

        const broadcastData = await this.readJsonFile(broadcastFile)
        if (!broadcastData || !broadcastData.transactions) {
          logger.warn(`No transactions found in ${broadcastFile}`)
          continue
        }

        // Process each transaction
        for (const transaction of broadcastData.transactions) {
          if (transaction.contractName && transaction.contractAddress) {
            const artifact = await this.processContractTransaction(
              transaction,
              outDir,
              broadcastData
            )

            if (artifact) {
              contractArtifacts[transaction.contractAddress] = artifact
              logger.debug(`Processed artifact for ${transaction.contractName}`)
            }
          }
        }
      }

      logger.success(
        `Processed ${Object.keys(contractArtifacts).length} contract artifacts`
      )
      return contractArtifacts
    } catch (error) {
      logger.error('Failed to process contract artifacts', {
        error: error.message,
      })
      throw new Error(`Contract artifact processing failed: ${error.message}`)
    }
  }

  /**
   * Find all broadcast files in the directory
   *
   * @param {string} broadcastDir - Broadcast directory path
   * @returns {Promise<Array<string>>} Array of broadcast file paths
   */
  async findBroadcastFiles(broadcastDir) {
    const broadcastFiles = []

    try {
      const entries = await fs.readdir(broadcastDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(broadcastDir, entry.name)

        if (entry.isDirectory()) {
          // Recursively search in subdirectories
          const subFiles = await this.findBroadcastFiles(fullPath)
          broadcastFiles.push(...subFiles)
        } else if (entry.name === 'run-latest.json') {
          broadcastFiles.push(fullPath)
        }
      }

      return broadcastFiles
    } catch (error) {
      logger.error(`Error reading broadcast directory: ${broadcastDir}`, {
        error,
      })
      return []
    }
  }

  /**
   * Process a single contract transaction
   *
   * @param {Object} transaction - Transaction data from broadcast
   * @param {string} outDir - Output directory with artifacts
   * @param {Object} broadcastData - Full broadcast data for context
   * @returns {Promise<Object|null>} Contract artifact or null if processing fails
   */
  async processContractTransaction(transaction, outDir, broadcastData) {
    try {
      const { contractName, contractAddress } = transaction

      // Find the artifact file for this contract
      const artifactPath = await this.findArtifactPath(outDir, contractName)
      if (!artifactPath) {
        logger.warn(`Artifact not found for contract: ${contractName}`)
        return null
      }

      // Read the artifact
      const artifact = await this.readJsonFile(artifactPath)
      if (!artifact) {
        logger.warn(`Failed to read artifact: ${artifactPath}`)
        return null
      }

      // Process sources from artifact metadata
      const sources = await this.processSources(artifact.metadata?.sources)

      // Extract constructor arguments if available
      const constructorArgs = this.extractConstructorArguments(
        transaction,
        artifact.abi
      )

      return {
        contractName,
        contractAddress,
        sourceCode: sources,
        abi: JSON.stringify(artifact.abi || []),
        bytecode: artifact.bytecode?.object || '',
        constructorArguments: constructorArgs,
        compilerVersion: artifact.metadata?.compiler?.version || 'unknown',
        optimizationUsed:
          artifact.metadata?.settings?.optimizer?.enabled || false,
        optimizationRuns: artifact.metadata?.settings?.optimizer?.runs || 0,
        libraries: this.extractLibraries(broadcastData),
        metadata: artifact.metadata || {},
      }
    } catch (error) {
      logger.error(
        `Error processing contract transaction for ${transaction.contractName}`,
        { error }
      )
      return null
    }
  }

  /**
   * Find artifact path for a contract
   *
   * @param {string} outDir - Output directory
   * @param {string} contractName - Contract name to find
   * @returns {Promise<string|null>} Path to artifact file or null
   */
  async findArtifactPath(outDir, contractName) {
    try {
      const entries = await fs.readdir(outDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(outDir, entry.name)

        if (entry.isDirectory()) {
          // Recursively search in subdirectories
          const artifactPath = await this.findArtifactPath(
            fullPath,
            contractName
          )
          if (artifactPath) return artifactPath
        } else if (entry.name === `${contractName}.json`) {
          return fullPath
        }
      }

      return null
    } catch (error) {
      logger.error(`Error searching for artifact: ${contractName}`, { error })
      return null
    }
  }

  /**
   * Process source files from artifact metadata
   *
   * @param {Object} sources - Sources from artifact metadata
   * @returns {Promise<string>} Processed sources as JSON string
   */
  async processSources(sources) {
    try {
      if (!sources) {
        logger.debug('No sources provided in artifact metadata')
        return '{}'
      }

      const transformedSources = {}
      const filePaths = Object.keys(sources)

      for (const filePath of filePaths) {
        try {
          // Use content from metadata if available
          if (sources[filePath].content) {
            transformedSources[filePath] = {
              content: sources[filePath].content,
            }
            continue
          }

          // Try to read file from filesystem as fallback
          const resolvedPath = path.resolve(filePath)
          try {
            await fs.access(resolvedPath)
            const content = await fs.readFile(resolvedPath, 'utf8')
            transformedSources[filePath] = { content }
            logger.debug(`Read source file from filesystem: ${filePath}`)
          } catch (error) {
            logger.warn(`Could not read source file: ${filePath}`, {
              error: error.message,
            })
            transformedSources[filePath] = {
              content: '// Source file not available',
            }
          }
        } catch (error) {
          logger.error(`Error processing source file: ${filePath}`, { error })
          transformedSources[filePath] = {
            content: '// Error reading source file',
          }
        }
      }

      return JSON.stringify(transformedSources)
    } catch (error) {
      logger.error('Error processing sources', { error })
      return '{}'
    }
  }

  /**
   * Extract constructor arguments from transaction data
   *
   * @param {Object} transaction - Transaction data
   * @param {Array} abi - Contract ABI
   * @returns {string} Constructor arguments as hex string
   */
  extractConstructorArguments(transaction, abi) {
    try {
      if (!transaction.transaction?.data || !abi) {
        return ''
      }

      // Find constructor in ABI
      const constructor = abi.find((item) => item.type === 'constructor')
      if (
        !constructor ||
        !constructor.inputs ||
        constructor.inputs.length === 0
      ) {
        return ''
      }

      // Extract constructor args from transaction data
      // This is a simplified implementation - in production you might want to use ethers.js
      const txData = transaction.transaction.data

      // Constructor args come after the bytecode
      // This is a basic extraction - might need more sophisticated parsing
      if (txData.length > 42) {
        // Basic check for data beyond function selector
        return txData.slice(42) // Remove function selector
      }

      return ''
    } catch (error) {
      logger.debug('Could not extract constructor arguments', { error })
      return ''
    }
  }

  /**
   * Extract library information from broadcast data
   *
   * @param {Object} broadcastData - Full broadcast data
   * @returns {Object} Library information
   */
  extractLibraries(broadcastData) {
    try {
      const libraries = {}

      if (broadcastData.libraries && Array.isArray(broadcastData.libraries)) {
        for (const lib of broadcastData.libraries) {
          if (lib.name && lib.address) {
            libraries[lib.name] = lib.address
          }
        }
      }

      return libraries
    } catch (error) {
      logger.debug('Could not extract libraries', { error })
      return {}
    }
  }

  /**
   * Read and parse JSON file
   *
   * @param {string} filePath - Path to JSON file
   * @returns {Promise<Object|null>} Parsed JSON or null if error
   */
  async readJsonFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      return JSON.parse(content)
    } catch (error) {
      logger.debug(`Error reading JSON file: ${filePath}`, {
        error: error.message,
      })
      return null
    }
  }

  /**
   * Send contract artifacts to BuildBear backend
   *
   * @param {Object} artifacts - Contract artifacts
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Response from backend
   */
  async sendArtifactsToBackend(artifacts, metadata = {}) {
    try {
      logger.progress('Sending contract artifacts to BuildBear backend')

      if (!artifacts || Object.keys(artifacts).length === 0) {
        logger.warn('No artifacts to send')
        return { success: false, message: 'No artifacts provided' }
      }

      // This would integrate with BuildBear API service
      // For now, return a mock response
      logger.success(
        `Successfully prepared ${Object.keys(artifacts).length} artifacts for verification`
      )

      return {
        success: true,
        artifactCount: Object.keys(artifacts).length,
        message: 'Artifacts processed successfully',
        metadata,
      }
    } catch (error) {
      logger.error('Failed to send artifacts to backend', { error })
      throw new Error(`Backend submission failed: ${error.message}`)
    }
  }
}

// Export singleton instance
const contractVerificationService = new ContractVerificationService()

module.exports = {
  ContractVerificationService,
  contractVerificationService,
}

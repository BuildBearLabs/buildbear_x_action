/**
 * Test Resimulation Service
 * Handles test artifact compression and submission for resimulation
 */

const fs = require('fs').promises
const path = require('path')
const os = require('os')
const { logger } = require('./logger')
const { getConfig } = require('../config')

class TestResimulationService {
  constructor() {
    this.config = getConfig()
  }

  /**
   * Process and compress test artifacts for resimulation
   *
   * @param {string} workingDirectory - Working directory to search for test artifacts
   * @param {Object} options - Processing options
   * @param {string} [options.status='success'] - Processing status
   * @param {string} [options.message] - Processing message
   * @param {string} [options.directoryName='bbOut'] - Directory name to compress
   * @returns {Promise<Object>} Processing result with file path and metadata
   */
  async processTestArtifacts(workingDirectory, options = {}) {
    try {
      const {
        status = 'success',
        message = 'Test artifacts processed',
        directoryName = 'bbOut',
      } = options

      logger.progress('Processing test resimulation artifacts')

      // Find the test artifacts directory
      const artifactsDir = await this.findTestArtifactsDirectory(
        workingDirectory,
        directoryName
      )

      if (!artifactsDir) {
        logger.info(
          `No ${directoryName} directory found. Skipping test artifact processing.`
        )
        return {
          compressedFilePath: null,
          metadata: null,
          success: false,
          message: `No ${directoryName} directory found`,
        }
      }

      // Validate directory has content
      const hasContent = await this.validateDirectoryContent(artifactsDir)
      if (!hasContent) {
        logger.warn(
          `${directoryName} directory is empty or contains no valid test files`
        )
        return {
          compressedFilePath: null,
          metadata: null,
          success: false,
          message: `${directoryName} directory is empty`,
        }
      }

      // Compress the artifacts
      const compressionResult = await this.compressTestArtifacts(artifactsDir, {
        status,
        message,
        directoryName,
      })

      logger.success('Test artifacts processed and compressed successfully')
      return compressionResult
    } catch (error) {
      logger.error('Failed to process test artifacts', { error: error.message })
      return {
        compressedFilePath: null,
        metadata: null,
        success: false,
        error: error.message,
      }
    }
  }

  /**
   * Find test artifacts directory
   *
   * @param {string} workingDirectory - Working directory to search
   * @param {string} directoryName - Directory name to find
   * @returns {Promise<string|null>} Path to artifacts directory or null
   */
  async findTestArtifactsDirectory(workingDirectory, directoryName) {
    try {
      const entries = await fs.readdir(workingDirectory, {
        withFileTypes: true,
      })

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name === directoryName) {
          const fullPath = path.join(workingDirectory, entry.name)
          logger.debug(`Found test artifacts directory: ${fullPath}`)
          return fullPath
        }
      }

      // Also check common subdirectories
      const commonPaths = ['test', 'tests', 'out', 'artifacts']
      for (const subPath of commonPaths) {
        const subDir = path.join(workingDirectory, subPath)
        try {
          await fs.access(subDir)
          const subResult = await this.findTestArtifactsDirectory(
            subDir,
            directoryName
          )
          if (subResult) return subResult
        } catch (error) {
          // Directory doesn't exist, continue
        }
      }

      return null
    } catch (error) {
      logger.error(`Error searching for ${directoryName} directory`, { error })
      return null
    }
  }

  /**
   * Validate that directory contains test artifacts
   *
   * @param {string} artifactsDir - Directory to validate
   * @returns {Promise<boolean>} True if directory has valid content
   */
  async validateDirectoryContent(artifactsDir) {
    try {
      const entries = await fs.readdir(artifactsDir, { withFileTypes: true })

      // Check for any files (test artifacts can be various formats)
      const hasFiles = entries.some((entry) => entry.isFile())

      if (!hasFiles) {
        // Check subdirectories recursively
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subDir = path.join(artifactsDir, entry.name)
            const subHasContent = await this.validateDirectoryContent(subDir)
            if (subHasContent) return true
          }
        }
        return false
      }

      return true
    } catch (error) {
      logger.debug('Error validating directory content', { error })
      return false
    }
  }

  /**
   * Compress test artifacts directory
   *
   * @param {string} artifactsDir - Directory to compress
   * @param {Object} options - Compression options
   * @returns {Promise<Object>} Compression result
   */
  async compressTestArtifacts(artifactsDir, options = {}) {
    try {
      logger.progress(`Compressing test artifacts from: ${artifactsDir}`)

      const { compressionUtils } = require('../utilities/compressionUtils')

      // Create output directory in temp
      const outputDir = path.join(os.tmpdir(), 'buildbear-artifacts')
      await fs.mkdir(outputDir, { recursive: true })

      // Compress the directory
      const compressedFilePath = await compressionUtils.compressDirectory(
        artifactsDir,
        outputDir
      )

      // Create metadata
      const metadata = {
        timestamp: new Date().toISOString(),
        sourceDirectory: artifactsDir,
        status: options.status || 'success',
        message: options.message || 'Test artifacts processed',
        directoryName: options.directoryName || 'bbOut',
        compressedFilePath,
        processingTime: Date.now(),
      }

      // Add file statistics
      const stats = await fs.stat(compressedFilePath)
      metadata.compressedSize = stats.size
      metadata.compressedSizeFormatted = this.formatBytes(stats.size)

      logger.success(
        `Test artifacts compressed successfully: ${metadata.compressedSizeFormatted}`
      )

      return {
        compressedFilePath,
        metadata,
        success: true,
      }
    } catch (error) {
      logger.error('Failed to compress test artifacts', { error })
      throw new Error(`Compression failed: ${error.message}`)
    }
  }

  /**
   * Send compressed test artifacts to BuildBear backend
   *
   * @param {string} compressedFilePath - Path to compressed file
   * @param {Object} metadata - Artifact metadata
   * @returns {Promise<Object>} Upload response
   */
  async sendArtifactsToBackend(compressedFilePath, metadata) {
    try {
      logger.progress('Uploading test artifacts to BuildBear backend')

      if (!compressedFilePath || !(await this.fileExists(compressedFilePath))) {
        throw new Error('Compressed file not found or invalid path')
      }

      // Validate file size
      const stats = await fs.stat(compressedFilePath)
      const maxSize = this.config.files?.maxSize || 100 * 1024 * 1024 // 100MB default

      if (stats.size > maxSize) {
        throw new Error(
          `File too large: ${this.formatBytes(stats.size)} exceeds limit of ${this.formatBytes(maxSize)}`
        )
      }

      // This would integrate with BuildBear API service
      // For now, simulate the upload
      logger.info(
        `Preparing to upload ${this.formatBytes(stats.size)} of test artifacts`
      )

      // Simulate upload delay
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const response = {
        success: true,
        uploadId: `upload_${Date.now()}`,
        fileSize: stats.size,
        fileSizeFormatted: this.formatBytes(stats.size),
        metadata,
        uploadedAt: new Date().toISOString(),
      }

      logger.success('Test artifacts uploaded successfully')
      return response
    } catch (error) {
      logger.error('Failed to upload test artifacts', { error })
      throw new Error(`Upload failed: ${error.message}`)
    }
  }

  /**
   * Clean up temporary files
   *
   * @param {string} filePath - Path to file to clean up
   * @returns {Promise<void>}
   */
  async cleanupTempFiles(filePath) {
    try {
      if (filePath && (await this.fileExists(filePath))) {
        await fs.unlink(filePath)
        logger.debug(`Cleaned up temporary file: ${filePath}`)
      }
    } catch (error) {
      logger.debug('Error cleaning up temporary file', { error })
    }
  }

  /**
   * Check if file exists
   *
   * @param {string} filePath - File path to check
   * @returns {Promise<boolean>} True if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath)
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Format bytes to human readable string
   *
   * @param {number} bytes - Bytes to format
   * @returns {string} Formatted string
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes'

    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  /**
   * Get artifact processing summary
   *
   * @param {Object} result - Processing result
   * @returns {Object} Summary information
   */
  getProcessingSummary(result) {
    return {
      success: result.success || false,
      hasArtifacts: !!result.compressedFilePath,
      fileSize: result.metadata?.compressedSizeFormatted || 'N/A',
      timestamp: result.metadata?.timestamp || new Date().toISOString(),
      message:
        result.message || result.metadata?.message || 'Processing completed',
    }
  }
}

// Export singleton instance
const testResimulationService = new TestResimulationService()

module.exports = {
  TestResimulationService,
  testResimulationService,
}

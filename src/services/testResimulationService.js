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
   * @param {string} [options.fileName='bbOut.json'] - File name to compress
   * @returns {Promise<Object>} Processing result with file path and metadata
   */
  async processTestArtifacts(workingDirectory, options = {}) {
    try {
      const {
        status = 'success',
        message = 'Test artifacts processed',
        fileName = 'bbOut.json',
      } = options

      logger.progress('Processing test resimulation artifacts')

      // Find the test artifacts file
      const artifactsFile = await this.findTestArtifactsFile(
        workingDirectory,
        fileName
      )

      if (!artifactsFile) {
        logger.info(
          `No ${fileName} file found. Skipping test artifact processing.`
        )
        return {
          compressedFilePath: null,
          metadata: null,
          success: false,
          message: `No ${fileName} file found`,
        }
      }

      // Validate file has content
      const hasContent = await this.validateFileContent(artifactsFile)
      if (!hasContent) {
        logger.warn(`${fileName} file is empty or contains no valid test data`)
        return {
          compressedFilePath: null,
          metadata: null,
          success: false,
          message: `${fileName} file is empty`,
        }
      }

      // Compress the artifacts
      const compressionResult = await this.compressTestArtifacts(
        artifactsFile,
        {
          status,
          message,
          fileName,
        }
      )

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
   * Find test artifacts file
   *
   * @param {string} workingDirectory - Working directory to search
   * @param {string} fileName - File name to find
   * @returns {Promise<string|null>} Path to artifacts file or null
   */
  async findTestArtifactsFile(workingDirectory, fileName) {
    try {
      const entries = await fs.readdir(workingDirectory, {
        withFileTypes: true,
      })

      for (const entry of entries) {
        if (entry.isFile() && entry.name === fileName) {
          const fullPath = path.join(workingDirectory, entry.name)
          logger.debug(`Found test artifacts file: ${fullPath}`)
          return fullPath
        }
      }

      // Also check common subdirectories
      const commonPaths = ['test', 'tests', 'out', 'artifacts', 'build']
      for (const subPath of commonPaths) {
        const subDir = path.join(workingDirectory, subPath)
        try {
          await fs.access(subDir)
          const subResult = await this.findTestArtifactsFile(subDir, fileName)
          if (subResult) return subResult
        } catch (error) {
          // Directory doesn't exist, continue
        }
      }

      return null
    } catch (error) {
      logger.error(`Error searching for ${fileName} file`, { error })
      return null
    }
  }

  /**
   * Validate that file contains test artifacts (optimized for large files)
   *
   * @param {string} artifactsFile - File to validate
   * @returns {Promise<boolean>} True if file has valid content
   */
  async validateFileContent(artifactsFile) {
    try {
      const stats = await fs.stat(artifactsFile)

      // Check if file is not empty
      if (stats.size === 0) {
        logger.debug('File is empty')
        return false
      }

      // For large files (>10MB), use streaming validation instead of loading entire file
      if (stats.size > 10 * 1024 * 1024) {
        logger.debug(
          `Large file detected (${this.formatBytes(stats.size)}), using streaming validation`
        )
        return await this.validateLargeJsonFile(artifactsFile)
      }

      // For smaller files, use the existing method
      try {
        const content = await fs.readFile(artifactsFile, 'utf8')
        const parsed = JSON.parse(content)
        return typeof parsed === 'object' && parsed !== null
      } catch (parseError) {
        logger.debug('File is not valid JSON', { error: parseError.message })
        return false
      }
    } catch (error) {
      logger.debug('Error validating file content', { error })
      return false
    }
  }

  /**
   * Validate large JSON files using streaming approach
   *
   * @param {string} filePath - Path to the JSON file
   * @returns {Promise<boolean>} True if file appears to be valid JSON
   */
  async validateLargeJsonFile(filePath) {
    const fs = require('fs')
    const { createReadStream } = fs

    return new Promise((resolve) => {
      const stream = createReadStream(filePath, {
        encoding: 'utf8',
        highWaterMark: 16384,
      })
      let buffer = ''
      let isValidStart = false
      let braceCount = 0
      let inString = false
      let escaped = false

      const cleanup = () => {
        stream.destroy()
      }

      stream.on('data', (chunk) => {
        buffer += chunk

        // Process the buffer character by character for the first few KB
        for (let i = 0; i < buffer.length && i < 4096; i++) {
          const char = buffer[i]

          if (!inString) {
            if (char === '{' || char === '[') {
              if (!isValidStart) isValidStart = true
              if (char === '{') braceCount++
            } else if (char === '}') {
              braceCount--
            } else if (char === '"') {
              inString = true
            } else if (char.trim() === '' || char === '\n' || char === '\r') {
              // Skip whitespace
              continue
            } else if (!isValidStart) {
              // Invalid JSON start
              cleanup()
              resolve(false)
              return
            }
          } else {
            if (escaped) {
              escaped = false
            } else if (char === '\\') {
              escaped = true
            } else if (char === '"') {
              inString = false
            }
          }

          // If we've processed enough and it looks valid, accept it
          if (isValidStart && i > 1024) {
            cleanup()
            resolve(true)
            return
          }
        }

        // If buffer gets too large for initial validation, clear it
        if (buffer.length > 8192) {
          buffer = buffer.slice(-1024) // Keep only the last 1KB
        }
      })

      stream.on('end', () => {
        resolve(isValidStart)
      })

      stream.on('error', (error) => {
        logger.debug('Error during streaming validation', {
          error: error.message,
        })
        resolve(false)
      })

      // Timeout for very large files
      setTimeout(() => {
        cleanup()
        resolve(isValidStart)
      }, 5000) // 5 second timeout
    })
  }

  /**
   * Compress test artifacts file (optimized for large files)
   *
   * @param {string} artifactsFile - File to compress
   * @param {Object} options - Compression options
   * @returns {Promise<Object>} Compression result
   */
  async compressTestArtifacts(artifactsFile, options = {}) {
    try {
      logger.progress(`Compressing test artifacts from: ${artifactsFile}`)

      // Get file stats to determine processing strategy
      const fileStats = await fs.stat(artifactsFile)
      const fileSizeFormatted = this.formatBytes(fileStats.size)

      logger.info(`Processing file of size: ${fileSizeFormatted}`)

      // Create output directory in temp
      const outputDir = path.join(os.tmpdir(), 'buildbear-artifacts')
      await fs.mkdir(outputDir, { recursive: true })

      // For large files (>50MB), use streaming approach to avoid memory issues
      if (fileStats.size > 50 * 1024 * 1024) {
        logger.info(
          `Large file detected, using optimized compression for ${fileSizeFormatted}`
        )
        return await this.compressLargeFile(
          artifactsFile,
          outputDir,
          options,
          fileStats
        )
      }

      // For smaller files, use the existing method with content validation
      const fileContent = await fs.readFile(artifactsFile, 'utf8')

      // Validate that it's valid JSON (only for smaller files)
      let parsedContent
      try {
        parsedContent = JSON.parse(fileContent)
      } catch (parseError) {
        throw new Error(`Invalid JSON in artifacts file: ${parseError.message}`)
      }

      // Use compression utils to compress the file content
      const { compressionUtils } = require('../utilities/compressionUtils')

      // Create a temporary directory with the file to compress
      const tempDir = path.join(os.tmpdir(), `temp-artifacts-dir-${Date.now()}`)
      await fs.mkdir(tempDir, { recursive: true })

      const tempFilePath = path.join(tempDir, path.basename(artifactsFile))
      await fs.writeFile(tempFilePath, fileContent, 'utf8')

      // Compress the temporary directory containing the file
      const compressedFilePath = await compressionUtils.compressDirectory(
        tempDir,
        outputDir
      )

      // Clean up temporary directory
      await fs.rm(tempDir, { recursive: true, force: true })

      // Create metadata
      const metadata = await this.createCompressionMetadata(
        artifactsFile,
        compressedFilePath,
        options,
        fileStats,
        parsedContent
      )

      logger.success(
        `Test artifacts compressed successfully: ${metadata.compressedSizeFormatted} (original: ${metadata.originalSizeFormatted})`
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
   * Compress large files using streaming approach
   *
   * @param {string} artifactsFile - File to compress
   * @param {string} outputDir - Output directory
   * @param {Object} options - Compression options
   * @param {Object} fileStats - File statistics
   * @returns {Promise<Object>} Compression result
   */
  async compressLargeFile(artifactsFile, outputDir, options, fileStats) {
    const { compressionUtils } = require('../utilities/compressionUtils')

    // For very large files, skip JSON parsing to avoid memory issues
    logger.info(
      'Skipping JSON validation for large file to prevent memory issues'
    )

    // Create a temporary directory with the file to compress
    const tempDir = path.join(os.tmpdir(), `temp-large-artifacts-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })

    try {
      // Copy file to temp directory using streams to handle large files
      const tempFilePath = path.join(tempDir, path.basename(artifactsFile))
      await this.copyFileStream(artifactsFile, tempFilePath)

      // Compress the temporary directory containing the file
      logger.info('Starting compression of large file...')
      const compressedFilePath = await compressionUtils.compressDirectory(
        tempDir,
        outputDir
      )

      // Clean up temporary directory
      await fs.rm(tempDir, { recursive: true, force: true })

      // Create metadata (without parsed content for large files)
      const metadata = await this.createCompressionMetadata(
        artifactsFile,
        compressedFilePath,
        options,
        fileStats,
        null
      )

      logger.success(
        `Large test artifacts compressed successfully: ${metadata.compressedSizeFormatted} (original: ${metadata.originalSizeFormatted})`
      )

      return {
        compressedFilePath,
        metadata,
        success: true,
      }
    } catch (error) {
      // Ensure cleanup on error
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Copy file using streams for large files
   *
   * @param {string} source - Source file path
   * @param {string} destination - Destination file path
   * @returns {Promise<void>}
   */
  async copyFileStream(source, destination) {
    const fs = require('fs')
    const { pipeline } = require('stream/promises')

    return pipeline(
      fs.createReadStream(source),
      fs.createWriteStream(destination)
    )
  }

  /**
   * Create compression metadata
   *
   * @param {string} artifactsFile - Source file path
   * @param {string} compressedFilePath - Compressed file path
   * @param {Object} options - Options
   * @param {Object} fileStats - File statistics
   * @param {Object|null} parsedContent - Parsed content (null for large files)
   * @returns {Promise<Object>} Metadata object
   */
  async createCompressionMetadata(
    artifactsFile,
    compressedFilePath,
    options,
    fileStats,
    parsedContent
  ) {
    const metadata = {
      timestamp: new Date().toISOString(),
      sourceFile: artifactsFile,
      status: options.status || 'success',
      message: options.message || 'Test artifacts processed',
      fileName: options.fileName || 'bbOut.json',
      compressedFilePath,
      processingTime: Date.now(),
      originalSize: fileStats.size,
      originalSizeFormatted: this.formatBytes(fileStats.size),
    }

    // Add parsed content only for smaller files
    if (parsedContent !== null) {
      metadata.originalContent = parsedContent
    } else {
      metadata.note =
        'Content parsing skipped for large file to optimize memory usage'
    }

    // Add compressed file statistics
    try {
      const compressedStats = await fs.stat(compressedFilePath)
      metadata.compressedSize = compressedStats.size
      metadata.compressedSizeFormatted = this.formatBytes(compressedStats.size)
    } catch (error) {
      // If we can't read compressed file stats, return metadata without them
      metadata.compressedSize = 0
      metadata.compressedSizeFormatted = 'Unknown'
    }

    return metadata
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
      const maxSize = this.config.files?.maxSize || 1000 * 1024 * 1024 // 100MB default

      if (stats.size > maxSize) {
        throw new Error(
          `File too large: ${this.formatBytes(stats.size)} exceeds limit of ${this.formatBytes(maxSize)}`
        )
      }

      logger.info(`Uploading ${this.formatBytes(stats.size)} of test artifacts`)

      // Use BuildBear API service to upload artifacts
      const { buildBearApi } = require('./buildBearApi')
      const response = await buildBearApi.uploadTestArtifacts(
        compressedFilePath,
        metadata
      )

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
      originalFileSize: result.metadata?.originalSizeFormatted || 'N/A',
      compressedFileSize: result.metadata?.compressedSizeFormatted || 'N/A',
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

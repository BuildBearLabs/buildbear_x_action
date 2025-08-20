const fs = require('fs').promises
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const os = require('os')
const { promisify } = require('util')
const { logger } = require('../services/logger')
const { getConfig } = require('../config')

// Promisify zlib functions
const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

class CompressionUtils {
  constructor() {
    this.config = getConfig()
  }

  /**
   * Compress a directory with enhanced error handling and progress tracking
   *
   * @param {string} sourceDir - Source directory to compress
   * @param {string} [outputDir] - Output directory for compressed file
   * @param {Object} [options] - Compression options
   * @param {number} [options.compressionLevel] - Compression level (1-9)
   * @param {boolean} [options.validateAfterCompression=true] - Validate after compression
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<string>} Path to compressed file
   */
  async compressDirectory(sourceDir, outputDir = null, options = {}) {
    try {
      const {
        compressionLevel = this.config.files?.compressionLevel || 6,
        validateAfterCompression = true,
        onProgress = null,
      } = options

      logger.progress(`Starting compression of directory: ${sourceDir}`)

      // Validate source directory
      await this.validateSourceDirectory(sourceDir)

      // Set output directory
      const finalOutputDir =
        outputDir || path.join(os.tmpdir(), 'buildbear-compressed')
      await this.ensureOutputDirectory(finalOutputDir)

      // Get all files
      const files = await this.getAllFiles(sourceDir)
      logger.info(`Found ${files.length} files to compress`)

      if (onProgress) {
        onProgress({ phase: 'scanning', filesFound: files.length })
      }

      // Create file map with compression
      const fileMap = await this.compressFiles(files, sourceDir, {
        compressionLevel,
        onProgress,
      })

      // Create metadata
      const metadata = this.createCompressionMetadata(files, fileMap, sourceDir)

      // Create final archive
      const archivePath = await this.createFinalArchive(
        fileMap,
        metadata,
        finalOutputDir,
        sourceDir,
        { compressionLevel }
      )

      // Validate if requested
      if (validateAfterCompression) {
        await this.validateCompressedArchive(archivePath, files, sourceDir)
      }

      logger.success(`Directory compressed successfully: ${archivePath}`)
      return archivePath
    } catch (error) {
      logger.error('Failed to compress directory', {
        error: error.message,
        sourceDir,
      })
      throw new Error(`Compression failed: ${error.message}`)
    }
  }

  /**
   * Validate source directory
   *
   * @param {string} sourceDir - Source directory to validate
   * @returns {Promise<void>}
   */
  async validateSourceDirectory(sourceDir) {
    try {
      await fs.access(sourceDir)
      const stats = await fs.stat(sourceDir)

      if (!stats.isDirectory()) {
        throw new Error(`Source path is not a directory: ${sourceDir}`)
      }

      // Check if directory has any content
      const entries = await fs.readdir(sourceDir)
      if (entries.length === 0) {
        logger.warn(`Source directory is empty: ${sourceDir}`)
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Source directory not found: ${sourceDir}`)
      }
      throw error
    }
  }

  /**
   * Ensure output directory exists
   *
   * @param {string} outputDir - Output directory path
   * @returns {Promise<void>}
   */
  async ensureOutputDirectory(outputDir) {
    try {
      await fs.mkdir(outputDir, { recursive: true })
      logger.debug(`Output directory ensured: ${outputDir}`)
    } catch (error) {
      throw new Error(`Failed to create output directory: ${error.message}`)
    }
  }

  /**
   * Get all files in directory recursively
   *
   * @param {string} dir - Directory to scan
   * @returns {Promise<Array<string>>} Array of file paths
   */
  async getAllFiles(dir) {
    const files = []

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          const subFiles = await this.getAllFiles(fullPath)
          files.push(...subFiles)
        } else if (entry.isFile()) {
          files.push(fullPath)
        }
      }

      return files
    } catch (error) {
      logger.error(`Error reading directory: ${dir}`, { error })
      return []
    }
  }

  /**
   * Compress all files with progress tracking
   *
   * @param {Array<string>} files - Array of file paths to compress
   * @param {string} baseDir - Base directory for relative paths
   * @param {Object} options - Compression options
   * @returns {Promise<Object>} File map with compressed data
   */
  async compressFiles(files, baseDir, options = {}) {
    const { compressionLevel = 6, onProgress = null } = options
    const fileMap = {}

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i]

      if (onProgress) {
        onProgress({
          phase: 'compressing',
          current: i + 1,
          total: files.length,
          currentFile: path.basename(filePath),
        })
      }

      try {
        await this.compressFile(filePath, fileMap, baseDir, {
          compressionLevel,
        })
      } catch (error) {
        logger.warn(`Failed to compress file: ${filePath}`, {
          error: error.message,
        })
        // Continue with other files rather than failing completely
      }
    }

    return fileMap
  }

  /**
   * Compress a single file (optimized for large files)
   *
   * @param {string} filePath - Path to file to compress
   * @param {Object} fileMap - File map to populate
   * @param {string} baseDir - Base directory for relative paths
   * @param {Object} options - Compression options
   */
  async compressFile(filePath, fileMap, baseDir, options = {}) {
    try {
      const { compressionLevel = 6 } = options

      // Get file stats to determine processing strategy
      const stats = await fs.stat(filePath)
      const relativePath = this.getRelativePath(filePath, baseDir)

      // For very large files (>100MB), use streaming compression
      if (stats.size > 100 * 1024 * 1024) {
        logger.debug(
          `Large file detected: ${relativePath} (${this.formatBytes(stats.size)}), using streaming compression`
        )
        return await this.compressLargeFileStream(
          filePath,
          fileMap,
          relativePath,
          { compressionLevel }
        )
      }

      // For smaller files, use the existing method
      const content = await fs.readFile(filePath, 'utf8')
      const originalHash = this.calculateHash(content)
      const compressed = await gzip(content, { level: compressionLevel })

      fileMap[relativePath] = {
        content: compressed.toString('base64'),
        originalHash,
        originalSize: content.length,
        compressedSize: compressed.length,
        compressionRatio: ((compressed.length / content.length) * 100).toFixed(
          2
        ),
      }

      await this.validateFileCompression(fileMap[relativePath], content)

      logger.debug(
        `Compressed file: ${relativePath} (${fileMap[relativePath].compressionRatio}% of original)`
      )
    } catch (error) {
      throw new Error(`Error compressing file ${filePath}: ${error.message}`)
    }
  }

  /**
   * Compress large files using streaming approach
   *
   * @param {string} filePath - Path to file to compress
   * @param {Object} fileMap - File map to populate
   * @param {string} relativePath - Relative path for the file
   * @param {Object} options - Compression options
   */
  async compressLargeFileStream(filePath, fileMap, relativePath, options = {}) {
    const { compressionLevel = 6 } = options
    const fs = require('fs')
    const { pipeline } = require('stream/promises')
    const crypto = require('crypto')

    return new Promise(async (resolve, reject) => {
      try {
        const stats = await require('fs').promises.stat(filePath)

        // Create streams
        const readStream = fs.createReadStream(filePath)
        const gzipStream = zlib.createGzip({ level: compressionLevel })
        const hashStream = crypto.createHash('sha256')

        const chunks = []
        let originalSize = 0

        // Hash the original content
        const originalHashStream = crypto.createHash('sha256')
        const originalReadStream = fs.createReadStream(filePath)

        originalReadStream.on('data', (chunk) => {
          originalHashStream.update(chunk)
          originalSize += chunk.length
        })

        const originalHash = await new Promise((resolveHash) => {
          originalReadStream.on('end', () => {
            resolveHash(originalHashStream.digest('hex'))
          })
        })

        // Compress the file
        readStream.pipe(gzipStream)

        gzipStream.on('data', (chunk) => {
          chunks.push(chunk)
        })

        gzipStream.on('end', () => {
          const compressed = Buffer.concat(chunks)

          fileMap[relativePath] = {
            content: compressed.toString('base64'),
            originalHash,
            originalSize: stats.size,
            compressedSize: compressed.length,
            compressionRatio: ((compressed.length / stats.size) * 100).toFixed(
              2
            ),
            isLargeFile: true,
          }

          logger.debug(
            `Compressed large file: ${relativePath} (${fileMap[relativePath].compressionRatio}% of original, ${this.formatBytes(stats.size)} -> ${this.formatBytes(compressed.length)})`
          )

          resolve()
        })

        gzipStream.on('error', reject)
        readStream.on('error', reject)
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Validate file compression
   *
   * @param {Object} fileInfo - Compressed file info
   * @param {string} originalContent - Original file content
   * @returns {Promise<void>}
   */
  async validateFileCompression(fileInfo, originalContent) {
    try {
      // Decompress and validate
      const decompressed = await gunzip(Buffer.from(fileInfo.content, 'base64'))
      const decompressedHash = this.calculateHash(decompressed)

      if (fileInfo.originalHash !== decompressedHash) {
        throw new Error('Hash mismatch after compression')
      }
    } catch (error) {
      throw new Error(`Compression validation failed: ${error.message}`)
    }
  }

  /**
   * Create compression metadata
   *
   * @param {Array<string>} files - Original files
   * @param {Object} fileMap - Compressed file map
   * @param {string} sourceDir - Source directory
   * @returns {Object} Metadata object
   */
  createCompressionMetadata(files, fileMap, sourceDir) {
    const totalOriginalSize = Object.values(fileMap).reduce(
      (sum, file) => sum + file.originalSize,
      0
    )
    const totalCompressedSize = Object.values(fileMap).reduce(
      (sum, file) => sum + file.compressedSize,
      0
    )

    return {
      timestamp: new Date().toISOString(),
      sourceDirectory: sourceDir,
      fileCount: files.length,
      totalOriginalSize,
      totalCompressedSize,
      overallCompressionRatio: (
        (totalCompressedSize / totalOriginalSize) *
        100
      ).toFixed(2),
      version: '2.0.0',
      tool: 'BuildBear GitHub Action',
    }
  }

  /**
   * Create final compressed archive
   *
   * @param {Object} fileMap - Compressed file map
   * @param {Object} metadata - Compression metadata
   * @param {string} outputDir - Output directory
   * @param {string} sourceDir - Source directory
   * @param {Object} options - Archive options
   * @returns {Promise<string>} Path to final archive
   */
  async createFinalArchive(
    fileMap,
    metadata,
    outputDir,
    sourceDir,
    options = {}
  ) {
    try {
      const { compressionLevel = 6 } = options

      // Create final archive object
      const archive = { metadata, files: fileMap }

      // Serialize and compress the entire archive
      const serialized = JSON.stringify(archive)
      const compressedArchive = await gzip(serialized, {
        level: compressionLevel,
      })

      // Generate output file path
      const dirName = path.basename(sourceDir)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outputFile = path.join(outputDir, `${dirName}_${timestamp}.gz`)

      // Write compressed archive
      await fs.writeFile(outputFile, compressedArchive)

      // Log compression statistics
      this.logCompressionStats(metadata, outputFile, compressedArchive.length)

      return outputFile
    } catch (error) {
      throw new Error(`Failed to create final archive: ${error.message}`)
    }
  }

  /**
   * Log compression statistics
   *
   * @param {Object} metadata - Compression metadata
   * @param {string} outputFile - Output file path
   * @param {number} finalSize - Final archive size
   */
  logCompressionStats(metadata, outputFile, finalSize) {
    logger.info(`Compression Statistics:`)
    logger.info(`  Files: ${metadata.fileCount}`)
    logger.info(
      `  Original Size: ${this.formatBytes(metadata.totalOriginalSize)}`
    )
    logger.info(
      `  Compressed Size: ${this.formatBytes(metadata.totalCompressedSize)}`
    )
    logger.info(`  Final Archive Size: ${this.formatBytes(finalSize)}`)
    logger.info(`  Compression Ratio: ${metadata.overallCompressionRatio}%`)
    logger.info(`  Output File: ${outputFile}`)
  }

  /**
   * Validate compressed archive
   *
   * @param {string} archivePath - Path to compressed archive
   * @param {Array<string>} originalFiles - Original file paths
   * @param {string} baseDir - Base directory
   * @returns {Promise<boolean>} True if validation passes
   */
  async validateCompressedArchive(archivePath, originalFiles, baseDir) {
    try {
      logger.progress(`Validating compressed archive: ${archivePath}`)

      // Read and decompress archive
      const compressedData = await fs.readFile(archivePath)
      const decompressedData = await gunzip(compressedData)
      const archive = JSON.parse(decompressedData.toString())

      // Validate file count
      const archiveFiles = Object.keys(archive.files)
      if (archiveFiles.length !== originalFiles.length) {
        throw new Error(
          `File count mismatch: expected ${originalFiles.length}, got ${archiveFiles.length}`
        )
      }

      // Validate each file
      let validatedFiles = 0
      for (const originalPath of originalFiles) {
        const relativePath = this.getRelativePath(originalPath, baseDir)
        const fileInfo = archive.files[relativePath]

        if (!fileInfo) {
          throw new Error(`File missing from archive: ${relativePath}`)
        }

        // Validate file content
        const originalContent = await fs.readFile(originalPath, 'utf8')
        const originalHash = this.calculateHash(originalContent)

        if (originalHash !== fileInfo.originalHash) {
          throw new Error(`Hash mismatch for file: ${relativePath}`)
        }

        validatedFiles++
      }

      logger.success(
        `Archive validation successful: ${validatedFiles} files validated`
      )
      return true
    } catch (error) {
      logger.error('Archive validation failed', { error: error.message })
      throw new Error(`Validation failed: ${error.message}`)
    }
  }

  /**
   * Decompress an archive
   *
   * @param {string} archivePath - Path to compressed archive
   * @param {string} outputDir - Directory to extract to
   * @returns {Promise<string>} Path to extracted directory
   */
  async decompressArchive(archivePath, outputDir) {
    try {
      logger.progress(`Decompressing archive: ${archivePath}`)

      // Read and decompress archive
      const compressedData = await fs.readFile(archivePath)
      const decompressedData = await gunzip(compressedData)
      const archive = JSON.parse(decompressedData.toString())

      // Create output directory
      await fs.mkdir(outputDir, { recursive: true })

      // Extract each file
      let extractedFiles = 0
      for (const [relativePath, fileInfo] of Object.entries(archive.files)) {
        const outputPath = path.join(outputDir, relativePath)

        // Create directory structure
        await fs.mkdir(path.dirname(outputPath), { recursive: true })

        // Decompress and write file
        const decompressedContent = await gunzip(
          Buffer.from(fileInfo.content, 'base64')
        )
        await fs.writeFile(outputPath, decompressedContent)

        // Validate extracted file
        const extractedHash = this.calculateHash(decompressedContent)
        if (extractedHash !== fileInfo.originalHash) {
          throw new Error(`Extraction validation failed for: ${relativePath}`)
        }

        extractedFiles++
      }

      logger.success(
        `Successfully extracted ${extractedFiles} files to: ${outputDir}`
      )
      return outputDir
    } catch (error) {
      logger.error('Failed to decompress archive', { error })
      throw new Error(`Decompression failed: ${error.message}`)
    }
  }

  /**
   * Calculate SHA-256 hash
   *
   * @param {string|Buffer} content - Content to hash
   * @returns {string} Hex hash
   */
  calculateHash(content) {
    const hash = crypto.createHash('sha256')
    hash.update(typeof content === 'string' ? content : content.toString())
    return hash.digest('hex')
  }

  /**
   * Get relative path from base directory
   *
   * @param {string} filePath - Full file path
   * @param {string} baseDir - Base directory
   * @returns {string} Relative path
   */
  getRelativePath(filePath, baseDir) {
    return filePath.replace(
      new RegExp(`^${baseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]?`),
      ''
    )
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
}

// For backward compatibility
const compressBboutDirectory = async (sourceDir, outputDir) => {
  const compressionUtils = new CompressionUtils()
  return compressionUtils.compressDirectory(sourceDir, outputDir)
}

// For bbOut.json file compression
const compressBboutFile = async (sourceFile, outputDir) => {
  const compressionUtils = new CompressionUtils()
  const fs = require('fs').promises
  const path = require('path')
  const os = require('os')

  // Create a temporary directory with the file
  const tempDir = path.join(os.tmpdir(), 'temp-bbout-file')
  await fs.mkdir(tempDir, { recursive: true })

  const tempFilePath = path.join(tempDir, path.basename(sourceFile))
  const content = await fs.readFile(sourceFile, 'utf8')
  await fs.writeFile(tempFilePath, content, 'utf8')

  try {
    const result = await compressionUtils.compressDirectory(tempDir, outputDir)
    await fs.rm(tempDir, { recursive: true, force: true })
    return result
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

// Export class and singleton instance
const compressionUtils = new CompressionUtils()

module.exports = {
  CompressionUtils,
  compressionUtils,
  compressDirectory: compressionUtils.compressDirectory.bind(compressionUtils),
  decompressArchive: compressionUtils.decompressArchive.bind(compressionUtils),
  compressBboutDirectory, // For backward compatibility
  compressBboutFile, // For bbOut.json file compression
}

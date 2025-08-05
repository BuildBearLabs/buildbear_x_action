const fs = require('fs').promises
const path = require('path')
const lzma = require('lzma')
const crypto = require('crypto')
const os = require('os')
const { promisify } = require('util')
const { logger } = require('../services/logger')
const { getConfig } = require('../config')

// LZMA compression functions
const lzmaCompress = async (data, level = 6) => {
  return new Promise((resolve, reject) => {
    lzma.compress(data, level, (result, error) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

const lzmaDecompress = async (data) => {
  return new Promise((resolve, reject) => {
    lzma.decompress(data, (result, error) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

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
   * @param {string} [options.algorithm='brotli'] - Compression algorithm ('gzip', 'brotli')
   * @param {boolean} [options.validateAfterCompression=true] - Validate after compression
   * @param {Function} [options.onProgress] - Progress callback
   * @param {boolean} [options.deduplication=true] - Enable file deduplication
   * @param {boolean} [options.deltaCompression=true] - Enable delta compression for similar files
   * @returns {Promise<string>} Path to compressed file
   */
  async compressDirectory(sourceDir, outputDir = null, options = {}) {
    try {
      const {
        compressionLevel = this.config.files?.compressionLevel || 9,
        algorithm = 'lzma',
        validateAfterCompression = true,
        onProgress = null,
        deduplication = true,
        deltaCompression = true,
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
        algorithm,
        onProgress,
        deduplication,
        deltaCompression,
      })

      // Create metadata
      const metadata = this.createCompressionMetadata(files, fileMap, sourceDir)

      // Create final archive
      const archivePath = await this.createFinalArchive(
        fileMap,
        metadata,
        finalOutputDir,
        sourceDir,
        { compressionLevel, algorithm }
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
    const {
      compressionLevel = 9,
      algorithm = 'brotli',
      onProgress = null,
      deduplication = true,
      deltaCompression = true,
    } = options
    const fileMap = {}
    const fileHashes = new Map()
    const fileGroups = new Map()

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
          algorithm,
          fileHashes,
          fileGroups,
          deduplication,
          deltaCompression,
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
   * Compress a single file
   *
   * @param {string} filePath - Path to file to compress
   * @param {Object} fileMap - File map to populate
   * @param {string} baseDir - Base directory for relative paths
   * @param {Object} options - Compression options
   */
  async compressFile(filePath, fileMap, baseDir, options = {}) {
    try {
      const {
        compressionLevel = 9,
        algorithm = 'lzma',
        fileHashes,
        fileGroups,
        deduplication = true,
        deltaCompression = true,
      } = options

      // Read file content
      const content = await fs.readFile(filePath)
      const isText = this.isTextFile(filePath)
      const fileContent = isText ? content.toString('utf8') : content

      // Calculate original hash for validation
      const originalHash = this.calculateHash(content)
      const relativePath = this.getRelativePath(filePath, baseDir)

      // Check for duplicate files
      if (deduplication && fileHashes.has(originalHash)) {
        const duplicateRef = fileHashes.get(originalHash)
        fileMap[relativePath] = {
          type: 'duplicate',
          referenceFile: duplicateRef,
          originalHash,
          originalSize: content.length,
        }
        logger.debug(`Deduplicated file: ${relativePath} -> ${duplicateRef}`)
        return
      }

      // Store hash reference
      if (deduplication) {
        fileHashes.set(originalHash, relativePath)
      }

      // Apply pre-compression optimizations for text files
      let dataToCompress = fileContent
      if (isText && deltaCompression) {
        dataToCompress = this.applyTextOptimizations(fileContent)
      }

      // Compress content based on algorithm
      let compressed
      if (algorithm === 'lzma') {
        // LZMA compression level goes from 0-9
        compressed = Buffer.from(
          await lzmaCompress(dataToCompress, compressionLevel)
        )
      } else {
        // Fallback to basic LZMA with default settings
        compressed = Buffer.from(await lzmaCompress(dataToCompress))
      }

      // Try dictionary compression for similar files
      if (deltaCompression && isText) {
        const betterCompressed = await this.tryDictionaryCompression(
          dataToCompress,
          relativePath,
          fileGroups,
          algorithm,
          compressionLevel
        )
        if (betterCompressed && betterCompressed.length < compressed.length) {
          compressed = betterCompressed
          fileMap[relativePath] = {
            type: 'dictionary',
            content: compressed.toString('base64'),
            originalHash,
            originalSize: content.length,
            compressedSize: compressed.length,
            compressionRatio: (
              (compressed.length / content.length) *
              100
            ).toFixed(2),
            algorithm,
            dictionary: betterCompressed.dictionary,
          }
        } else {
          fileMap[relativePath] = {
            type: 'standard',
            content: compressed.toString('base64'),
            originalHash,
            originalSize: content.length,
            compressedSize: compressed.length,
            compressionRatio: (
              (compressed.length / content.length) *
              100
            ).toFixed(2),
            algorithm,
          }
        }
      } else {
        fileMap[relativePath] = {
          type: 'standard',
          content: compressed.toString('base64'),
          originalHash,
          originalSize: content.length,
          compressedSize: compressed.length,
          compressionRatio: (
            (compressed.length / content.length) *
            100
          ).toFixed(2),
          algorithm,
        }
      }

      // Validate compression immediately
      await this.validateFileCompression(
        fileMap[relativePath],
        content,
        algorithm
      )

      logger.debug(
        `Compressed file: ${relativePath} (${fileMap[relativePath].compressionRatio}% of original) using ${algorithm}`
      )
    } catch (error) {
      throw new Error(`Error compressing file ${filePath}: ${error.message}`)
    }
  }

  /**
   * Check if file is text-based
   *
   * @param {string} filePath - File path
   * @returns {boolean} True if text file
   */
  isTextFile(filePath) {
    const textExtensions = [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.json',
      '.txt',
      '.md',
      '.yml',
      '.yaml',
      '.xml',
      '.html',
      '.css',
      '.scss',
      '.py',
      '.java',
      '.c',
      '.cpp',
      '.h',
      '.hpp',
      '.go',
      '.rs',
      '.rb',
      '.php',
      '.sql',
      '.sh',
      '.bash',
    ]
    const ext = path.extname(filePath).toLowerCase()
    return textExtensions.includes(ext)
  }

  /**
   * Apply text optimizations before compression
   *
   * @param {string} content - Text content
   * @returns {string} Optimized content
   */
  applyTextOptimizations(content) {
    // Remove excessive whitespace while preserving structure
    let optimized = content
      .replace(/\r\n/g, '\n') // Normalize line endings
      .replace(/[ \t]+$/gm, '') // Remove trailing whitespace
      .replace(/\n{3,}/g, '\n\n') // Reduce multiple empty lines

    // For source code, apply additional optimizations
    if (this.isSourceCode(content)) {
      // Remove comments in a safe way (basic implementation)
      optimized = optimized
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
        .replace(/\/\/.*$/gm, '') // Remove line comments
        .replace(/^\s*\n/gm, '') // Remove empty lines
    }

    return optimized
  }

  /**
   * Check if content appears to be source code
   *
   * @param {string} content - File content
   * @returns {boolean} True if likely source code
   */
  isSourceCode(content) {
    const codeIndicators = [
      /function\s+\w+\s*\(/,
      /class\s+\w+/,
      /const\s+\w+\s*=/,
      /import\s+.*from/,
      /export\s+(default\s+)?/,
    ]
    return codeIndicators.some((pattern) => pattern.test(content))
  }

  /**
   * Try dictionary-based compression for similar files
   *
   * @param {string} content - File content
   * @param {string} filePath - File path
   * @param {Map} fileGroups - File groups map
   * @param {string} algorithm - Compression algorithm
   * @param {number} compressionLevel - Compression level
   * @returns {Promise<Buffer|null>} Compressed data or null
   */
  async tryDictionaryCompression(
    content,
    filePath,
    fileGroups,
    algorithm,
    compressionLevel
  ) {
    try {
      // Group files by extension
      const ext = path.extname(filePath)
      if (!fileGroups.has(ext)) {
        fileGroups.set(ext, [])
      }

      const group = fileGroups.get(ext)
      group.push({ path: filePath, content })

      // If we have enough similar files, create a dictionary
      if (group.length >= 3) {
        // Create a simple dictionary from common patterns
        const dictionary = this.createDictionary(group.map((f) => f.content))

        // Compress with dictionary hint
        if (algorithm === 'lzma') {
          // LZMA doesn't support custom dictionaries directly,
          // but we can prepend common patterns to improve compression
          const enhancedContent = dictionary + '\n' + content
          const compressed = Buffer.from(
            await lzmaCompress(enhancedContent, compressionLevel)
          )
          compressed.dictionary = dictionary
          return compressed
        }
      }

      return null
    } catch (error) {
      logger.debug(`Dictionary compression failed: ${error.message}`)
      return null
    }
  }

  /**
   * Create a dictionary from common patterns
   *
   * @param {Array<string>} contents - File contents
   * @returns {string} Dictionary
   */
  createDictionary(contents) {
    const patterns = new Map()

    // Extract common patterns
    contents.forEach((content) => {
      // Extract common imports/requires
      const imports = content.match(/(?:import|require)\s*\([^)]+\)/g) || []
      imports.forEach((imp) => {
        patterns.set(imp, (patterns.get(imp) || 0) + 1)
      })

      // Extract common function signatures
      const functions = content.match(/function\s+\w+\s*\([^)]*\)/g) || []
      functions.forEach((func) => {
        patterns.set(func, (patterns.get(func) || 0) + 1)
      })
    })

    // Sort by frequency and take top patterns
    const topPatterns = Array.from(patterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([pattern]) => pattern)

    return topPatterns.join('\n')
  }

  /**
   * Validate file compression
   *
   * @param {Object} fileInfo - Compressed file info
   * @param {Buffer|string} originalContent - Original file content
   * @param {string} algorithm - Compression algorithm
   * @returns {Promise<void>}
   */
  async validateFileCompression(fileInfo, originalContent, algorithm = 'lzma') {
    try {
      if (fileInfo.type === 'duplicate') {
        // Skip validation for deduplicated files
        return
      }

      // Decompress and validate
      let decompressed
      if (algorithm === 'lzma') {
        const compressedData = Buffer.from(fileInfo.content, 'base64')
        decompressed = Buffer.from(await lzmaDecompress(compressedData))
      } else {
        // Fallback to LZMA
        const compressedData = Buffer.from(fileInfo.content, 'base64')
        decompressed = Buffer.from(await lzmaDecompress(compressedData))
      }

      // Handle dictionary compression
      if (fileInfo.type === 'dictionary' && fileInfo.dictionary) {
        // Remove dictionary prefix
        const dictLength = Buffer.from(fileInfo.dictionary).length + 1 // +1 for newline
        decompressed = decompressed.slice(dictLength)
      }

      const decompressedHash = this.calculateHash(decompressed)
      const expectedHash = this.calculateHash(originalContent)

      if (expectedHash !== decompressedHash) {
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
      const { compressionLevel = 9, algorithm = 'lzma' } = options

      // Create final archive object
      const archive = { metadata, files: fileMap }

      // Serialize and compress the entire archive
      const serialized = JSON.stringify(archive)

      let compressedArchive
      if (algorithm === 'lzma') {
        compressedArchive = Buffer.from(
          await lzmaCompress(serialized, compressionLevel)
        )
      } else {
        // Fallback to LZMA with default settings
        compressedArchive = Buffer.from(await lzmaCompress(serialized))
      }

      // Generate output file path
      const dirName = path.basename(sourceDir)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const extension = '.lzma'
      const outputFile = path.join(
        outputDir,
        `${dirName}_${timestamp}${extension}`
      )

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
      const decompressedData = Buffer.from(await lzmaDecompress(compressedData))
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

      // Determine algorithm from file extension
      const isLzma = archivePath.endsWith('.lzma')

      // Read and decompress archive
      const compressedData = await fs.readFile(archivePath)
      let decompressedData

      // Always use LZMA for decompression
      decompressedData = Buffer.from(await lzmaDecompress(compressedData))

      const archive = JSON.parse(decompressedData.toString())

      // Create output directory
      await fs.mkdir(outputDir, { recursive: true })

      // Track deduplicated files
      const processedFiles = new Map()

      // Extract each file
      let extractedFiles = 0
      for (const [relativePath, fileInfo] of Object.entries(archive.files)) {
        const outputPath = path.join(outputDir, relativePath)

        // Create directory structure
        await fs.mkdir(path.dirname(outputPath), { recursive: true })

        let decompressedContent

        // Handle different file types
        if (fileInfo.type === 'duplicate') {
          // Copy from reference file
          const refPath = path.join(outputDir, fileInfo.referenceFile)
          if (processedFiles.has(fileInfo.referenceFile)) {
            decompressedContent = processedFiles.get(fileInfo.referenceFile)
          } else {
            throw new Error(
              `Reference file not yet processed: ${fileInfo.referenceFile}`
            )
          }
        } else {
          // Decompress based on algorithm
          const algorithm = fileInfo.algorithm || 'lzma'
          if (algorithm === 'lzma') {
            const compressedData = Buffer.from(fileInfo.content, 'base64')
            decompressedContent = Buffer.from(
              await lzmaDecompress(compressedData)
            )
          } else {
            // Fallback to LZMA
            const compressedData = Buffer.from(fileInfo.content, 'base64')
            decompressedContent = Buffer.from(
              await lzmaDecompress(compressedData)
            )
          }

          // Handle dictionary compression
          if (fileInfo.type === 'dictionary' && fileInfo.dictionary) {
            const dictLength = Buffer.from(fileInfo.dictionary).length + 1
            decompressedContent = decompressedContent.slice(dictLength)
          }
        }

        await fs.writeFile(outputPath, decompressedContent)
        processedFiles.set(relativePath, decompressedContent)

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

// Create ultra-compressed version for maximum compression
const ultraCompressDirectory = async (sourceDir, outputDir) => {
  const compressionUtils = new CompressionUtils()
  return compressionUtils.compressDirectory(sourceDir, outputDir, {
    compressionLevel: 9, // LZMA max level
    algorithm: 'lzma',
    deduplication: true,
    deltaCompression: true,
    validateAfterCompression: false, // Skip validation for speed
  })
}

// Export class and singleton instance
const compressionUtils = new CompressionUtils()

module.exports = {
  CompressionUtils,
  compressionUtils,
  compressDirectory: compressionUtils.compressDirectory.bind(compressionUtils),
  decompressArchive: compressionUtils.decompressArchive.bind(compressionUtils),
  ultraCompressDirectory,
  compressBboutDirectory, // For backward compatibility
}

const fs = require('fs').promises
const path = require('path')
const { logger } = require('../services/logger')

class PathUtils {
  /**
   * Find a directory by name in the given working directory
   *
   * @param {string} targetDir - Directory name to find
   * @param {string} workingDir - Working directory to search in
   * @param {Object} options - Search options
   * @param {boolean} [options.recursive=false] - Search recursively in subdirectories
   * @param {number} [options.maxDepth=3] - Maximum search depth for recursive search
   * @param {Array<string>} [options.excludeDirs] - Directories to exclude from search
   * @returns {Promise<string|null>} Path to found directory or null
   */
  async findDirectory(targetDir, workingDir, options = {}) {
    try {
      const {
        recursive = false,
        maxDepth = 3,
        excludeDirs = ['node_modules', '.git', 'dist', 'coverage'],
      } = options

      logger.debug(`Searching for directory '${targetDir}' in: ${workingDir}`)

      const result = await this.searchDirectory(targetDir, workingDir, {
        recursive,
        currentDepth: 0,
        maxDepth,
        excludeDirs,
      })

      if (result) {
        logger.debug(`Found directory: ${result}`)
      } else {
        logger.debug(`Directory '${targetDir}' not found in ${workingDir}`)
      }

      return result
    } catch (error) {
      logger.error(`Error finding directory '${targetDir}' in ${workingDir}`, {
        error,
      })
      return null
    }
  }

  /**
   * Internal recursive directory search
   *
   * @param {string} targetDir - Target directory name
   * @param {string} currentDir - Current directory being searched
   * @param {Object} options - Search options
   * @returns {Promise<string|null>} Found directory path or null
   */
  async searchDirectory(targetDir, currentDir, options) {
    try {
      const { recursive, currentDepth, maxDepth, excludeDirs } = options

      // Check if we've exceeded max depth
      if (recursive && currentDepth >= maxDepth) {
        return null
      }

      const entries = await fs.readdir(currentDir, { withFileTypes: true })

      // First pass: look for exact match in current directory
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name === targetDir) {
          return path.join(currentDir, entry.name)
        }
      }

      // Second pass: recursive search if enabled
      if (recursive) {
        for (const entry of entries) {
          if (entry.isDirectory() && !excludeDirs.includes(entry.name)) {
            const subDir = path.join(currentDir, entry.name)
            const result = await this.searchDirectory(targetDir, subDir, {
              ...options,
              currentDepth: currentDepth + 1,
            })
            if (result) return result
          }
        }
      }

      return null
    } catch (error) {
      logger.debug(`Error searching in directory: ${currentDir}`, { error })
      return null
    }
  }

  /**
   * Find multiple directories by names
   *
   * @param {Array<string>} targetDirs - Array of directory names to find
   * @param {string} workingDir - Working directory to search in
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Map of directory names to their paths
   */
  async findDirectories(targetDirs, workingDir, options = {}) {
    try {
      logger.debug(`Searching for directories: ${targetDirs.join(', ')}`)

      const results = {}

      for (const targetDir of targetDirs) {
        results[targetDir] = await this.findDirectory(
          targetDir,
          workingDir,
          options
        )
      }

      const foundCount = Object.values(results).filter(Boolean).length
      logger.debug(`Found ${foundCount}/${targetDirs.length} directories`)

      return results
    } catch (error) {
      logger.error('Error finding multiple directories', { error })
      return {}
    }
  }

  /**
   * Check if path exists and get its type
   *
   * @param {string} targetPath - Path to check
   * @returns {Promise<Object>} Object with exists, isFile, isDirectory properties
   */
  async checkPath(targetPath) {
    try {
      const stats = await fs.stat(targetPath)
      return {
        exists: true,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modified: stats.mtime,
      }
    } catch (error) {
      return {
        exists: false,
        isFile: false,
        isDirectory: false,
        size: 0,
        modified: null,
      }
    }
  }

  /**
   * Create directory structure if it doesn't exist
   *
   * @param {string} dirPath - Directory path to create
   * @param {Object} options - Creation options
   * @param {boolean} [options.recursive=true] - Create parent directories
   * @returns {Promise<boolean>} True if created successfully
   */
  async ensureDirectory(dirPath, options = {}) {
    try {
      const { recursive = true } = options

      await fs.mkdir(dirPath, { recursive })
      logger.debug(`Ensured directory exists: ${dirPath}`)
      return true
    } catch (error) {
      // Check if directory already exists
      if (error.code === 'EEXIST') {
        return true
      }

      logger.error(`Error creating directory: ${dirPath}`, { error })
      return false
    }
  }

  /**
   * Get relative path from one path to another
   *
   * @param {string} from - From path
   * @param {string} to - To path
   * @returns {string} Relative path
   */
  getRelativePath(from, to) {
    try {
      return path.relative(from, to)
    } catch (error) {
      logger.debug('Error calculating relative path', { error, from, to })
      return to
    }
  }

  /**
   * Normalize path separators for cross-platform compatibility
   *
   * @param {string} filePath - Path to normalize
   * @returns {string} Normalized path
   */
  normalizePath(filePath) {
    return path.normalize(filePath).replace(/\\/g, '/')
  }

  /**
   * Get file extension without the dot
   *
   * @param {string} filePath - File path
   * @returns {string} File extension
   */
  getFileExtension(filePath) {
    const ext = path.extname(filePath)
    return ext.startsWith('.') ? ext.slice(1) : ext
  }

  /**
   * Get file name without extension
   *
   * @param {string} filePath - File path
   * @returns {string} File name without extension
   */
  getFileNameWithoutExtension(filePath) {
    const basename = path.basename(filePath)
    const ext = path.extname(basename)
    return basename.slice(0, -ext.length)
  }

  /**
   * Join paths safely
   *
   * @param {...string} paths - Paths to join
   * @returns {string} Joined path
   */
  joinPaths(...paths) {
    return path.join(...paths)
  }

  /**
   * Resolve path to absolute path
   *
   * @param {string} filePath - Path to resolve
   * @param {string} [basePath] - Base path for resolution
   * @returns {string} Absolute path
   */
  resolvePath(filePath, basePath = process.cwd()) {
    if (path.isAbsolute(filePath)) {
      return filePath
    }
    return path.resolve(basePath, filePath)
  }

  /**
   * Check if path is within a directory (security check)
   *
   * @param {string} filePath - File path to check
   * @param {string} directoryPath - Directory path
   * @returns {boolean} True if path is within directory
   */
  isPathWithinDirectory(filePath, directoryPath) {
    try {
      const resolvedFile = path.resolve(filePath)
      const resolvedDir = path.resolve(directoryPath)

      return (
        resolvedFile.startsWith(resolvedDir + path.sep) ||
        resolvedFile === resolvedDir
      )
    } catch (error) {
      logger.debug('Error checking path containment', { error })
      return false
    }
  }

  /**
   * Get directory size recursively
   *
   * @param {string} dirPath - Directory path
   * @returns {Promise<Object>} Size information
   */
  async getDirectorySize(dirPath) {
    try {
      let totalSize = 0
      let fileCount = 0
      let dirCount = 0

      const entries = await fs.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isFile()) {
          const stats = await fs.stat(fullPath)
          totalSize += stats.size
          fileCount++
        } else if (entry.isDirectory()) {
          dirCount++
          const subSize = await this.getDirectorySize(fullPath)
          totalSize += subSize.totalSize
          fileCount += subSize.fileCount
          dirCount += subSize.dirCount
        }
      }

      return {
        totalSize,
        fileCount,
        dirCount,
        formattedSize: this.formatBytes(totalSize),
      }
    } catch (error) {
      logger.debug(`Error calculating directory size: ${dirPath}`, { error })
      return {
        totalSize: 0,
        fileCount: 0,
        dirCount: 0,
        formattedSize: '0 Bytes',
      }
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
}

// Export singleton instance
const pathUtils = new PathUtils()

module.exports = {
  PathUtils,
  pathUtils,
}

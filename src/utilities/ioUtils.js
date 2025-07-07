const fs = require('fs').promises
const path = require('path')
const { logger } = require('../services/logger')

class IOUtils {
  constructor() {
    this.sensitiveEnvKeys = [
      'PASSWORD',
      'SECRET',
      'KEY',
      'TOKEN',
      'PRIVATE',
      'CREDENTIAL',
      'AUTH',
    ]
  }

  /**
   * Get all environment variables with optional filtering
   *
   * @param {Object} options - Filtering options
   * @param {boolean} [options.includeSensitive=false] - Include sensitive variables
   * @param {Array<string>} [options.include] - Specific keys to include
   * @param {Array<string>} [options.exclude] - Specific keys to exclude
   * @param {boolean} [options.excludeEmpty=true] - Exclude empty or whitespace-only values
   * @returns {Object} Environment variables object
   */
  getAllEnvironmentVariables(options = {}) {
    try {
      const {
        includeSensitive = false,
        include = null,
        exclude = [],
        excludeEmpty = true,
      } = options

      const envObject = {}
      const processedKeys = new Set()

      Object.keys(process.env).forEach((key) => {
        try {
          // Skip if already processed
          if (processedKeys.has(key)) return

          // Include/exclude filtering
          if (include && !include.includes(key)) return
          if (exclude.includes(key)) return

          // Get the environment value
          const envValue = process.env[key]

          // Handle empty or invalid values
          if (excludeEmpty && this.isEmptyOrInvalidValue(envValue)) {
            logger.debug(`Skipping empty environment variable: ${key}`)
            return
          }

          // Sensitive data filtering
          if (!includeSensitive && this.isSensitiveKey(key)) {
            envObject[key] = '[REDACTED]'
            logger.debug(`Redacted sensitive environment variable: ${key}`)
          } else {
            // Ensure we have a valid string value
            envObject[key] = this.sanitizeEnvironmentValue(envValue)
          }

          processedKeys.add(key)
        } catch (keyError) {
          logger.debug(`Error processing environment variable ${key}:`, {
            error: keyError.message,
          })
          // Skip this key and continue with others
        }
      })

      logger.debug(
        `Collected ${Object.keys(envObject).length} environment variables`
      )
      return envObject
    } catch (error) {
      logger.error('Error collecting environment variables', { error })
      return {}
    }
  }

  /**
   * Check if environment key is sensitive
   *
   * @param {string} key - Environment variable key
   * @returns {boolean} True if key is sensitive
   */
  isSensitiveKey(key) {
    const upperKey = key.toUpperCase()
    return this.sensitiveEnvKeys.some((sensitiveKey) =>
      upperKey.includes(sensitiveKey)
    )
  }

  /**
   * Check if the environment value is empty or invalid
   *
   * @param {*} value - Environment variable value
   * @returns {boolean} True if value is empty or invalid
   */
  isEmptyOrInvalidValue(value) {
    // Check for null, undefined, or non-string values
    if (value === null || value === undefined) {
      return true
    }

    // Convert to string if it's not already
    const stringValue = String(value)

    // Check for empty string or whitespace-only values
    if (stringValue.trim() === '') {
      return true
    }

    // Check for common "empty" patterns like "API: " (key with empty value)
    if (/^[A-Z_]+:\s*$/.test(stringValue)) {
      return true
    }

    return false
  }

  /**
   * Sanitize environment value to ensure it's a valid string
   *
   * @param {*} value - Environment variable value
   * @returns {string} Sanitized string value
   */
  sanitizeEnvironmentValue(value) {
    try {
      // Handle null/undefined
      if (value === null || value === undefined) {
        return ''
      }

      // Convert to string and trim whitespace
      const stringValue = String(value).trim()

      // Handle empty or invalid patterns
      if (this.isEmptyOrInvalidValue(stringValue)) {
        return ''
      }

      return stringValue
    } catch (error) {
      logger.debug('Error sanitizing environment value:', { error })
      return ''
    }
  }

  /**
   * Find VM read file calls in project files
   *
   * @param {string} directory - Directory to search in
   * @param {Object} options - Search options
   * @param {Array<string>} [options.extensions] - File extensions to search
   * @param {Array<string>} [options.excludeDirs] - Directories to exclude
   * @param {boolean} [options.recursive=true] - Search recursively
   * @returns {Promise<Object>} Map of file paths to their contents
   */
  async findVmReadFileCalls(directory = '.', options = {}) {
    try {
      const {
        extensions = ['.sol', '.js', '.ts'],
        excludeDirs = [
          'node_modules',
          '.git',
          'out',
          'cache',
          'dist',
          'coverage',
        ],
        recursive = true,
      } = options

      logger.progress(`Searching for vm.readFile calls in: ${directory}`)

      const results = {}
      const vmReadFileRegex = /vm\.readFile\s*\(\s*["']([^"']+)["']\s*\)/g

      await this.walkDirectory(directory, {
        onFile: async (filePath) => {
          // Check file extension
          const ext = path.extname(filePath)
          if (!extensions.includes(ext)) return

          try {
            const content = await fs.readFile(filePath, 'utf8')
            const matches = [...content.matchAll(vmReadFileRegex)]

            for (const match of matches) {
              const extractedPath = match[1]
              await this.processVmReadFileMatch(
                extractedPath,
                filePath,
                results
              )
            }
          } catch (error) {
            logger.debug(`Could not read file: ${filePath}`, {
              error: error.message,
            })
          }
        },
        excludeDirs,
        recursive,
      })
      return results
    } catch (error) {
      logger.error('Error searching for vm.readFile calls', { error })
      return {}
    }
  }

  /**
   * Process a vm.readFile match
   *
   * @param {string} extractedPath - Path extracted from vm.readFile call
   * @param {string} sourceFile - Source file containing the call
   * @param {Object} results - Results object to populate
   */
  async processVmReadFileMatch(extractedPath, sourceFile, results) {
    try {
      // Try relative path first
      const relativePath = path.resolve(path.dirname(sourceFile), extractedPath)

      if (await this.fileExists(relativePath)) {
        const content = await fs.readFile(relativePath, 'utf8')
        results[extractedPath] = content
        logger.debug(`Found vm.readFile target: ${extractedPath}`)
        return
      }

      // Try absolute path
      if (await this.fileExists(extractedPath)) {
        const content = await fs.readFile(extractedPath, 'utf8')
        results[extractedPath] = content
        logger.debug(`Found vm.readFile target (absolute): ${extractedPath}`)
        return
      }

      logger.debug(`vm.readFile target not found: ${extractedPath}`)
    } catch (error) {
      logger.debug(`Error processing vm.readFile match: ${extractedPath}`, {
        error,
      })
    }
  }

  /**
   * Walk directory recursively with callback
   *
   * @param {string} dir - Directory to walk
   * @param {Object} options - Walk options
   * @param {Function} options.onFile - Callback for each file
   * @param {Function} [options.onDirectory] - Callback for each directory
   * @param {Array<string>} [options.excludeDirs] - Directories to exclude
   * @param {boolean} [options.recursive=true] - Walk recursively
   */
  async walkDirectory(dir, options = {}) {
    try {
      const {
        onFile,
        onDirectory,
        excludeDirs = [],
        recursive = true,
      } = options

      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          // Check if directory should be excluded
          if (excludeDirs.includes(entry.name)) {
            logger.debug(`Skipping excluded directory: ${entry.name}`)
            continue
          }

          if (onDirectory) {
            await onDirectory(fullPath, entry)
          }

          if (recursive) {
            await this.walkDirectory(fullPath, options)
          }
        } else if (entry.isFile()) {
          if (onFile) {
            await onFile(fullPath, entry)
          }
        }
      }
    } catch (error) {
      logger.debug(`Error walking directory: ${dir}`, { error })
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
   * Read JSON file with error handling
   *
   * @param {string} filePath - Path to JSON file
   * @param {Object} options - Read options
   * @param {*} [options.defaultValue=null] - Default value if file not found
   * @param {boolean} [options.throwOnError=false] - Throw error instead of returning default
   * @returns {Promise<*>} Parsed JSON or default value
   */
  async readJsonFile(filePath, options = {}) {
    try {
      const { defaultValue = null, throwOnError = false } = options

      const content = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)

      logger.debug(`Successfully read JSON file: ${filePath}`)
      return parsed
    } catch (error) {
      logger.debug(`Error reading JSON file: ${filePath}`, {
        error: error.message,
      })

      if (throwOnError) {
        throw new Error(
          `Failed to read JSON file ${filePath}: ${error.message}`
        )
      }

      return options.defaultValue
    }
  }

  /**
   * Write JSON file with error handling
   *
   * @param {string} filePath - Path to write JSON file
   * @param {*} data - Data to write
   * @param {Object} options - Write options
   * @param {number} [options.spaces=2] - JSON indentation spaces
   * @param {boolean} [options.createDir=true] - Create directory if not exists
   * @returns {Promise<boolean>} True if successful
   */
  async writeJsonFile(filePath, data, options = {}) {
    try {
      const { spaces = 2, createDir = true } = options

      if (createDir) {
        const dir = path.dirname(filePath)
        await fs.mkdir(dir, { recursive: true })
      }

      const jsonContent = JSON.stringify(data, null, spaces)
      await fs.writeFile(filePath, jsonContent, 'utf8')

      logger.debug(`Successfully wrote JSON file: ${filePath}`)
      return true
    } catch (error) {
      logger.error(`Error writing JSON file: ${filePath}`, { error })
      return false
    }
  }

  /**
   * Ensure directory exists
   *
   * @param {string} dirPath - Directory path to create
   * @returns {Promise<boolean>} True if directory exists or was created
   */
  async ensureDirectory(dirPath) {
    try {
      await fs.mkdir(dirPath, { recursive: true })
      logger.debug(`Ensured directory exists: ${dirPath}`)
      return true
    } catch (error) {
      logger.error(`Error ensuring directory: ${dirPath}`, { error })
      return false
    }
  }

  /**
   * Get file statistics
   *
   * @param {string} filePath - File path to analyze
   * @returns {Promise<Object|null>} File stats or null if error
   */
  async getFileStats(filePath) {
    try {
      const stats = await fs.stat(filePath)
      return {
        size: stats.size,
        sizeFormatted: this.formatBytes(stats.size),
        created: stats.birthtime,
        modified: stats.mtime,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      }
    } catch (error) {
      logger.debug(`Error getting file stats: ${filePath}`, { error })
      return null
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
const ioUtils = new IOUtils()

module.exports = {
  IOUtils,
  ioUtils,
}

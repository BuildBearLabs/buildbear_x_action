const { getConfig } = require('../config')

/**
 * Log levels with priority
 */
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
}

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
  RESET: '\x1b[0m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  GREEN: '\x1b[32m',
  BLUE: '\x1b[34m',
  CYAN: '\x1b[36m',
  GRAY: '\x1b[90m',
}

/**
 * Emoji prefixes for different log levels
 */
const EMOJI_PREFIX = {
  ERROR: '❌',
  WARN: '⚠️',
  INFO: 'ℹ️',
  DEBUG: '🔍',
  SUCCESS: '✅',
  PROGRESS: '🔄',
  ROCKET: '🚀',
  CLOCK: '⏳',
  FILE: '📄',
}

class Logger {
  constructor() {
    this.config = getConfig()
    this.currentLevel = this.getLevelFromString(this.config.logging.level)
  }

  /**
   * Convert string level to numeric
   */
  getLevelFromString(level) {
    const upperLevel = level.toUpperCase()
    return LOG_LEVELS[upperLevel] !== undefined
      ? LOG_LEVELS[upperLevel]
      : LOG_LEVELS.INFO
  }

  /**
   * Check if message should be logged based on current level
   */
  shouldLog(level) {
    return LOG_LEVELS[level] <= this.currentLevel
  }

  /**
   * Format timestamp
   */
  getTimestamp() {
    return new Date().toISOString()
  }

  /**
   * Format log message with colors and structure
   */
  formatMessage(level, message, emoji = null, data = null) {
    const timestamp = this.getTimestamp()
    const color = this.getColorForLevel(level)
    const prefix = emoji || EMOJI_PREFIX[level] || ''

    let formatted = `${color}[${timestamp}] ${prefix} ${level}: ${message}${COLORS.RESET}`

    if (data && this.config.logging.enableDebug) {
      formatted += `\n${COLORS.GRAY}${JSON.stringify(data, null, 2)}${COLORS.RESET}`
    }

    return formatted
  }

  /**
   * Get color for log level
   */
  getColorForLevel(level) {
    switch (level) {
      case 'ERROR':
        return COLORS.RED
      case 'WARN':
        return COLORS.YELLOW
      case 'INFO':
        return COLORS.BLUE
      case 'DEBUG':
        return COLORS.GRAY
      default:
        return COLORS.RESET
    }
  }

  /**
   * Core logging method
   */
  log(level, message, emoji = null, data = null) {
    if (!this.shouldLog(level)) return

    const formatted = this.formatMessage(level, message, emoji, data)

    if (level === 'ERROR') {
      console.error(formatted)
    } else {
      console.log(formatted)
    }
  }

  /**
   * Error logging
   */
  error(message, data = null) {
    this.log('ERROR', message, EMOJI_PREFIX.ERROR, data)
  }

  /**
   * Warning logging
   */
  warn(message, data = null) {
    this.log('WARN', message, EMOJI_PREFIX.WARN, data)
  }

  /**
   * Info logging
   */
  info(message, data = null) {
    this.log('INFO', message, EMOJI_PREFIX.INFO, data)
  }

  /**
   * Debug logging
   */
  debug(message, data = null) {
    this.log('DEBUG', message, EMOJI_PREFIX.DEBUG, data)
  }

  /**
   * Success logging
   */
  success(message, data = null) {
    this.log('INFO', message, EMOJI_PREFIX.SUCCESS, data)
  }

  /**
   * Progress logging
   */
  progress(message, data = null) {
    this.log('INFO', message, EMOJI_PREFIX.PROGRESS, data)
  }

  /**
   * Clock/timing logging
   */
  timing(message, data = null) {
    this.log('INFO', message, EMOJI_PREFIX.CLOCK, data)
  }

  /**
   * File operation logging
   */
  file(message, data = null) {
    this.log('INFO', message, EMOJI_PREFIX.FILE, data)
  }

  /**
   * Rocket/deployment logging
   */
  deployment(message, data = null) {
    this.log('INFO', message, EMOJI_PREFIX.ROCKET, data)
  }

  /**
   * Group logging for related operations
   */
  group(title, fn) {
    console.group(`${EMOJI_PREFIX.PROGRESS} ${title}`)
    try {
      return fn()
    } finally {
      console.groupEnd()
    }
  }

  /**
   * Async group logging
   */
  async groupAsync(title, fn) {
    console.group(`${EMOJI_PREFIX.PROGRESS} ${title}`)
    try {
      return await fn()
    } finally {
      console.groupEnd()
    }
  }
}

// Export singleton instance
const logger = new Logger()

module.exports = {
  Logger,
  logger,
  LOG_LEVELS,
  EMOJI_PREFIX,
}

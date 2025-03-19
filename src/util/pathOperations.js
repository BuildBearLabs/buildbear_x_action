const fs = require('fs').promises
const path = require('path')

/**
 * Find a directory in project root
 * @param {string} targetDir Directory name to find
 * @param workingDir
 * @returns {Promise<string|null>}
 */
async function findDirectory(targetDir, workingDir) {
  try {
    const entries = await fs.readdir(workingDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === targetDir) {
        return path.join(workingDir, entry.name)
      }
    }
    return null
  } catch (error) {
    console.error(`Error finding directory ${targetDir}:`, error)
    return null
  }
}

module.exports = {
  findDirectory,
}

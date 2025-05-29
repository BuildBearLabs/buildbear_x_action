const fs = require('fs')
const path = require('path')

function findVmReadFileCalls(directory = '.') {
  const results = {}

  // Regex to match vm.readFile("path") or vm.readFile('path')
  const vmReadFileRegex = /vm\.readFile\s*\(\s*["']([^"']+)["']\s*\)/g

  function searchInFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const matches = [...content.matchAll(vmReadFileRegex)]

      matches.forEach((match) => {
        const extractedPath = match[1]

        try {
          // Try to read the file content
          const resolvedPath = path.resolve(
            path.dirname(filePath),
            extractedPath
          )

          if (fs.existsSync(resolvedPath)) {
            const fileContent = fs.readFileSync(resolvedPath, 'utf8')
            results[extractedPath] = fileContent
          } else if (fs.existsSync(extractedPath)) {
            // Try absolute path
            const fileContent = fs.readFileSync(extractedPath, 'utf8')
            results[extractedPath] = fileContent
          }
          // If file doesn't exist, ignore (as requested)
        } catch (error) {
          // Ignore files that can't be read
        }
      })
    } catch (error) {
      // Ignore files that can't be read
    }
  }

  function walkDirectory(dir) {
    try {
      const files = fs.readdirSync(dir)

      files.forEach((file) => {
        const filePath = path.join(dir, file)
        const stat = fs.statSync(filePath)

        if (stat.isDirectory()) {
          // Skip common directories that don't contain Solidity files
          if (!['node_modules', '.git', 'out', 'cache'].includes(file)) {
            walkDirectory(filePath)
          }
        } else if (
          file.endsWith('.sol') ||
          file.endsWith('.js') ||
          file.endsWith('.ts')
        ) {
          searchInFile(filePath)
        }
      })
    } catch (error) {
      // Ignore directories that can't be read
    }
  }

  walkDirectory(directory)
  return results
}

// Usage example:
// const fileContents = findVmReadFileCalls('./test');
// console.log(fileContents);

module.exports = { findVmReadFileCalls }

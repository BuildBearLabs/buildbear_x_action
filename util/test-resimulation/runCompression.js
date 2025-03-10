/**
 * Utility for running the directory compression after forge test completes
 * 
 * This module handles the execution of forge test and then compresses
 * the output directory if it exists.
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { compressDirectory } = require('../compress');

/**
 * Executes a command and returns a promise that resolves when the command completes
 * @param {string} command - Command to execute
 * @param {Array<string>} args - Command arguments
 * @param {Object} options - Spawn options
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
function executeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      ...options,
      shell: true,
      stdio: 'pipe'
    });
    
    let stdout = '';
    let stderr = '';
    
    process.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      console.log(chunk);
    });
    
    process.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(chunk);
    });
    
    process.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    
    process.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Runs forge test and compresses the output directory if it exists
 * @param {string} workingDir - Working directory
 * @param {Array<string>} forgeArgs - Additional arguments for forge test
 * @param {string} directoryName - Directory name to compress (default: 'bbout')
 * @returns {Promise<{testResult: Object, compressionResult: {compressedFilePath: string|null, metadata: Object|null}}>}
 */
async function runForgeTestAndCompress(workingDir, forgeArgs = [], directoryName = 'bbout') {
  try {
    console.log(`Running forge test in ${workingDir}...`);
    
    // Build the forge test command
    const command = 'forge';
    const args = ['test', ...forgeArgs];
    
    // Run forge test
    const testResult = await executeCommand(command, args, { cwd: workingDir });
    
    console.log(`Forge test completed with exit code ${testResult.exitCode}`);
    
    // Determine test status based on exit code
    const testStatus = testResult.exitCode === 0 ? "success" : "failed";
    const testMessage = testResult.exitCode === 0 
      ? "Forge test completed successfully" 
      : `Forge test failed with exit code ${testResult.exitCode}`;
    
    // Compress output directory if it exists
    const compressionResult = await compressBboutIfExists(workingDir, {
      status: testStatus,
      message: testMessage,
      directoryName
    });
    
    return {
      testResult,
      compressionResult
    };
  } catch (error) {
    console.error(`Error running forge test: ${error.message}`);
    
    // Try to compress output directory even if the test command failed
    try {
      const compressionResult = await compressBboutIfExists(workingDir, {
        status: "failed",
        message: `Forge test command failed: ${error.message}`,
        directoryName
      });
      
      return {
        testResult: {
          exitCode: 1,
          stdout: '',
          stderr: error.message
        },
        compressionResult
      };
    } catch (compressionError) {
      console.error(`Error compressing output directory after test failure: ${compressionError.message}`);
      
      return {
        testResult: {
          exitCode: 1,
          stdout: '',
          stderr: error.message
        },
        compressionResult: {
          compressedFilePath: null,
          metadata: null
        }
      };
    }
  }
}

/**
 * Checks if directory exists and compresses it
 * @param {string} workingDir - Working directory
 * @param {Object} options - Additional options
 * @param {string} options.status - Status of the test ("success" or "failed")
 * @param {string} options.message - Optional message to include
 * @param {string} options.directoryName - Directory name to compress (default: 'bbout')
 * @returns {Promise<{compressedFilePath: string|null, metadata: Object|null}>} - Path to compressed file and metadata or null if directory doesn't exist
 */
async function compressBboutIfExists(workingDir, options = { status: "success", directoryName: 'bbOut' }) {
  try {
    const directoryName = options.directoryName || 'bbOut';
    const targetDir = path.join(workingDir, directoryName);
    
    // Check if target directory exists
    try {
      await fs.access(targetDir);
    } catch (error) {
      console.log(`${directoryName} directory not found at ${targetDir}, skipping compression`);
      return { compressedFilePath: null, metadata: null };
    }
    
    console.log(`${directoryName} directory found at ${targetDir}, compressing...`);
    
    // Get directory stats before compression
    const files = await fs.readdir(targetDir);
    let totalOriginalSize = 0;
    
    for (const file of files) {
      const stats = await fs.stat(path.join(targetDir, file));
      totalOriginalSize += stats.size;
    }
    
    // Compress the directory
    const compressedFilePath = await compressDirectory(targetDir);
    
    // Get compressed file stats
    const compressedStats = await fs.stat(compressedFilePath);
    
    // Create metadata for the webhook request
    const metadata = {
      status: options.status, // "success" or "failed"
      message: options.message || `Test artifacts compressed at ${new Date().toISOString()}`,
      originalSize: totalOriginalSize,
      compressedSize: compressedStats.size,
      fileCount: files.length,
      timestamp: new Date().toISOString(),
      compressionRatio: (compressedStats.size / totalOriginalSize * 100).toFixed(2) + '%'
    };
    
    console.log(`Successfully compressed ${directoryName} directory to ${compressedFilePath}`);
    console.log(`Original size: ${totalOriginalSize} bytes`);
    console.log(`Compressed size: ${compressedStats.size} bytes`);
    console.log(`Compression ratio: ${metadata.compressionRatio}`);
    
    return { compressedFilePath, metadata };
  } catch (error) {
    console.error(`Error checking/compressing directory: ${error.message}`);
    return { compressedFilePath: null, metadata: null };
  }
}

module.exports = {
  runForgeTestAndCompress,
  compressBboutIfExists
};

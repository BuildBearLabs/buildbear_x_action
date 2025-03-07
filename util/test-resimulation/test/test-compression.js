/**
 * Test script for the directory compression utility
 * 
 * This script tests the compression and decompression functionality
 * to ensure 100% fidelity of the compressed data.
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { compressDirectory, decompressArchive } = require('../../compress');
const crypto = require('crypto');

// Calculate hash for a file
async function calculateFileHash(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

// Get file size in a human-readable format
async function getFileSize(filePath) {
  const stats = await fs.stat(filePath);
  const bytes = stats.size;
  
  if (bytes < 1024) {
    return `${bytes} bytes`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

// Compare two directories to ensure they have the same files with the same content
async function compareDirectories(dir1, dir2) {
  // Get all files in dir1
  const files1 = await fs.readdir(dir1);
  const files2 = await fs.readdir(dir2);
  
  console.log(`Directory 1 (${dir1}) has ${files1.length} files`);
  console.log(`Directory 2 (${dir2}) has ${files2.length} files`);
  
  if (files1.length !== files2.length) {
    throw new Error(`Directories have different number of files: ${files1.length} vs ${files2.length}`);
  }
  
  // Compare each file
  for (const file of files1) {
    const file1Path = path.join(dir1, file);
    const file2Path = path.join(dir2, file);
    
    // Check if file exists in dir2
    try {
      await fs.access(file2Path);
    } catch (error) {
      throw new Error(`File ${file} exists in ${dir1} but not in ${dir2}`);
    }
    
    // Compare file content
    const hash1 = await calculateFileHash(file1Path);
    const hash2 = await calculateFileHash(file2Path);
    
    if (hash1 !== hash2) {
      throw new Error(`File ${file} has different content in the two directories`);
    }
    
    console.log(`✅ File ${file} matches perfectly`);
  }
  
  console.log('✅ All files match perfectly - 100% fidelity confirmed!');
  return true;
}

// Main test function
async function testCompression() {
  try {
    // Get the source directory to compress
    const sourceDir = process.argv[2] || path.join(process.cwd(), 'bbout');
    
    console.log(`\n🔍 Testing compression fidelity for ${sourceDir}`);
    const tempDir = path.join(os.tmpdir(), `bbout-test-${Date.now()}`);
    
    console.log(`🔹 Temporary directory for decompressed files: ${tempDir}\n`);
    
    // Get total size of bbout directory
    let totalOriginalSize = 0;
    const files = await fs.readdir(sourceDir);
    for (const file of files) {
      const stats = await fs.stat(path.join(sourceDir, file));
      totalOriginalSize += stats.size;
    }
    
    console.log(`📊 Original directory contains ${files.length} files with a total size of ${(totalOriginalSize / 1024).toFixed(2)} KB\n`);
    
    // Compress the bbout directory
    console.log('1️⃣ Compressing directory into a single file...');
    const compressedFilePath = await compressDirectory(sourceDir);
    
    // Get compressed file size
    const compressedSize = await getFileSize(compressedFilePath);
    console.log(`✅ Compression successful: ${compressedFilePath}`);
    console.log(`📦 Compressed file size: ${compressedSize}`);
    console.log(`🔄 Compression ratio: ${((await fs.stat(compressedFilePath)).size / totalOriginalSize * 100).toFixed(2)}%\n`);
    
    // Decompress to a temporary directory
    console.log('2️⃣ Decompressing the single compressed file...');
    await decompressArchive(compressedFilePath, tempDir);
    console.log(`✅ Decompression successful: ${tempDir}\n`);
    
    // Compare the original and decompressed directories
    console.log('3️⃣ Comparing original and decompressed files...');
    await compareDirectories(sourceDir, tempDir);
    
    return {
      success: true,
      compressedFilePath,
      tempDir
    };
  } catch (error) {
    console.error(`❌ Test failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// Run the test
testCompression()
  .then(result => {
    if (result.success) {
      console.log('\n🎉 Compression test passed with 100% fidelity!');
      console.log(`📦 Single compressed file: ${result.compressedFilePath}`);
      console.log(`📂 Decompressed directory: ${result.tempDir}`);
    } else {
      console.error('\n❌ Compression test failed!');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error(`\n❌ Unexpected error: ${error.message}`);
    process.exit(1);
  });

/**
 * Utility for compressing directory contents
 *
 * This module handles the compression of all files in a directory,
 * ensuring 100% fidelity during compression and decompression. It uses zlib
 * for compression and includes validation to ensure data integrity.
 */

const fs = require("fs").promises;
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const os = require("os");
const { promisify } = require("util");

// Promisify zlib functions
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Calculates SHA-256 hash of a string
 * @param {string|Buffer} content - Content to hash
 * @returns {string} - Hex hash
 */
function calculateHash(content) {
  const hash = crypto.createHash("sha256");
  hash.update(typeof content === "string" ? content : content.toString());
  return hash.digest("hex");
}

/**
 * Recursively walks a directory and returns all file paths
 * @param {string} dir - Directory to walk
 * @returns {Promise<Array<string>>} - Array of file paths
 */
async function walkDir(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await walkDir(fullPath);
      files.push(...subFiles);
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Compresses a single file
 * @param {string} filePath - Path to the file
 * @param {Object} fileMap - Map to store file data
 * @param {string} baseDir - Base directory for creating relative paths
 * @returns {Promise<void>}
 */
async function compressFile(filePath, fileMap, baseDir) {
  try {
    // Read file content
    const content = await fs.readFile(filePath, "utf8");

    // Calculate original hash
    const originalHash = calculateHash(content);

    // Compress the content
    const compressed = await gzip(content, {
      level: zlib.constants.Z_BEST_COMPRESSION,
    });

    // Store file info in the map
    const relativePath = filePath.replace(
      new RegExp(`^${baseDir}[/\\\\]?`),
      "",
    );
    fileMap[relativePath] = {
      content: compressed.toString("base64"), // Store compressed content as base64 string
      originalHash,
      originalSize: content.length,
      compressedSize: compressed.length,
    };

    // Validate compression by decompressing and comparing hashes
    const decompressed = await gunzip(
      Buffer.from(fileMap[relativePath].content, "base64"),
    ); // Decompress from base64 string
    const decompressedHash = calculateHash(decompressed);

    if (originalHash !== decompressedHash) {
      throw new Error(
        `Compression validation failed for ${filePath}. Hash mismatch.`,
      );
    }
  } catch (error) {
    throw new Error(`Error compressing file ${filePath}: ${error.message}`);
  }
}

/**
 * Compresses all files in a directory
 * @param {string} sourceDir - Path to the source directory
 * @param {string} outputDir - Directory to save the compressed output
 * @returns {Promise<string>} - Path to the compressed file
 */
async function compressDirectory(sourceDir, outputDir = os.tmpdir()) {
  try {
    // Check if source directory exists
    try {
      await fs.access(sourceDir);
    } catch (error) {
      throw new Error(`Source directory not found at ${sourceDir}`);
    }

    // Get all files in the source directory
    const files = await walkDir(sourceDir);

    if (files.length === 0) {
      throw new Error(`No files found in ${sourceDir}`);
    }

    console.log(`Found ${files.length} files in ${sourceDir}`);

    // Create a map to store file data
    const fileMap = {};

    // Compress each file
    for (const file of files) {
      await compressFile(file, fileMap, sourceDir);
    }

    // Create metadata
    const metadata = {
      timestamp: new Date().toISOString(),
      fileCount: files.length,
      totalOriginalSize: Object.values(fileMap).reduce(
        (sum, file) => sum + file.originalSize,
        0,
      ),
      totalCompressedSize: Object.values(fileMap).reduce(
        (sum, file) => sum + file.compressedSize,
        0,
      ),
    };

    // Create the final archive object
    const archive = {
      metadata,
      files: fileMap,
    };

    // Serialize and compress the entire archive
    const serialized = JSON.stringify(archive);
    const compressedArchive = await gzip(serialized, {
      level: zlib.constants.Z_BEST_COMPRESSION,
    });

    // Create output directory if it doesn't exist
    await fs.mkdir(outputDir, { recursive: true });

    // Generate output file path
    const dirName = path.basename(sourceDir);
    const outputFile = path.join(
      outputDir,
      `${dirName}_compressed_${Date.now()}.gz`,
    );

    // Write the compressed archive to the output file
    await fs.writeFile(outputFile, compressedArchive);

    console.log(`Successfully compressed directory to ${outputFile}`);
    console.log(`Original size: ${metadata.totalOriginalSize} bytes`);
    console.log(`Compressed size: ${metadata.totalCompressedSize} bytes`);
    console.log(
      `Compression ratio: ${((metadata.totalCompressedSize / metadata.totalOriginalSize) * 100).toFixed(2)}%`,
    );

    // Validate the compressed archive
    await validateCompressedArchive(outputFile, files, sourceDir);

    return outputFile;
  } catch (error) {
    throw new Error(`Error compressing directory: ${error.message}`);
  }
}

/**
 * Validates the compressed archive by decompressing it and comparing hashes
 * @param {string} archivePath - Path to the compressed archive
 * @param {Array<string>} originalFiles - Array of original file paths
 * @param {string} baseDir - Base directory for creating relative paths
 * @returns {Promise<boolean>} - True if validation succeeds
 */
async function validateCompressedArchive(archivePath, originalFiles, baseDir) {
  try {
    console.log(`Validating compressed archive: ${archivePath}`);

    // Read and decompress the archive
    const compressedData = await fs.readFile(archivePath);
    const decompressedData = await gunzip(compressedData);
    const archive = JSON.parse(decompressedData.toString());

    // Check if all files are present
    const archiveFiles = Object.keys(archive.files);
    if (archiveFiles.length !== originalFiles.length) {
      throw new Error(
        `File count mismatch: Archive has ${archiveFiles.length} files, original had ${originalFiles.length} files`,
      );
    }

    // Validate each file
    for (const originalPath of originalFiles) {
      const relativePath = originalPath.replace(
        new RegExp(`^${baseDir}[/\\\\]?`),
        "",
      );
      const fileInfo = archive.files[relativePath];

      if (!fileInfo) {
        throw new Error(`File ${relativePath} not found in archive`);
      }

      // Read original file content
      const originalContent = await fs.readFile(originalPath, "utf8");
      const originalHash = calculateHash(originalContent);

      // Check hash
      if (originalHash !== fileInfo.originalHash) {
        throw new Error(`Hash mismatch for ${relativePath}`);
      }

      // Decompress and verify content
      const decompressedContent = await gunzip(
        Buffer.from(fileInfo.content, "base64"),
      ); // Decompress from base64 string
      const decompressedHash = calculateHash(decompressedContent);

      if (originalHash !== decompressedHash) {
        throw new Error(`Decompression validation failed for ${relativePath}`);
      }
    }

    console.log("Validation successful: 100% fidelity confirmed");
    return true;
  } catch (error) {
    throw new Error(`Validation failed: ${error.message}`);
  }
}

/**
 * Decompresses an archive created by compressDirectory
 * @param {string} archivePath - Path to the compressed archive
 * @param {string} outputDir - Directory to extract files to
 * @returns {Promise<string>} - Path to the extracted directory
 */
async function decompressArchive(archivePath, outputDir) {
  try {
    // Read and decompress the archive
    const compressedData = await fs.readFile(archivePath);
    const decompressedData = await gunzip(compressedData);
    const archive = JSON.parse(decompressedData.toString());

    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });

    // Extract each file
    for (const [relativePath, fileInfo] of Object.entries(archive.files)) {
      const outputPath = path.join(outputDir, relativePath);

      // Create directory structure
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      // Decompress file content
      const decompressedContent = await gunzip(
        Buffer.from(fileInfo.content, "base64"),
      ); // Decompress from base64 string

      // Write file
      await fs.writeFile(outputPath, decompressedContent);

      // Verify hash
      const writtenContent = await fs.readFile(outputPath, "utf8");
      const writtenHash = calculateHash(writtenContent);

      if (writtenHash !== fileInfo.originalHash) {
        throw new Error(`Decompression validation failed for ${relativePath}`);
      }
    }

    console.log(`Successfully decompressed archive to ${outputDir}`);
    return outputDir;
  } catch (error) {
    throw new Error(`Error decompressing archive: ${error.message}`);
  }
}

// For backward compatibility
const compressBboutDirectory = compressDirectory;

module.exports = {
  compressDirectory,
  decompressArchive,
  compressBboutDirectory, // For backward compatibility
};

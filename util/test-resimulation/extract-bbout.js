#!/usr/bin/env node

/**
 * Utility for extracting compressed directory archives
 * 
 * This script extracts files from a compressed archive created by the
 * compressDirectory function.
 */

const fs = require("fs").promises;
const path = require("path");
const { decompressArchive } = require("../compress");

/**
 * Main function to extract a compressed archive
 */
async function main() {
  try {
    // Get command line arguments
    const args = process.argv.slice(2);

    if (args.length === 0) {
      console.error(
        "Usage: node util/extract-bbout.js <compressed-file-path> [output-directory]"
      );
      process.exit(1);
    }

    const compressedFilePath = args[0];
    // Ensure output directory is in the root, not in util folder
    const outputDir = args[1] || path.join(process.cwd(), "extracted");

    console.log(`\n🔍 Extracting compressed archive: ${compressedFilePath}`);
    console.log(`Output directory: ${outputDir}`);

    // Extract the archive
    const extractedDir = await decompressArchive(compressedFilePath, outputDir);

    console.log(`\n✅ Successfully extracted archive to: ${extractedDir}`);
    console.log(`Files extracted: ${(await fs.readdir(extractedDir)).length}`);

    // List extracted files
    const files = await fs.readdir(extractedDir);
    console.log(`\n📂 Extracted ${files.length} files:`);
    for (const file of files) {
      const stats = await fs.stat(path.join(extractedDir, file));
      const size =
        stats.size < 1024
          ? `${stats.size} bytes`
          : `${(stats.size / 1024).toFixed(2)} KB`;
      console.log(`   - ${file} (${size})`);
    }

    console.log("\n🎉 Extraction complete!");
  } catch (error) {
    console.error(`\n❌ Error extracting archive: ${error.message}`);
    process.exit(1);
  }
}

main();

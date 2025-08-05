const {
  ultraCompressDirectory,
  compressDirectory,
  decompressArchive,
} = require('./src/utilities/compressionUtils')
const fs = require('fs').promises
const path = require('path')

async function testCompression() {
  console.log('Testing enhanced compression utilities...\n')

  const testDir =
    process.argv[2] ||
    '/Users/arjun/Buildbear/Playground/NFTMarketplace-foundry/bbOut'
  const outputDir = './compression-tests'

  try {
    // Create output directory
    await fs.mkdir(outputDir, { recursive: true })

    // Test 1: Standard compression (backward compatibility)
    console.log('1. Testing standard compression (gzip, level 6)...')
    const standardResult = await compressDirectory(testDir, outputDir, {
      compressionLevel: 6,
      algorithm: 'gzip',
      deduplication: false,
      deltaCompression: false,
    })
    const standardStats = await fs.stat(standardResult)
    console.log(`   Output: ${standardResult}`)
    console.log(
      `   Size: ${(standardStats.size / 1024 / 1024).toFixed(2)} MB\n`
    )

    // Test 2: Enhanced gzip compression
    console.log(
      '2. Testing enhanced gzip compression (level 9 + optimizations)...'
    )
    const enhancedGzipResult = await compressDirectory(testDir, outputDir, {
      compressionLevel: 9,
      algorithm: 'gzip',
      deduplication: true,
      deltaCompression: true,
    })
    const enhancedGzipStats = await fs.stat(enhancedGzipResult)
    console.log(`   Output: ${enhancedGzipResult}`)
    console.log(
      `   Size: ${(enhancedGzipStats.size / 1024 / 1024).toFixed(2)} MB\n`
    )

    // Test 3: Brotli compression
    console.log('3. Testing Brotli compression (level 9)...')
    const brotliResult = await compressDirectory(testDir, outputDir, {
      compressionLevel: 9,
      algorithm: 'brotli',
      deduplication: true,
      deltaCompression: true,
    })
    const brotliStats = await fs.stat(brotliResult)
    console.log(`   Output: ${brotliResult}`)
    console.log(`   Size: ${(brotliStats.size / 1024 / 1024).toFixed(2)} MB\n`)

    // Test 4: Ultra compression
    console.log(
      '4. Testing ULTRA compression (Brotli level 11 + all optimizations)...'
    )
    const ultraResult = await ultraCompressDirectory(testDir, outputDir)
    const ultraStats = await fs.stat(ultraResult)
    console.log(`   Output: ${ultraResult}`)
    console.log(`   Size: ${(ultraStats.size / 1024 / 1024).toFixed(2)} MB\n`)

    // Calculate compression ratios
    console.log('Compression Summary:')
    console.log('===================')

    // Get original directory size
    const getDirSize = async (dir) => {
      let totalSize = 0
      const files = await fs.readdir(dir, { withFileTypes: true })

      for (const file of files) {
        const fullPath = path.join(dir, file.name)
        if (file.isDirectory()) {
          totalSize += await getDirSize(fullPath)
        } else {
          const stats = await fs.stat(fullPath)
          totalSize += stats.size
        }
      }
      return totalSize
    }

    const originalSize = await getDirSize(testDir)
    console.log(`Original size: ${(originalSize / 1024 / 1024).toFixed(2)} MB`)
    console.log(`\nCompression ratios:`)
    console.log(
      `- Standard gzip:    ${((standardStats.size / originalSize) * 100).toFixed(1)}% of original`
    )
    console.log(
      `- Enhanced gzip:    ${((enhancedGzipStats.size / originalSize) * 100).toFixed(1)}% of original`
    )
    console.log(
      `- Brotli:           ${((brotliStats.size / originalSize) * 100).toFixed(1)}% of original`
    )
    console.log(
      `- ULTRA:            ${((ultraStats.size / originalSize) * 100).toFixed(1)}% of original`
    )

    console.log(`\nSize reductions:`)
    console.log(
      `- Standard gzip:    ${((1 - standardStats.size / originalSize) * 100).toFixed(1)}% reduction`
    )
    console.log(
      `- Enhanced gzip:    ${((1 - enhancedGzipStats.size / originalSize) * 100).toFixed(1)}% reduction`
    )
    console.log(
      `- Brotli:           ${((1 - brotliStats.size / originalSize) * 100).toFixed(1)}% reduction`
    )
    console.log(
      `- ULTRA:            ${((1 - ultraStats.size / originalSize) * 100).toFixed(1)}% reduction`
    )

    // Test decompression
    console.log('\n\nTesting decompression...')
    const decompressDir = path.join(outputDir, 'decompressed')
    await decompressArchive(ultraResult, decompressDir)
    console.log('✓ Decompression successful!')
  } catch (error) {
    console.error('Test failed:', error.message)
    process.exit(1)
  }
}

// Run test
testCompression().catch(console.error)

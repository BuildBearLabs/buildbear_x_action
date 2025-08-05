const { CompressionUtils } = require('./src/utilities/compressionUtils')
const fs = require('fs').promises
const path = require('path')

async function testLzmaCompression() {
  const compressionUtils = new CompressionUtils()

  try {
    // Create test directory with some files
    const testDir = path.join(__dirname, 'test-lzma-files')
    await fs.mkdir(testDir, { recursive: true })

    // Create test files
    await fs.writeFile(
      path.join(testDir, 'file1.js'),
      'const hello = "world";\nconsole.log(hello);'
    )
    await fs.writeFile(
      path.join(testDir, 'file2.json'),
      JSON.stringify({ test: true, data: [1, 2, 3] }, null, 2)
    )
    await fs.writeFile(
      path.join(testDir, 'file3.txt'),
      'This is a test file for LZMA compression testing.'
    )

    console.log('Testing LZMA compression...')

    // Test compression
    const outputDir = path.join(__dirname, 'test-lzma-output')
    const compressedFile = await compressionUtils.compressDirectory(
      testDir,
      outputDir,
      {
        algorithm: 'lzma',
        compressionLevel: 7,
      }
    )

    console.log('Compressed file created:', compressedFile)

    // Test decompression
    const extractDir = path.join(__dirname, 'test-lzma-extracted')
    await compressionUtils.decompressArchive(compressedFile, extractDir)

    console.log('Files decompressed to:', extractDir)

    // Verify files
    const file1Content = await fs.readFile(
      path.join(extractDir, 'file1.js'),
      'utf8'
    )
    const file2Content = await fs.readFile(
      path.join(extractDir, 'file2.json'),
      'utf8'
    )
    const file3Content = await fs.readFile(
      path.join(extractDir, 'file3.txt'),
      'utf8'
    )

    console.log('\\nVerification:')
    console.log(
      'file1.js matches:',
      file1Content === 'const hello = "world";\nconsole.log(hello);'
    )
    console.log(
      'file2.json matches:',
      file2Content === JSON.stringify({ test: true, data: [1, 2, 3] }, null, 2)
    )
    console.log(
      'file3.txt matches:',
      file3Content === 'This is a test file for LZMA compression testing.'
    )

    // Cleanup
    await fs.rm(testDir, { recursive: true })
    await fs.rm(outputDir, { recursive: true })
    await fs.rm(extractDir, { recursive: true })

    console.log('\\nTest completed successfully!')
  } catch (error) {
    console.error('Test failed:', error.message)
    console.error(error.stack)
  }
}

testLzmaCompression()

const { callTrace, UmlTracer } = require('./trace')
const { encode } = require('plantuml-encoder')

async function genUmlTrace(dirPath, rpcUrl, txHash) {
  const abiMap = new Map()
  await processDirectory(dirPath, abiMap)

  const trace = await callTrace(rpcUrl, txHash)
  const tracer = new UmlTracer(rpcUrl, abiMap, trace)

  await tracer.process()
  const output = tracer.getOutput()
  const uml = encode(output)
  const url = `https://www.plantuml.com/plantuml/svg/${uml}`

  console.log(url)
}

async function processFile(filePath, abiMap) {
  try {
    const fs = require('fs').promises
    const fileContent = await fs.readFile(filePath, 'utf8')

    // Assuming the file content is JSON and contains an ABI field
    const jsonContent = JSON.parse(fileContent)
    const abi = jsonContent.abi
    const deployedBytecode = jsonContent.deployedBytecode

    if (abi && deployedBytecode) {
      let [fileName, contractName] = filePath.split('/').reverse()
      fileName = fileName.split('.')[0]
      abiMap.set([contractName, fileName], [abi, deployedBytecode])
    } else {
      console.warn(`No ABI found in ${filePath}`)
    }
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error)
  }
}

async function processDirectory(dirPath, abiMap) {
  try {
    const fs = require('fs').promises
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const entryPath = `${dirPath}/${entry.name}`
      if (entry.isFile()) {
        await processFile(entryPath, abiMap) // Process the file
      } else if (entry.isDirectory()) {
        await processDirectory(entryPath, abiMap) // Recursively process subdirectories
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error)
  }
}

module.exports = { genUmlTrace }

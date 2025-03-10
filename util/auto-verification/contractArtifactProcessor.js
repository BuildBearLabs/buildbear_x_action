const fs = require("fs").promises; // Use fs.promises for async operations
const path = require("path");
const { findDirectory } = require("../pathOperations");

// Function to read JSON files
async function readJSON(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading JSON file at ${filePath}:`, err);
    return null;
  }
}

// Function to find the artifact path for a given contract name
async function findArtifactPath(outDir, contractName) {
  const files = await fs.readdir(outDir);
  for (const file of files) {
    const filePath = path.join(outDir, file);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const artifactPath = await findArtifactPath(filePath, contractName);
      if (artifactPath) return artifactPath;
    } else if (file === `${contractName}.json`) {
      return filePath;
    }
  }
  return null;
}

async function processSources(sources) {
  try {
    if (!sources) {
      console.log("No sources provided");
      return "{}";
    }

    const filePaths = Object.keys(sources);
    const transformedSources = {};

    // Read each file directly from the project root
    for (const filePath of filePaths) {
      try {
        // First, try to use content already in the metadata
        if (sources[filePath].content) {
          transformedSources[filePath] = { content: sources[filePath].content };
          continue;
        }

        // If no content in metadata, try to read the file directly
        // Use the absolute path from the project root
        const absolutePath = path.resolve(filePath);

        const content = await fs.readFile(absolutePath, "utf8");
        transformedSources[filePath] = { content };
      } catch (fileError) {
        console.error(`Error reading file ${filePath}:`, fileError.message);

        // Try alternative path - sometimes lib paths need to be resolved differently
        try {
          // For library files that might be in node_modules
          if (filePath.startsWith("lib/")) {
            const nodeModulesPath = path.resolve(
              "node_modules",
              filePath.substring(4),
            );
            const content = await fs.readFile(nodeModulesPath, "utf8");
            transformedSources[filePath] = { content };
          } else {
            throw new Error("Alternative path not found");
          }
        } catch (altError) {
          // Fall back to a placeholder
          transformedSources[filePath] = {
            content: `// Content for ${filePath} not available`,
          };
        }
      }
    }

    return JSON.stringify(transformedSources, null, 2);
  } catch (error) {
    console.error("Unexpected error in processSources:", error);
    return "{}";
  }
}

// Function to process remappings
async function processRemappings(remappings) {
  if (!remappings || !Array.isArray(remappings)) {
    return "[]";
  }
  return JSON.stringify(remappings, null, 2);
}

// Function to process a single directory
async function processDirectory(
  broadcastDir,
  dirName,
  outDir,
  allContracts = {},
) {
  try {
    const dirPath = path.join(broadcastDir, dirName);
    const runLatestPath = path.join(dirPath, "run-latest.json");

    // Initialize this directory in allContracts if it doesn't exist
    if (!allContracts[dirName]) {
      allContracts[dirName] = [];
    }

    // Read the run-latest.json file
    const runLatest = await readJSON(runLatestPath);
    if (!runLatest) {
      console.error(`Failed to read run-latest.json in directory ${dirName}`);
      return allContracts;
    }

    // Process each transaction in run-latest.json
    for (const tx of runLatest.transactions) {
      const { contractName, contractAddress } = tx;
      if (contractName && contractAddress) {
        const artifactPath = await findArtifactPath(outDir, contractName);
        if (artifactPath) {
          const artifactContent = await readJSON(artifactPath);
          if (artifactContent && artifactContent.metadata) {
            let sources = "{}";
            if (artifactContent.metadata.sources) {
              sources = await processSources(artifactContent.metadata.sources);
            }

            let remappings = "[]";
            if (
              artifactContent.metadata.settings &&
              artifactContent.metadata.settings.remappings
            ) {
              remappings = await processRemappings(
                artifactContent.metadata.settings.remappings,
              );
            }

            // Add contract to the directory's array
            allContracts[dirName].push({
              contractAddress: contractAddress,
              contractName,
              artifact: {
                deployedBytecode: artifactContent.bytecode || "",
                abi: artifactContent.abi || [],
                language: artifactContent.metadata.language || "Solidity",
                settings: {
                  evmVersion:
                    artifactContent.metadata.settings?.evmVersion || "",
                  metadata: artifactContent.metadata.settings?.metadata || {},
                  libraries: artifactContent.metadata.settings?.libraries || {},
                  optimizer: artifactContent.metadata.settings?.optimizer || {},
                  outputSelection: {
                    "*": {
                      "*": [
                        "abi",
                        "devdoc",
                        "userdoc",
                        "storageLayout",
                        "evm.bytecode.object",
                        "evm.bytecode.sourceMap",
                        "evm.bytecode.linkReferences",
                        "evm.deployedBytecode.object",
                        "evm.deployedBytecode.sourceMap",
                        "evm.deployedBytecode.linkReferences",
                        "evm.deployedBytecode.immutableReferences",
                        "metadata",
                      ],
                    },
                  },
                  remappings: remappings,
                },
                sources: sources,
              },
            });
          } else {
            console.log(
              `Failed to read artifact for contract ${contractName} or metadata is missing.`,
            );
          }
        } else {
          console.log(`Artifact for contract ${contractName} not found.`);
        }
      }
    }

    return allContracts;
  } catch (error) {
    console.error(`Error processing directory ${dirName}:`, error);
    return allContracts;
  }
}

// Main function to process the broadcast and out directories
async function processAllDirectories(broadcastDir, outDir) {
  try {
    // Get all directories in the DeployMarket.s.sol folder
    const deployMarketDir = path.join(broadcastDir, "DeployMarket.s.sol");
    const dirs = await fs.readdir(deployMarketDir);

    let allContracts = {};

    // Process each directory
    for (const dir of dirs) {
      const dirPath = path.join(deployMarketDir, dir);
      const stat = await fs.stat(dirPath);

      if (stat.isDirectory()) {
        console.log(`Processing directory: ${dir}`);
        allContracts = await processDirectory(
          deployMarketDir,
          dir,
          outDir,
          allContracts,
        );
      }
    }

    // Optionally write to a file
    await fs.writeFile(
      "processed-contracts.json",
      JSON.stringify(allContracts, null, 2),
    );

    console.log("Results written to processed-contracts.json");

    return allContracts;
  } catch (error) {
    console.error("Error in processAllDirectories:", error);
    return {};
  }
}

function groupByContractName(data) {
  const grouped = {};

  for (const key in data) {
    data[key].forEach(({ contractName, contractAddress, ...rest }) => {
      if (!grouped[contractName]) {
        grouped[contractName] = { ...rest, contractAddresses: {} };
      }
      grouped[contractName].contractAddresses[key] = contractAddress;
    });
  }

  return grouped;
}

async function main() {
  // Set the directory paths
  const broadcastDir = path.join(__dirname, "broadcast");
  const outDir = path.join(__dirname, "out");

  console.log("Processing all directories in DeployMarket.s.sol...");
  const data = await processAllDirectories(broadcastDir, outDir);
  const dataGrouped = groupByContractName(data);
  console.log(JSON.stringify(dataGrouped, null, 2));
  return dataGrouped;
}

// Only run main when directly executed, not when imported
if (require.main === module) {
  main().catch(console.error);
}

// Export the functions for use in other modules
module.exports = {
  processAllDirectories,
  groupByContractName,
  main,
  readJSON,
  findArtifactPath,
  processSources,
  processRemappings,
  processDirectory,
};

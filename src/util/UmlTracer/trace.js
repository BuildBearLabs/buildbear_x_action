const { decodeFunctionData, decodeFunctionResult } = require('viem')

/**
 * @typedef {Map<[string, string], [Array, { object: string }]>} AbiMap
 */

/**
 * @typedef {{ object: string }} Bytecode
 */

class UmlTracer {
  /**
   * @param {string} rpcUrl
   * @param {AbiMap} abiMap
   * @param {CallTrace} trace
   */
  constructor(rpcUrl, abiMap, trace) {
    this.rpcUrl = rpcUrl
    this.abiMap = abiMap
    this.trace = trace
    this.output = ''
    this.participants = []
    this.codeCache = new Map()
  }

  getOutput() {
    const actorParticipant =
      'actor EOA as "EOA"\n' +
      this.participants
        .filter(([uniqueName]) => uniqueName !== 'EOA')
        .map(([uniqueName]) => `participant ${uniqueName} as \"${uniqueName}\"`)
        .join('\n')

    const legend =
      `legend\nParticipant details\n<#FEFECE,#D0D000>|= Alias |= Contract name |= Address |\n` +
      this.participants
        .map(
          ([uniqueName, name, address]) =>
            `<#FEFECE>| ${uniqueName} | ${name} | ${address} |`
        )
        .join('\n') +
      '\nendlegend'

    // Add Plantuml encoding
    return (
      `@startuml\n\n` +
      `autonumber\nskinparam legendBackgroundColor #FEFECE\n\n` +
      `<style>\nheader {\n    HorizontalAlignment left\n    ` +
      `FontColor purple\n    FontSize 14\n    Padding 10\n}\n</style>\n\n` +
      `header Insights\ntitle Txn Flow\n${actorParticipant}\n${this.output}\n${legend}\n\n@enduml`
    )
  }

  /**
   * @param {string} address
   * @param {string} bytecode
   * @returns {[string, string, Array]}
   */
  getNameAndAbi(address, bytecode) {
    const cache = this.participants.find(([, , a]) => a === address)
    if (cache) {
      return [cache[0], cache[1], cache[3]]
    } else {
      let contractEntry
      for (const entry of this.abiMap.entries()) {
        if (entry[1][1].object === bytecode) {
          contractEntry = entry
          break
        }
      }

      const contractName = contractEntry ?? [
        ['Unknown', 'Unknown'],
        [[], { object: '0x' }],
      ]

      const name = contractName[0][0] + '_' + contractName[0][1]

      const count = this.participants.filter(([, n]) => n === name).length

      const uniqueName = name + '_' + count
      this.participants.push([uniqueName, name, address, contractName[1][0]])

      return [uniqueName, name, contractName[1][0]]
    }
  }

  async process() {
    await this.processTrace(this.trace)
  }

  /**
   * @param {CallTrace} trace
   */
  async processTrace(trace) {
    if (['CALL', 'STATICCALL', 'DELEGATECALL'].includes(trace.type)) {
      await this.processCallTrace(trace)
    } else if (['CREATE', 'CREATE2'].includes(trace.type)) {
      await this.processCreateTrace(trace)
    }
  }

  /**
   * @param {CallTrace} trace
   */
  async processCallTrace(trace) {
    const sender = trace.from
    const senderCode = await this.getCode(sender)
    const [senderUniqueName, senderName] = this.getNameAndAbi(
      sender,
      senderCode
    )

    const contract = trace.to
    const contractCode = await this.getCode(contract)
    const [contractUniqueName, contractName, contractAbi] = this.getNameAndAbi(
      contract,
      contractCode
    )

    let args
    let functionName

    try {
      const result = decodeFunctionData({
        abi: contractAbi,
        data: trace.input,
      })
      console.log(result)
      args = result.args
      functionName = result.functionName
    } catch (_) {
      args = []
      functionName = 'unknown'
    }

    console.log(args)

    const functionLine = `"${senderUniqueName}" -> "${contractUniqueName}" ++: ${functionName}`
    const argsLine = args
      ? `note over ${senderUniqueName}, ${contractUniqueName}\n` +
        `|= value |\n` +
        `${args.map((arg) => `| ${arg} |`).join('\n')}\n` +
        `end note`
      : ''

    console.log(argsLine)

    const output = `${functionLine}\n${argsLine}\n`
    this.output += output

    if (trace.calls) {
      for (const call of trace.calls) {
        await this.processTrace(call)
      }
    }

    let returnArgs

    try {
      returnArgs = decodeFunctionResult({
        abi: contractAbi,
        functionName,
        data: trace.output,
      })
    } catch (_) {
      returnArgs = {}
    }

    const returnLine = `"${contractUniqueName}" --> "${senderUniqueName}" --: ${functionName}`
    const returnArgsLine = returnArgs
      ? `note over ${contractUniqueName}, ${senderUniqueName}\n` +
        `|= value |\n` +
        `${
          typeof returnArgs === 'object'
            ? Object.entries(returnArgs)
                .map(([, arg]) => `| ${arg} |`)
                .join('\n')
            : `| ${returnArgs} |`
        }\n` +
        `end note`
      : ''

    const returnOutput = `${returnLine}\n${returnArgsLine}\n`
    this.output += returnOutput
  }

  /**
   * @param {CallTrace} trace
   */
  async processCreateTrace(trace) {
    if (trace.calls) {
      for (const call of trace.calls) {
        await this.processTrace(call)
      }
    }
  }

  /**
   * @param {string} address
   * @returns {Promise<string>}
   */
  async getCode(address) {
    const code = this.codeCache.get(address)
    if (code) {
      return code
    }

    const payload = {
      jsonrpc: '2.0',
      method: 'eth_getCode',
      params: [address, 'latest'],
      id: 1,
    }

    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.statusText}`)
    }

    const json = await response.json()

    if (json.error) {
      throw new Error(`RPC error: ${JSON.stringify(json.error)}`)
    }

    this.codeCache.set(address, json.result)
    return json.result
  }
}

/**
 * @param {string} rpcUrl
 * @param {string} txHash
 * @returns {Promise<CallTrace>}
 */
async function callTrace(rpcUrl, txHash) {
  // const fs = require('fs').promises;
  // const trace = await fs.readFile("./trace.json", 'utf8');
  // return JSON.parse(trace).result;

  const payload = {
    jsonrpc: '2.0',
    method: 'debug_traceTransaction',
    params: [
      txHash,
      {
        tracer: 'callTracer',
        tracerConfig: {
          withLog: true,
        },
      },
    ],
    id: 1,
  }

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.statusText}`)
  }

  const json = await response.json()

  if (json.error) {
    throw new Error(`RPC error: ${JSON.stringify(json.error)}`)
  }

  return json.result
}

/**
 * @typedef {Object} CallTrace
 * @property {string} type
 * @property {string} from
 * @property {string} [to]
 * @property {string} value
 * @property {number} gas
 * @property {number} gasUsed
 * @property {string} input
 * @property {string} output
 * @property {string} [error]
 * @property {string} [revertReason]
 * @property {LogRecord[]} [logs]
 * @property {CallTrace[]} [calls]
 */

/**
 * @typedef {Object} LogRecord
 * @property {string} address
 * @property {string[]} topics
 * @property {string} data
 * @property {number} [logIndex]
 * @property {number} [blockNumber]
 * @property {number} [transactionIndex]
 */

module.exports = { UmlTracer, callTrace }

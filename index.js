const mocha = require('mocha')
const inherits = require('util').inherits
const sync = require('./sync')
const stats = require('./gasStats.js')
const reqCwd = require('req-cwd')
const sha1 = require('sha1')
const Base = mocha.reporters.Base
const color = Base.color
const log = console.log

// Based on the 'Spec' reporter
function Gas (runner, options) {

  if (!(web3.currentProvider.connection || web3.currentProvider.host)) {
    console.log('the provider use for the test does not support synchronous call but eth-gas-reporter requires it \n falling back on the Spec reporter');
    mocha.reporters.Spec.call(this, runner);
    return;
  }
  Base.call(this, runner);

  const self = this
  let indents = 0
  let n = 0
  let failed = false;
  let startBlock
  let deployStartBlock
  let methodMap
  let deployMap
  let contractNameFromCodeHash;

  // Load config / keep .ethgas.js for backward compatibility
  let config;
  if (options && options.reporterOptions){
    config = options.reporterOptions
  } else {
    config = reqCwd.silent('./.ethgas.js') || {}
  }

  config.src = config.src || 'contracts'; // default contracts folder
  // TODO grab the contract srcpath from truffle / truffle config ?

  // Start getting this data when the reporter loads.
  stats.getGasAndPriceRates(config);

  // ------------------------------------  Helpers -------------------------------------------------
  const indent = () => Array(indents).join('  ')

  const methodAnalytics = (methodMap) => {
    let gasUsed = 0
    const endBlock = sync.blockNumber();

    while (startBlock <= endBlock) {
      let block = sync.getBlockByNumber(startBlock);

      if (block) {
        // Add to running tally for this test
        gasUsed += parseInt(block.gasUsed, 16);

        // Compile per method stats
        methodMap && block.transactions.forEach(tx => {
          const transaction = sync.getTransactionByHash(tx);
          const receipt = sync.getTransactionReceipt(tx);

          // Don't count methods that throw
          const threw = parseInt(receipt.status) === 0 || receipt.status === false;
          if (threw) return

          const code = sync.getCode(transaction.to);
          const hash = sha1(code);
          let contractName = contractNameFromCodeHash[hash];

          // Handle cases where we don't have a deployment record for the contract
          // or where we *do* (from migrations) but tx actually interacts with a
          // proxy / something doesn't match.
          let isProxied = false;

          if (contractName) {
            let candidateId = stats.getMethodID(contractName, transaction.input)
            isProxied = !methodMap[candidateId]
          }

          // If unfound, search by fnHash alone instead of contract_fnHash
          if (!contractName || isProxied ) {
            let key = transaction.input.slice(2, 10);
            let matches = Object.values(methodMap).filter(el => el.key === key);

            if (matches.length >= 1) {
              contractName = matches[0].contract;
            }
          }

          const id = stats.getMethodID(contractName, transaction.input)

          if (methodMap[id]) {
            methodMap[id].gasData.push(parseInt(receipt.gasUsed, 16))
            methodMap[id].numberOfCalls++
          }
        })
      }
      startBlock++
    }
    return gasUsed
  }

  const deployAnalytics = (deployMap) => {
    const endBlock = sync.blockNumber();

    while (deployStartBlock <= endBlock) {
      let block = sync.getBlockByNumber(deployStartBlock);

      block && block.transactions.forEach(tx => {
        const receipt = sync.getTransactionReceipt(tx);
        const threw = parseInt(receipt.status) === 0 || receipt.status === false;

        if (receipt.contractAddress && !threw) {
          const transaction = sync.getTransactionByHash(tx)

          const matches = deployMap.filter(contract => {
            return stats.matchBinaries(transaction.input, contract.binary);
          })

          if(matches && matches.length){
            const match = matches.find(item => item.binary !== '0x');

            if (match) {
              // We have to get code that might be linked here in
              // in order to match correctly at the method ids
              const code = sync.getCode(receipt.contractAddress);
              const hash = sha1(code);

              match.gasData.push(parseInt(receipt.gasUsed, 16));
              contractNameFromCodeHash[hash] = match.name;
            }
          }
        }
      })
      deployStartBlock++
    }
  }

  // ------------------------------------  Runners -------------------------------------------------
  runner.on('start', () => {
    ({ methodMap, deployMap, contractNameFromCodeHash } = stats.mapMethodsToContracts(artifacts, config.src))
  })

  runner.on('suite', suite => {
    ++indents
    log(color('suite', '%s%s'), indent(), suite.title)
  })

  runner.on('suite end', () => {
    --indents
    if (indents === 1) {
      log()
    }
  })

  runner.on('pending', test => {
    let fmt = indent() + color('pending', '  - %s')
    log(fmt, test.title)
  })

  runner.on('test', () => { deployStartBlock = sync.blockNumber() })

  runner.on('hook end', () => { startBlock = sync.blockNumber() + 1 })

  runner.on('pass', test => {
    let fmt
    let fmtArgs
    let gasUsedString
    deployAnalytics(deployMap)
    let gasUsed = methodAnalytics(methodMap)
    let showTimeSpent = config.showTimeSpent || false
    let timeSpentString = color(test.speed, '%dms')
    let consumptionString
    if (gasUsed) {
      gasUsedString = color('checkmark', '%d gas')

      if (showTimeSpent) {
        consumptionString = ' (' + timeSpentString + ', ' + gasUsedString + ')'
        fmtArgs = [test.title, test.duration, gasUsed]
      } else {
        consumptionString = ' (' + gasUsedString + ')'
        fmtArgs = [test.title, gasUsed]
      }

      fmt = indent() +
      color('checkmark', '  ' + Base.symbols.ok) +
      color('pass', ' %s') +
      consumptionString
    } else {
      if (showTimeSpent) {
        consumptionString = ' (' + timeSpentString + ')'
        fmtArgs = [test.title, test.duration]
      } else {
        consumptionString = ''
        fmtArgs = [test.title]
      }

      fmt = indent() +
        color('checkmark', '  ' + Base.symbols.ok) +
        color('pass', ' %s') +
        consumptionString
    }
    log.apply(null, [fmt, ...fmtArgs])
  })

  runner.on('fail', test => {
    failed = true;
    let fmt = indent() + color('fail', '  %d) %s')
    log()
    log(fmt, ++n, test.title)
  })

  runner.on('end', () => {
    stats.generateGasStatsReport(methodMap, deployMap, contractNameFromCodeHash)
    self.epilogue()
  });
}

/**
 * Inherit from `Base.prototype`.
 */
inherits(Gas, Base)

module.exports = Gas

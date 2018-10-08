const SafeEventEmitter = require('safe-event-emitter')
const createScaffoldMiddleware = require('eth-json-rpc-middleware/scaffold')
const createAsyncMiddleware = require('json-rpc-engine/src/createAsyncMiddleware')
const createFilterMiddleware = require('./index.js')
const { unsafeRandomBytes, incrementHexInt } = require('./hexUtils.js')
const getBlocksForRange = require('./getBlocksForRange.js')

module.exports = createSubscriptionMiddleware


function createSubscriptionMiddleware({ blockTracker, provider }) {
  // state and utilities for handling subscriptions
  const subscriptions = {}
  const filterManager = createFilterMiddleware({ blockTracker, provider })

  // create subscriptionManager api object
  const events = new SafeEventEmitter()
  const middleware = createScaffoldMiddleware({
    eth_subscribe: createAsyncMiddleware(subscribe),
    eth_unsubscribe: createAsyncMiddleware(unsubscribe),
  })
  return { events, middleware }

  async function subscribe(req, res) {
    const subscriptionType = req.params[0]
    // subId is 16 byte hex string
    const subId = unsafeRandomBytes(16)

    // create sub
    let sub
    switch (subscriptionType) {
      case 'newHeads':
        sub = createSubNewHeads({ subId })
        break
      case 'logs':
        const filterIdHex = await filterManager.newLogFilter(req)
        sub = createSubFromFilter({ subId, filterIdHex })
        break
      default:
        throw new Error(`SubscriptionManager - unsupported subscription type "${subscriptionType}"`)

    }
    subscriptions[subId] = sub

    // check for subscription updates on new block
    blockTracker.on('sync', sub.update)

    res.result = subId
    return

    function createSubNewHeads({ subId }) {
      const sub = {
        type: subscriptionType,
        destroy: () => {
          blockTracker.removeListener('sync', sub.update)
        },
        update: async ({ oldBlock, newBlock }) => {
          // for newHeads
          const toBlock = newBlock
          const fromBlock = incrementHexInt(oldBlock)
          const rawBlocks = await getBlocksForRange({ provider, fromBlock, toBlock })
          const results = rawBlocks.map(normalizeBlock)
          results.forEach((value) => {
            _emitSubscriptionResult(subId, value)
          })
        }
      }
      return sub
    }

    function createSubFromFilter({ subId, filterIdHex }){
      const sub = {
        type: subscriptionType,
        destroy: () => {
          blockTracker.removeListener('sync', sub.update)
        },
        update: async () => {
          // check filter for updates
          const results = await filterManager.getFilterChanges({ params: [filterIdHex] })
          // emit updates
          results.forEach(async (result) => {
            _emitSubscriptionResult(subId, result)
          })
        }
      }
      return sub
    }
  }

  async function unsubscribe(req, res) {
    const id = req.params[0]
    const subscription = subscriptions[id]
    // if missing, return "false" to indicate it was not removed
    if (!subscription) {
      res.result = false
      return
    }
    // cleanup subscription
    delete subscriptions[id]
    subscription.destroy()
    res.result = true
  }

  function _emitSubscriptionResult(filterIdHex, value) {
    events.emit('notification', {
      jsonrpc: '2.0',
      method: 'eth_subscription',
      params: {
        subscription: filterIdHex,
        result: value,
      },
    })
  }

}

function normalizeBlock(block) {
  return {
    hash: block.hash,
    parentHash: block.parentHash,
    sha3Uncles: block.sha3Uncles,
    miner: block.miner,
    stateRoot: block.stateRoot,
    transactionsRoot: block.transactionsRoot,
    receiptsRoot: block.receiptsRoot,
    logsBloom: block.logsBloom,
    difficulty: block.difficulty,
    number: block.number,
    gasLimit: block.gasLimit,
    gasUsed: block.gasUsed,
    nonce: block.nonce,
    mixHash: block.mixHash,
    timestamp: block.timestamp,
    extraData: block.extraData,
  }
}

'use strict'

const Client = require('bitcoin-core')

const Logger = require('./lib/Logger.js')
const EncryptionKeys = require('./lib/EncryptionKeys.js')
const PreFlight = require('./lib/PreFlight.js')
const PrepareOutgoing = require('./lib/PrepareOutgoing.js')
const ProcessOutgoing = require('./lib/ProcessOutgoing.js')
const PayoutFee = require('./lib/PayoutFee')
const ReturnSubnav = require('./lib/ReturnSubnav')

const config = require('config')

const settings = config.get('OUTGOING')

// -------------- RUN OUTGOING SERVER ------------------------------------------

const OutgoingServer = {
  processing: false,
  paused: false,
  runtime: {},
}

// --------- Client Initialisation ---------------------------------------------

OutgoingServer.init = () => {
  OutgoingServer.navClient = new Client({
    username: settings.navCoin.user,
    password: settings.navCoin.pass,
    port: settings.navCoin.port,
    host: settings.navCoin.host,
  })

  OutgoingServer.subClient = new Client({
    username: settings.subChain.user,
    password: settings.subChain.pass,
    port: settings.subChain.port,
    host: settings.subChain.host,
  })

  Logger.writeLog('OUT_000', 'server starting')
  EncryptionKeys.findKeysToRemove({ type: 'private' }, OutgoingServer.startProcessing)
  setInterval(() => {
    if (OutgoingServer.paused === false) {
      EncryptionKeys.findKeysToRemove({ type: 'private' }, OutgoingServer.startProcessing)
    } else {
      Logger.writeLog('OUT_001', 'processing paused', { paused: OutgoingServer.paused })
    }
  }, settings.scriptInterval)
}

OutgoingServer.startProcessing = () => {
  if (OutgoingServer.processing) {
    Logger.writeLog('OUT_002', 'server still processing', { processing: OutgoingServer.processing })
    return
  }
  OutgoingServer.processing = true
  OutgoingServer.runtime = {}
  OutgoingServer.runtime.cycleStart = new Date()
  PreFlight.run({
    navClient: OutgoingServer.navClient,
    subClient: OutgoingServer.subClient,
    settings,
  }, OutgoingServer.preFlightComplete)
}

OutgoingServer.preFlightComplete = (success, data) => {
  if (!success) {
    Logger.writeLog('OUT_003', 'preflight checks failed', { success, data }, true)
    OutgoingServer.processing = false
    return
  }
  OutgoingServer.runtime.navBalance = data.navBalance
  OutgoingServer.runtime.subBalance = data.subBalance
  PrepareOutgoing.run({
    navClient: OutgoingServer.navClient,
    subClient: OutgoingServer.subClient,
    navBalance: data.navBalance,
    settings,
  }, OutgoingServer.currentBatchPrepared)
}

OutgoingServer.currentBatchPrepared = (success, data) => {
  if (!success) {
    OutgoingServer.processing = false
    return
  }

  OutgoingServer.runtime.failedSubTransactions = data.failedSubTransactions
  OutgoingServer.runtime.currentBatch = data.currentBatch

  ProcessOutgoing.run({
    currentBatch: OutgoingServer.runtime.currentBatch,
    navClient: OutgoingServer.navClient,
    settings,
  }, OutgoingServer.transactionsProcessed)
}

OutgoingServer.transactionsProcessed = (success, data) => {
  if (!success || !data) {
    Logger.writeLog('OUT_004', 'failed to process transactions', { success, data }, true)
    OutgoingServer.processing = false
    OutgoingServer.paused = true
    return
  }

  if (!data.successfulTransactions || data.successfulTransactions.length < 1) {
    Logger.writeLog('OUT_005', 'all transactions failed', data, true)
    OutgoingServer.processing = false
    OutgoingServer.paused = true
    return
  }

  OutgoingServer.runtime.successfulTransactions = data.successfulTransactions

  PayoutFee.run({
    navClient: OutgoingServer.navClient,
    settings,
  }, OutgoingServer.feePaid)
}

OutgoingServer.feePaid = (success, data) => {
  if (!success) {
    Logger.writeLog('OUT_006', 'failed nav send to txfee address', {
      transaction: data.transaction,
      error: data.error,
    }, true)
  }

  ReturnSubnav.run({
    transactions: OutgoingServer.runtime.successfulTransactions,
    subClient: OutgoingServer.subClient,
    settings,
  }, OutgoingServer.subnavReturned)
}

OutgoingServer.subnavReturned = (success) => {
  if (!success) {
    Logger.writeLog('OUT_007', 'unable to return subnav to incoming server', {
      transactions: OutgoingServer.runtime.successfulTransactions,
    }, true)
    OutgoingServer.paused = true
    OutgoingServer.processing = false
    return
  }

  OutgoingServer.processing = false
  return
}

module.exports = OutgoingServer

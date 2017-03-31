const _ = require('lodash/fp')
const mem = require('mem')
const HKDF = require('node-hkdf-sync')

const configManager = require('./config-manager')
const pify = require('pify')
const fs = pify(require('fs'))
const options = require('./options')

const FETCH_INTERVAL = 5000

function computeSeed (masterSeed) {
  const hkdf = new HKDF('sha256', 'lamassu-server-salt', masterSeed)
  return hkdf.derive('wallet-seed', 32)
}

function fetchWallet (settings, cryptoCode) {
  return fs.readFile(options.seedFile)
  .then(hex => {
    const masterSeed = Buffer.from(hex.trim(), 'hex')
    console.log('DEBUG44')
    console.log('DEBUG44.0.0: %j', cryptoCode)
    try {
      console.log('DEBUG44.0: %j', configManager.cryptoScoped(cryptoCode, settings.config).wallet)
    } catch (err) {
      console.log('DEBUG44.0.e: %s', err.stack)
    }
    const plugin = configManager.cryptoScoped(cryptoCode, settings.config).wallet
    console.log('DEBUG44.1')
    const account = settings.accounts[plugin]
    console.log('DEBUG44.2')
    const wallet = require('lamassu-' + plugin)

    console.log('DEBUG45: %j', {wallet, account})

    return {wallet, seed: _.set('seed', computeSeed(masterSeed), account)}
  })
}

function balance (settings, cryptoCode) {
  return fetchWallet(settings, cryptoCode)
  .then(r => r.wallet.balance(r.account, cryptoCode))
  .then(balance => ({balance, timestamp: Date.now()}))
}

function sendCoins (settings, toAddress, cryptoAtoms, cryptoCode) {
  console.log('DEBUG40')
  return fetchWallet(settings, cryptoCode)
  .then(r => {
    console.log('DEBUG41')
    return r.wallet.sendCoins(r.account, toAddress, cryptoAtoms, cryptoCode)
    .then(res => {
      console.log('DEBUG42')
      mem.clear(module.exports.balance)
      console.log('DEBUG43: %j', res)
      return res
    })
  })
}

function newAddress (settings, info) {
  return fetchWallet(settings, info.cryptoCode)
  .then(r => r.wallet.newAddress(r.account, info))
}

function getStatus (settings, toAddress, cryptoAtoms, cryptoCode) {
  return fetchWallet(settings, cryptoCode)
  .then(r => r.wallet.getStatus(r.account, toAddress, cryptoAtoms, cryptoCode))
}

function sweep (settings, cryptoCode, hdIndex) {
  return fetchWallet(settings, cryptoCode)
  .then(r => r.wallet.sweep(r.account, cryptoCode, hdIndex))
}

module.exports = {
  balance: mem(balance, {maxAge: FETCH_INTERVAL}),
  sendCoins,
  newAddress,
  getStatus,
  sweep
}

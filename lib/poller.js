const plugins = require('./plugins')
const notifier = require('./notifier')
const T = require('./time')
const logger = require('./logger')

const INCOMING_TX_INTERVAL = 30 * T.seconds
const LIVE_INCOMING_TX_INTERVAL = 5 * T.seconds
const UNNOTIFIED_INTERVAL = 10 * T.seconds
const SWEEP_HD_INTERVAL = T.minute
const TRADE_INTERVAL = 10 * T.seconds
const PONG_INTERVAL = 10 * T.seconds
const PONG_CLEAR_INTERVAL = 1 * T.day
const CHECK_NOTIFICATION_INTERVAL = 30 * T.seconds

let pi

function reload (settings) {
  pi = plugins(settings)
  logger.debug('settings reloaded in poller')
}

function start (settings) {
  reload(settings)

  pi.executeTrades()
  pi.pong()
  pi.pongClear()
  pi.monitorLiveIncoming()
  pi.monitorIncoming()
  pi.monitorUnnotified()
  pi.sweepHd()
  notifier.checkNotification(pi)

  setInterval(() => pi.executeTrades(), TRADE_INTERVAL)
  setInterval(() => pi.monitorLiveIncoming(), LIVE_INCOMING_TX_INTERVAL)
  setInterval(() => pi.monitorIncoming(), INCOMING_TX_INTERVAL)
  setInterval(() => pi.monitorUnnotified(), UNNOTIFIED_INTERVAL)
  setInterval(() => pi.sweepHd(), SWEEP_HD_INTERVAL)
  setInterval(() => pi.pong(), PONG_INTERVAL)
  setInterval(() => pi.pongClear(), PONG_CLEAR_INTERVAL)
  setInterval(() => notifier.checkNotification(pi), CHECK_NOTIFICATION_INTERVAL)
}

module.exports = {start, reload}

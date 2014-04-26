'use strict';

var path = require('path');
var async = require('async');
var winston = require('winston');

var SATOSHI_FACTOR = Math.pow(10, 8);

// TODO: Define this somewhere more global
var SESSION_TIMEOUT = 60 * 60 * 1000;   // an hour

var Trader = module.exports = function (db) {
  if (!db) {
    throw new Error('`db` is required');
  }

  this.db = db;
  this.rates = {};
  this.logger = new (winston.Logger)({
    transports: [new (winston.transports.Console)()]
  });

  this._tradeQueue = [];
  this._sessionInfo = {};
};

Trader.prototype._findExchange = function (name) {
  var exchange;

  try {
    exchange = require('lamassu-' + name);
  } catch (err) {
    if (!err.message.match(/Cannot find module/)) {
      throw err;
    }

    exchange = require(path.join(path.dirname(__dirname), 'exchanges', name));
  }

  return exchange;
};

Trader.prototype._findTicker = function (name) {
  var exchange = Trader.prototype._findExchange(name);
  return exchange.ticker || exchange;
};

Trader.prototype._findTrader = function (name) {
  var exchange = Trader.prototype._findExchange(name);
  return exchange.trader || exchange;
};

Trader.prototype._findWallet = function (name) {
  var exchange = Trader.prototype._findExchange(name);
  return exchange.wallet || exchange;
};

Trader.prototype._tradeQueueFiatBalance = function (exchangeRate) {
  var satoshis = this._tradeQueue.reduce(function (memo, rec) {
    return memo + rec.satoshis;
  }, 0);
  return (satoshis / SATOSHI_FACTOR) * exchangeRate;
};

Trader.prototype._consolidateTrades = function () {
  var queue = this._tradeQueue;

  var tradeRec = {
    fiat: 0,
    satoshis: 0,
    currency: this.config.exchanges.settings.currency
  };

  while (true) {
    var lastRec = queue.shift();
    if (!lastRec) {
      break;
    }
    tradeRec.fiat += lastRec.fiat;
    tradeRec.satoshis += lastRec.satoshis;
    tradeRec.currency = lastRec.currency;
  }
  return tradeRec;
};

Trader.prototype._purchase = function (trade, cb) {
  var self = this;
  var rate = self.rate(trade.currency);
  self.tradeExchange.purchase(trade.satoshis, rate.rate, function (err) {
    if (err) return cb(err);
    self.pollBalance();
    cb();
  });
};

Trader.prototype.configure = function (config) {
  if (config.exchanges.settings.lowBalanceMargin < 1) {
    throw new Error('`settings.lowBalanceMargin` has to be >= 1');
  }

  var tickerExchangeCode = config.exchanges.plugins.current.ticker;
  var tickerExchangeConfig = config.exchanges.plugins.settings[tickerExchangeCode] || {};
  tickerExchangeConfig.currency = config.exchanges.settings.currency;
  this.tickerExchange = this._findTicker(tickerExchangeCode).factory(tickerExchangeConfig);

  var tradeExchangeCode = config.exchanges.plugins.current.trade;
  if (tradeExchangeCode) {
    var tradeExchangeConfig = config.exchanges.plugins.settings[tradeExchangeCode];
    this.tradeExchange = this._findTrader(tradeExchangeCode).factory(tradeExchangeConfig);
  }

  var transferExchangeCode = config.exchanges.plugins.current.transfer;
  var transferExchangeConfig = config.exchanges.plugins.settings[transferExchangeCode];
  this.transferExchange = this._findWallet(transferExchangeCode).factory(transferExchangeConfig);

  this.config = config;

  this.pollBalance();
  this.pollRate();
};

// IMPORTANT: This function returns the estimated minimum available balance
// in fiat as of the start of the current user session on the device. User 
// session starts when a user presses then Start button and ends when we
// send the bitcoins.
Trader.prototype.fiatBalance = function (deviceFingerprint) {
  var rawRate = this.rate(this.config.exchanges.settings.currency).rate;
  var balance = this.balance;
  var commission = this.config.exchanges.settings.commission;

  if (!rawRate || !balance) {
    return 0;
  }

  // The rate is actually our commission times real rate.
  var rate = commission * rawRate;

  // `lowBalanceMargin` is our safety net. It's a number > 1, and we divide
  // all our balances by it to provide a safety margin.
  var lowBalanceMargin = this.config.exchanges.settings.lowBalanceMargin;

  // `balance.transferBalance` is the balance of our transfer account (the one
  // we use to send Bitcoins to clients).
  var transferBalance = balance.transferBalance;
  
  // Since `transferBalance` is in satoshis, we need to turn it into
  // bitcoins and then fiat to learn how much fiat currency we can exchange.
  //
  // Unit validity proof: [ $ ] = [ (B * 10^8) / 10^8 * $/B ]
  //                      [ $ ] = [ B * $/B ]
  //                      [ $ ] = [ $ ]
  var fiatTransferBalance = ((transferBalance / SATOSHI_FACTOR) * rate) / lowBalanceMargin;

  // If this server is also configured to trade received fiat for Bitcoins,
  // we also need to calculate if we have enough funds on our trade exchange.
  if (balance.tradeBalance === null) return fiatTransferBalance;
  var tradeBalance = balance.tradeBalance;

  // We're reporting balance as of the start of the user session.
  var sessionInfo = this._sessionInfo[deviceFingerprint];
  var sessionBalance = sessionInfo ? sessionInfo.tradeBalance : tradeBalance;
  var fiatTradeBalance = sessionBalance / lowBalanceMargin;

  // And we return the smallest number.
  return Math.min(fiatTransferBalance, fiatTradeBalance);
};

Trader.prototype._clearSession = function (deviceFingerprint) {
  var sessionInfo = this._sessionInfo[deviceFingerprint];
  if (sessionInfo) {
    clearTimeout(sessionInfo.reaper);
    delete this._sessionInfo[deviceFingerprint];
  }
};

Trader.prototype.sendBitcoins = function (deviceFingerprint, tx, cb) {
  var self = this;

  self.db.summonTransaction(deviceFingerprint, tx, function (err, isNew, txHash) {
    if (err) {
      return cb(err);
    }

    if (isNew) {
      this._clearSession(deviceFingerprint);
      return self.transferExchange.sendBitcoins(
        tx.toAddress,
        tx.satoshis,
        self.config.exchanges.settings.transactionFee,
        function(err, txHash) {
          if (err) {
            self.db.reportTransactionError(tx, err);
            return cb(err);
          }

          cb(null, txHash);
          self.db.completeTransaction(tx, txHash);
          self.pollRate();
        }
      );
    }

    // transaction exists, but txHash might be null, 
    // in which case ATM should continue polling  
    cb(null, txHash);
  });
};

Trader.prototype.trade = function (rec, deviceFingerprint) {
  // This is where we record starting trade balance at the beginning
  // of the user session
  var sessionInfo = this._sessionInfo[deviceFingerprint];
  var self = this;
  if (!sessionInfo) {
    this._sessionInfo[deviceFingerprint] = {
      tradeBalance: this.balance.tradeBalance,
      timestamp: Date.now(),
      reaper: setTimeout(function () {
        delete self._sessionInfo[deviceFingerprint];
      }, SESSION_TIMEOUT)
    };
  } 
  this._tradeQueue.push({fiat: rec.fiat, satoshis: rec.satoshis, currency: rec.currency});
};

Trader.prototype.executeTrades = function () {
  if (!this.tradeExchange) return;

  this.logger.info('checking for trades');

  var trade = this._consolidateTrades();
  this.logger.info('consolidated: ', JSON.stringify(trade));

  if (trade.fiat === 0) {
    this.logger.info('rejecting 0 trade');
    return;
  }

  if (trade.fiat < this.config.exchanges.settings.minimumTradeFiat) {
    // throw it back in the water
    this.logger.info('reject fiat too small');
    this._tradeQueue.unshift(trade);
    return;
  }

  this.logger.info('making a trade: %d', trade.satoshis / Math.pow(10, 8));
  var self = this;
  this._purchase(trade, function (err) {
    if (err) self.logger.error(err);
  });
};

Trader.prototype.startPolling = function () {
  this.pollBalance();
  this.pollRate();
  this.executeTrades();

  this.balanceInterval = setInterval(this.pollBalance.bind(this), 60 * 1000);
  this.rateInterval = setInterval(this.pollRate.bind(this), 60 * 1000);

  // Always start trading, even if we don't have a trade exchange configured,
  // since configuration can always change in `Trader#configure`.
  // `Trader#executeTrades` returns early if we don't have a trade exchange
  // configured at the moment.
  this.tradeInterval = setInterval(
    this.executeTrades.bind(this),
    this.config.exchanges.settings.tradeInterval
  );
};

Trader.prototype.stopPolling = function () {
  clearInterval(this.balanceInterval);
  clearInterval(this.rateInterval);
};

Trader.prototype.pollBalance = function (callback) {
  var self = this;

  self.logger.info('collecting balance');

  async.parallel({
    transferBalance: self.transferExchange.balance.bind(self.transferExchange),
    tradeBalance: function (next) {
      if (!self.tradeExchange) {
        return next(null, null);
      }

      self.tradeExchange.balance(next);
    }
  }, function (err, balance) {
    if (err) {
      return callback && callback(err);
    }

    balance.timestamp = Date.now();
    self.logger.info('Balance update:', balance);
    self.balance = balance;

    return callback && callback(null, balance);
  });
};

Trader.prototype.pollRate = function (callback) {
  var self = this;

  var currency = self.config.exchanges.settings.currency;
  self.logger.info('polling for rate...');
  self.tickerExchange.ticker(currency, function(err, rate) {
    if (err) {
      return callback && callback(err);
    }

    self.logger.info('Rate update:', rate);
    self.rates[currency] = {rate: rate, timestamp: new Date()};
    return callback && callback(null, self.rates[currency]);
  });
};

Trader.prototype.rate = function () {
  return this.rates[this.config.exchanges.settings.currency];
};
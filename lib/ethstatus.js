'use strict';

require('./logger.js');
const chalk = require('chalk');
const os = require('os');
const _ = require('lodash');
const async = require('async');
const debounce = require('debounce');

var pjson = require('./../package.json');

const Web3 = require('web3');
let web3;

const INSTANCE_NAME = process.env.INSTANCE_NAME;
const MAX_CONNECTION_ATTEMPTS = 5;
const CONNECTION_ATTEMPTS_TIMEOUT = 1000; // ms
const UPDATE_INTERVAL = 5000; //5 sec. 
const LONG_POLL_DURATION = 60000; // 1 minute

if (process.env.NODE_ENV === 'production' && INSTANCE_NAME === "") {
  console.error("No instance name specified!");
  process.exit(1);
}

function EthStatus() {
  this.info = {
    name: (INSTANCE_NAME || (process.env.EC2_INSTANCE_ID || os.hostname())),
    contact: (process.env.CONTACT_DETAILS || ""),
    coinbase: null,
    node: null,
    net: null,
    protocol: null,
    api: null,
    port: (process.env.LISTENING_PORT || 30303),
    os: os.platform(),
    os_v: os.release(),
    client: pjson.version,
    canUpdateHistory: true,
    messages: []
  };

  this.id = _.camelCase(this.info.name);

  this.stats = {
    active: false,
    mining: false,
    hashrate: 0,
    peers: 0,
    pending: 0,
    gasPrice: 0,
    block: {
      number: 0,
      hash: '?',
      difficulty: 0,
      totalDifficulty: 0,
      transactions: [],
      uncles: []
    },
    syncing: false,
    uptime: 0
  };

  this._lastBlock = 0;
  this._lastStats = JSON.stringify(this.stats);
  this._lastFetch = 0;
  this._lastPending = 0;

  this._tries = 0;
  this._down = 0;
  this._lastSent = 0;
  this._latency = 0;

  this._web3 = false;
  this._socket = false;

  this._latestQueue = null;
  this.pendingFilter = false;
  this.chainFilter = false;
  this.updateInterval = false;
  // this.pingInterval = false;
  this.connectionInterval = false;

  this._lastBlockSentAt = 0;
  this._lastChainLog = 0;
  this._lastPendingLog = 0;
  this._chainDebouncer = 0;
  this._chan_min_time = 50;
  this._max_chain_debouncer = 20;
  this._chain_debouncer_cnt = 0;
  this._connection_attempts = 0;
  this._timeOffset = null;

  this.startWeb3Connection();

  return this;
}


EthStatus.prototype.init = function () {
  // Fetch node info
  this.getInfo();

  // // Start socket connection
  // this.startSocketConnection();

  // Set filters
  this.setWatches();
}

EthStatus.prototype.startWeb3Connection = function () {
  console.info('Starting web3 connection');

  web3 = new Web3();
  web3.setProvider(new web3.providers.HttpProvider('http://' + (process.env.RPC_HOST || 'localhost') + ':' + (process.env.RPC_PORT || '8545')));

  this.checkWeb3Connection();
}

EthStatus.prototype.checkWeb3Connection = function () {
  var self = this;

  if (!this._web3) {
    if (web3.isConnected()) {
      console.success('Web3 connection established');

      this._web3 = true;
      this.init();

      return true;
    }
    else {
      if (this._connection_attempts < MAX_CONNECTION_ATTEMPTS) {
        console.error
          ('Web3 connection attempt', chalk.cyan('#' + this._connection_attempts++), 'failed');
        console.error('Trying again in', chalk.cyan(500 * this._connection_attempts + ' ms'));

        setTimeout(function () {
          self.checkWeb3Connection();
        }, CONNECTION_ATTEMPTS_TIMEOUT * this._connection_attempts);
      }
      else {
        console.error('Web3 connection failed', chalk.cyan(MAX_CONNECTION_ATTEMPTS), 'times. Aborting...');
        console.success('will try again in 1 second.');
        setTimeout(function () {
          self.checkWeb3Connection();
        }, LONG_POLL_DURATION)
      }
    }
  }
}

EthStatus.prototype.getInfo = function () {
  console.info('==>', 'Getting info');
  console.time('Got info');

  try {
    console.info('getting coinbase');
    //console.debug(web3)
    this.info.coinbase = this.coinbase();// ( web3 && web3.eth && web3.eth.coinbase) ? "foo" : "0x";
    console.info('getting node version');
    this.info.node = web3.version.node;
    console.info('getting network');
    this.info.net = web3.version.network;
    console.info('getting protocol');
    this.info.protocol = web3.toDecimal(web3.version.ethereum);
    console.info('getting api');
    this.info.api = web3.version.api;

    console.timeEnd('Got info');
    console.info(this.info);

    return true;
  }
  catch (err) {
    console.error("Could no t get version");
  }

  return false;
}

EthStatus.prototype.setWatches = function () {
  var self = this;

  this.setFilters();

  this.updateInterval = setInterval(function () {
    self.getStats();
  }, UPDATE_INTERVAL);

  // if( !this.pingInterval )
  // {
  //   this.pingInterval = setInterval( function(){
  //     self.ping();
  //   }, PING_INTERVAL);
  // }

  web3.eth.isSyncing(function (error, sync) {
    if (!error) {
      if (sync === true) {
        web3.reset(true);
        console.info("SYNC STARTED:", sync);
      } else if (sync) {
        var synced = sync.currentBlock - sync.startingBlock;
        var total = sync.highestBlock - sync.startingBlock;
        sync.progress = synced / total;
        self.stats.syncing = sync;

        if (self._lastBlock !== sync.currentBlock) {
          self._latestQueue.push(sync.currentBlock);
        }
        console.info("SYNC UPDATE:", sync);
      } else {
        console.info("SYNC STOPPED:", sync);
        self.stats.syncing = false;
        self.setFilters();
      }
    } else {
      self.stats.syncing = false;
      self.setFilters();
      console.error("SYNC ERROR", error);
    }
  });
}


EthStatus.prototype.setFilters = function () {
  var self = this;

  this._latestQueue = async.queue(function (hash, callback) {
    var timeString = 'Got block ' + chalk.reset.red(hash) + chalk.reset.bold.white(' in') + chalk.reset.green('');
    console.time('==>', timeString);

    web3.eth.getBlock(hash, false, function (error, result) {
      self.validateLatestBlock(error, result, timeString);
      callback();
    });
  }, 1);

  this._latestQueue.drain = function () {
    console.sstats("Finished processing", 'latest', 'queue');
    self.getPending();
  }

  this._debouncedChain = debounce(function (hash) {
    console.stats('>>>', 'Debounced');
    self._latestQueue.push(hash);
  }, 120);

  this._debouncedPending = debounce(function () {
    self.getPending();
  }, 5);

  try {
    this.chainFilter = web3.eth.filter('latest');
    this.chainFilter.watch(function (err, hash) {
      var now = _.now();
      var time = now - self._lastChainLog;
      self._lastChainLog = now;

      if (hash === null) {
        hash = web3.eth.blockNumber;
      }

      console.stats('>>>', 'Chain Filter triggered: ', chalk.reset.red(hash), '- last trigger:', chalk.reset.cyan(time));

      if (time < self._chan_min_time) {
        self._chainDebouncer++;
        self._chain_debouncer_cnt++;

        if (self._chain_debouncer_cnt > 100) {
          self._chan_min_time = Math.max(self._chan_min_time + 1, 200);
          self._max_chain_debouncer = Math.max(self._max_chain_debouncer - 1, 5);
        }
      }
      else {
        if (time > 5000) {
          self._chan_min_time = 50;
          self._max_chain_debouncer = 20;
          self._chain_debouncer_cnt = 0;
        }
        // reset local chain debouncer
        self._chainDebouncer = 0;
      }

      if (self._chainDebouncer < self._max_chain_debouncer || now - self._lastBlockSentAt > 5000) {
        if (now - self._lastBlockSentAt > 5000) {
          self._lastBlockSentAt = now;
        }

        self._latestQueue.push(hash);
      }
      else {
        self._debouncedChain(hash);
      }
    });

    console.success("Installed chain filter");
  }
  catch (err) {
    this.chainFilter = false;

    console.error("Couldn't set up chain filter");
    console.error(err);
  }

  try {
    this.pendingFilter = web3.eth.filter('pending');
    this.pendingFilter.watch(function (err, hash) {
      var now = _.now();
      var time = now - self._lastPendingLog;
      self._lastPendingLog = now;

      console.stats('>>>', 'Pending Filter triggered:', chalk.reset.red(hash), '- last trigger:', chalk.reset.cyan(time));

      if (time > 50) {
        self.getPending();
      }
      else {
        self._debouncedPending();
      }
    });

    console.success("Installed pending filter");
  }
  catch (err) {
    this.pendingFilter = false;

    console.error("Couldn't set up pending filter");
    console.error(err);
  }
}


EthStatus.prototype.getStats = function (forced) {
  var self = this;
  var now = _.now();
  var lastFetchAgo = now - this._lastFetch;
  this._lastFetch = now;

  if (this._socket)
    this._lastStats = JSON.stringify(this.stats);

  if (this._web3 && (lastFetchAgo >= UPDATE_INTERVAL || forced === true)) {
    console.stats('==>', 'Getting stats')
    console.stats('   ', 'last update:', chalk.reset.cyan(lastFetchAgo));
    console.stats('   ', 'forced:', chalk.reset.cyan(forced === true));

    async.parallel({
      peers: function (callback) {
        web3.net.getPeerCount(callback);
      },
      mining: function (callback) {
        web3.eth.getMining(callback);
      },
      hashrate: function (callback) {
        web3.eth.getHashrate(callback);
      },
      gasPrice: function (callback) {
        web3.eth.getGasPrice(callback);
      },
      syncing: function (callback) {
        web3.eth.getSyncing(callback);
      }
    },
      function (err, results) {
        self._tries++;

        if (err) {
          console.error('xx>', 'getStats error: ', err);

          self.setInactive();

          return false;
        }

        results.end = _.now();
        results.diff = results.end - self._lastFetch;

        console.sstats('==>', 'Got getStats results in', chalk.reset.cyan(results.diff, 'ms'));

        if (results.peers !== null) {
          self.stats.active = true;
          self.stats.peers = results.peers;
          self.stats.mining = results.mining;
          self.stats.hashrate = results.hashrate;
          self.stats.gasPrice = results.gasPrice.toString(10);

          if (results.syncing !== false) {
            var sync = results.syncing;

            var progress = sync.currentBlock - sync.startingBlock;
            var total = sync.highestBlock - sync.startingBlock;

            sync.progress = progress / total;

            self.stats.syncing = sync;
          } else {
            self.stats.syncing = false;
          }
        }
        else {
          self.setInactive();
        }

        self.setUptime();

        self.sendStatsUpdate(forced);
      });
  }
}

EthStatus.prototype.setUptime = function () {
  this.stats.uptime = ((this._tries - this._down) / this._tries) * 100;
}

EthStatus.prototype.sendStatsUpdate = function (force) {
  if (this.changed() || force) {
    console.stats("wsc", "Sending", chalk.reset.blue((force ? "forced" : "changed")), chalk.bold.white("update"));
    var stats = this.prepareStats();
    console.info(stats);
    this.emit('stats', stats);
  }
}

EthStatus.prototype.changed = function () {
  var changed = !_.isEqual(this._lastStats, JSON.stringify(this.stats));
  return changed;
}


EthStatus.prototype.prepareStats = function () {
  return {
    id: this.id,
    stats: {
      active: this.stats.active,
      syncing: this.stats.syncing,
      mining: this.stats.mining,
      hashrate: this.stats.hashrate,
      peers: this.stats.peers,
      gasPrice: this.stats.gasPrice,
      uptime: this.stats.uptime
    }
  };
}

EthStatus.prototype.emit = function (message, payload) {
  //if(this._socket)
  //{
  try {
    //socket.emit(message, payload);  //TODO: make this an event emitter
    console.stats('wsc', 'Socket emited message:', chalk.reset.cyan(message));
    // console.success('wsc', payload);
  }
  catch (err) {
    console.error('wsc', 'Socket emit error:', err);
  }
  //}
}

EthStatus.prototype.currentStats = function () {
  return { "id": this.id, "info": this.info, "stats": this.stats };
}

EthStatus.prototype.coinbase = function () {
  try {
    return web3.eth.coinbase;
  } catch (error) {
    let message = "no coinbase set:  " + error;
    console.info(message);
    this.info.messages[0] = message;
    return "0x";
  }
}

module.exports = EthStatus;
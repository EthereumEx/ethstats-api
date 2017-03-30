'use strict';
const debug = require('debug')('ethstats:module');

require('./logger.js');

const chalk = require('chalk');
const os = require('os');
const _ = require('lodash');
const Web3 = require('web3');
let web3;

const INSTANCE_NAME = process.env.INSTANCE_NAME;

const MAX_CONNECTION_ATTEMPTS = 5;
const CONNECTION_ATTEMPTS_TIMEOUT = 1000; // ms

if(process.env.NODE_ENV === 'production' && INSTANCE_NAME === "")
{
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
    //client: pjson.version,
    canUpdateHistory: true,
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
  this.pingInterval = false;
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

EthStatus.prototype.startWeb3Connection = function() 
{
	console.info('Starting web3 connection');

	web3 = new Web3();
	web3.setProvider(new web3.providers.HttpProvider('http://' + (process.env.RPC_HOST || 'localhost') + ':' + (process.env.RPC_PORT || '8545')));

	this.checkWeb3Connection();
}

EthStatus.prototype.checkWeb3Connection = function()
{
	var self = this;

	if (!this._web3)
	{
		if(web3.isConnected()) {
			console.success('Web3 connection established');

			this._web3 = true;
			this.init();

			return true;
		}
		else
		{
			if(this._connection_attempts < MAX_CONNECTION_ATTEMPTS)
			{
				console.error
        ('Web3 connection attempt', chalk.cyan('#' + this._connection_attempts++), 'failed');
				console.error('Trying again in', chalk.cyan(500 * this._connection_attempts + ' ms'));

				setTimeout(function ()
				{
					self.checkWeb3Connection();
				}, CONNECTION_ATTEMPTS_TIMEOUT * this._connection_attempts);
			}
			else
			{
				console.error('Web3 connection failed', chalk.cyan(MAX_CONNECTION_ATTEMPTS), 'times. Aborting...');
        console.success('will try again in 1 second.');
        setTimeout(function(){
          self.checkWeb3Connection();
        }, 1000)
			}
		}
	}
}


module.exports = EthStatus;
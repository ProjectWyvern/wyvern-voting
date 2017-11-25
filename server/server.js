const express     = require('express');
const bodyParser  = require('body-parser');
const Sequelize   = require('sequelize');
const bunyan      = require('bunyan');
const fs          = require('fs');
const wyvrpc      = require('bitcoind-rpc');
const config      = JSON.parse(fs.readFileSync('config.json'));

const log         = bunyan.createLogger({name: 'voting', level: 'info'});
const rpcClient   = new wyvrpc({logger: log, protocol: 'http', user: config.user, pass: config.pass, host: config.host, port: config.port});

rpcClient.getInfo((err, ret) => {
  log.info({err: err, blockNumber: ret.result.blocks, host: config.host, port: config.port}, 'Configured Wyvern RPC');
});

const sequelize = new Sequelize('wyvern', null, null, {
  host: 'localhost',
  dialect: 'sqlite',
  storage: './db.sqlite',
  pool: {max: 10, min: 0, acquire: 30000, idle: 10000},
  operatorsAliases: false,
  logging: (msg) => log.debug({origin: 'sequelize'}, msg)
});

const Vote = sequelize.define('vote', {
  address: {type: Sequelize.STRING, allowNull: false, unique: true},
  inFavor: {type: Sequelize.BOOLEAN, allowNull: false},
  signature: {type: Sequelize.STRING, allowNull: false},
  satoshis: {type: Sequelize.INTEGER, allowNull: false}
});

const update = () => {
  Vote.findAll().then(votes => {
    votes.map(vote => {
      rpcClient.getAddressUtxos({addresses: [vote.address]}, (err, ret) => {
        var satoshis = 0;
        ret.result.map(utxo => {
          satoshis += utxo.satoshis;
        });
        Vote.update({satoshis: satoshis}, {where: {address: vote.address}});
      });
    });
  });
};

setInterval(update, 5000);

const app = express();
app.use(bodyParser.json());
app.use((req, res, next) => {
  log.debug({path: req.path, method: req.method, ip: req.headers['X-Forwarded-For']}, 'Request received');
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.get('/votes', (req, res) => {
  Vote.findAll().then(votes => {
    res.json(votes.map(vote => {
      return {
        address   : vote.address,
        inFavor   : vote.inFavor,
        signature : vote.signature,
        satoshis  : vote.satoshis
      };
    }));
  });
});

app.get('/summary', (req, res) => {
  Vote.sum('satoshis', {where: {inFavor: true}}).then(inFavor => {
    Vote.sum('satoshis', {where: {inFavor: false}}).then(against => {
      rpcClient.getInfo((err, ret) => {
        res.json({
          inFavor : inFavor > 0 ? inFavor : 0,
          against : against > 0 ? against : 0,
          supply  : ret.result.moneysupply * 1e8
        });
      });
    });
  });
});

app.post('/vote', (req, res) => {
  const { address, inFavor, signature } = req.body;
  if (typeof address === 'undefined' || typeof inFavor === 'undefined' || typeof signature === 'undefined') {
    res.json({success: false, error: 'Invalid JSON'});
    return;
  }
  rpcClient.verifyMessage(address, signature, '' + JSON.stringify(inFavor), (err, ret) => {
    if (err === null && ret.result === true) {
      Vote.create({address: address, inFavor: inFavor, signature: signature, satoshis: 0})
        .then(() => {
          res.json({success: true});
        })
        .catch(() => {
          res.json({success: false, error: 'This address has already voted!'});
        });
    } else {
      res.json({success: false, error: err ? err : 'Invalid signature'});
    }
  })
});

sequelize
  .sync()
  .then(() => {
    require('letsencrypt-express').create({
      server: 'https://acme-v01.api.letsencrypt.org/directory',
      email: 'protinam@protonmail.ch',
      agreeTos: true,
      approveDomains: ['votingapi.projectwyvern.com'],
      app: app
    }).listen(80, 443);
  }); 

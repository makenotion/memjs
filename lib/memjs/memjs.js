// # MemJS Memcache Client

var errors = require('./protocol').errors;
var Server = require('./server').Server;
var noopSerializer = require('./noop-serializer').noopSerializer;
var makeRequestBuffer = require('./utils').makeRequestBuffer;
var copyIntoRequestBuffer = require('./utils').copyIntoRequestBuffer;
var merge = require('./utils').merge;
var makeExpiration = require('./utils').makeExpiration;
var makeAmountInitialAndExpiration = require('./utils').makeAmountInitialAndExpiration;
var constants = require('./constants');
var hashCode = require('./utils').hashCode;

// Client initializer takes a list of `Server`s and an `options` dictionary.
// See `Client.create` for details.
var Client = function(servers, options) {
  this.servers = servers;
  this.seq = 0;

  this.options = merge(options || {},
    {
      failoverTime: 60,
      retries: 2,
      retry_delay: 0.2,
      expires: 0,
      logger: console,
      keyToServerHashFunction: this.defaultKeyToServerHashFunction.bind(this),
      failover: false,
    });

  this.serializer = this.options.serializer || noopSerializer;

  if (this.options.failover === true) {
    // add in the built-in failover function if failover === true
    this.options.failover = (serverKey) => {
      const server = this.serverMap[serverKey];
      if (server) {
        server.wakeupAt = Date.now() + this.options.failoverTime * 1000;
      }
    };
  }

  // Store a mapping from hostport -> server so we can quickly get a server object from the serverKey returned by the hashing function
  var serverMap = {};
  this.servers.forEach((server) => {
    serverMap[server.hostportString()] = server;
  });
  this.serverMap = serverMap;

  // store a list of all our serverKeys so we don't need to constantly reallocate this array
  this.serverKeys = Object.keys(this.serverMap);
};

// Creates a new client given an optional config string and optional hash of
// options. The config string should be of the form:
//
//     "[user:pass@]server1[:11211],[user:pass@]server2[:11211],..."
//
// If the argument is not given, fallback on the `MEMCACHIER_SERVERS` environment
// variable, `MEMCACHE_SERVERS` environment variable or `"localhost:11211"`.
//
// The options hash may contain the options:
//
// * `retries` - the number of times to retry an operation in lieu of failures
// (default 2)
// * `expires` - the default expiration in seconds to use (default 0 - never
// expire). If `expires` is greater than 30 days (60 x 60 x 24 x 30), it is
// treated as a UNIX time (number of seconds since January 1, 1970).
// * `logger` - a logger object that responds to `log(string)` method calls.
// * `failover` - whether to remove servers from the pool for a period on
// error after all retreies have been exhausted
// * `failoverTime` - how much to wait until retrying a failed server. Default
//                    is 60 seconds.
// *
//
//   ~~~~
//     log(msg1[, msg2[, msg3[...]]])
//   ~~~~
//
//   Defaults to `console`.
// * `serializer` - the object which will (de)serialize the data. It needs
//   two public methods: serialize and deserialize. It defaults to the
//   noopSerializer:
//
//   ~~~~
//   var noopSerializer = {
//     serialize: function (opcode, value, extras) {
//       return { value: value, extras: extras };
//     },
//     deserialize: function (opcode, value, extras) {
//       return { value: value, extras: extras };
//     }
//   };
//   ~~~~
//
// Or options for the servers including:
// * `username` and `password` for fallback SASL authentication credentials.
// * `timeout` in seconds to determine failure for operations. Default is 0.5
//             seconds.
// * 'conntimeout' in seconds to connection failure. Default is twice the value
//                 of `timeout`.
// * `keepAlive` whether to enable keep-alive functionality. Defaults to false.
// * `keepAliveDelay` in seconds to the initial delay before the first keepalive
//                    probe is sent on an idle socket. Defaults is 30 seconds.
// * `failover` - whether to failover to next server. Defaults to false.
//                if true, will use the default failover function
//                if this is a function, it will be called on failover
// * `failoverTime` - how much to wait until retring a failed server. Default
//                    is 60 seconds. Only applies if failover = true
// * `keyToServerHashFunction` a function to map keys to servers, with the signature
//                            (serverKeys: string[], key: string): string
//                            NOTE: if you need to do some expensive initialization,
//                            *please* do it lazily the first time you this function
//                            is called with an array of serverKeys, not on every call
Client.create = function(serversStr, options) {
  serversStr = serversStr || process.env.MEMCACHIER_SERVERS ||
                             process.env.MEMCACHE_SERVERS || 'localhost:11211';
  var serverUris = serversStr.split(',');
  var servers = serverUris.map((uri) => {
    var uriParts = uri.split('@');
    var hostPort = uriParts[uriParts.length - 1].split(':');
    var userPass = (uriParts[uriParts.length - 2] || '').split(':');
    return new Server(hostPort[0], parseInt(hostPort[1] || 11211, 10), userPass[0], userPass[1], options);
  });
  return new Client(servers, options);
};

/**
 * Given a serverKey fromlookupKeyToServerKey, return the corresponding Server instance
 *
 * @param  {string} serverKey
 * @returns {Server}
*/
Client.prototype.serverKeyToServer = function(serverKey) {
  if (!this.serverMap[serverKey]) {
    throw new Error(`serverKey ${serverKey} missing in serverMap, possible keys: ${Object.keys(this.serverMap)}`);
  }
  return this.serverMap[serverKey];
};

/**
 * Given a key to look up in memcache, return a serverKey (based on some
 * hashing function) which
can be used to index this.serverMap
 *
 * @param  {string} key
 * * @returns {string}
 */
Client.prototype.lookupKeyToServerKey = function(key) {
  return this.options.keyToServerHashFunction(this.serverKeys, key);
};

// converts a call into a promise-returning one
var promisify = function(command) {
  return new Promise((resolve, reject) => {
    command((err, result) => {
      err ? reject(err) : resolve(result);
    });
  });
};

// ## Memcache Commands
//
// All commands return their results through a callback passed as the last
// required argument (some commands, like `Client#set`, take optional arguments
// after the callback).
//
// The callback signature always follows:
//
//     callback(err, [arg1[, arg2[, arg3[...]]]])
//
// In case of an error the _err_ argument will be non-null and contain the
// `Error`. A notable exception includes a `Client#get` on a key that doesn't
// exist. In this case, _err_ will be null, as will the _value and _extras_
// arguments.

// GET
//
// Retrieves the value at the given key in memcache.
//
// The callback signature is:
//
//     callback(err, value, flags)
//
// _value_ and _flags_ are both `string`s. If the key is not found, the
// callback is invoked with null for both arguments and no error.
Client.prototype.get = function(key, callback) {
  if(callback === undefined) {
    return promisify((callback) => {
      this.get(key, (err, value, flags) => {
        callback(err, {value: value, flags: flags});
      });
    });
  }
  var logger = this.options.logger;
  this.incrSeq();
  var request = makeRequestBuffer(constants.OP_GET, key, '', '', this.seq);
  this.perform(key, request, this.seq, (err, response) => {
    if (err) {
      if (callback) { callback(err, null, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) {
        var deserialized = this.serializer.deserialize(response.header.opcode, response.val, response.extras);
        callback(null, deserialized.value, deserialized.extras);
      }
      break;
    case constants.RESPONSE_STATUS_KEY_NOT_FOUND:
      if (callback) { callback(null, null, null); }
      break;
    default:
      var errorMessage = 'MemJS GET: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  });
};

/** Build a pipelined get multi request by sending one GETKQ for each key (quiet, meaning it won't respond if the value is missing) followed by a no-op to force a response (and to give us a sentinel response that the pipeline is done)
 *
 * cf https://github.com/couchbase/memcached/blob/master/docs/BinaryProtocol.md#0x0d-getkq-get-with-key-quietly
 */
Client.prototype._buildGetMultiRequest = function(keys) {
  // start at 24 for the no-op command at the end
  var requestSize = 24;
  for (var keyIdx in keys) {
    requestSize += Buffer.byteLength(keys[keyIdx], 'utf8') + 24;
  }

  var request = Buffer.alloc(requestSize);
  request.fill();

  var bytesWritten = 0;
  for (keyIdx in keys) {
    var key = keys[keyIdx];
    bytesWritten += copyIntoRequestBuffer(constants.OP_GETKQ, key, '', '', this.seq, request, bytesWritten);
  }

  bytesWritten += copyIntoRequestBuffer(
    constants.OP_NO_OP, '', '', '', this.seq, request, bytesWritten);

  return request;
};

/** Executing a pipelined (multi) get against a single server. This is a private implementation detail of getMulti. */
Client.prototype._getMultiToServer = function (serv, keys, callback) {
  var responseMap = {};

  var handle = (response) => {
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) {
        var deserialized = this.serializer.deserialize(response.header.opcode, response.val, response.extras);
        // When we get the no-op response, we are done with this one getMulti in the per-backend fan-out
        if (response.header.opcode === constants.OP_NO_OP) {
          // This ensures the handler will be deleted from the responseCallbacks map in server.js
          // This isn't technically needed here because the logic in server.js also checks if totalBodyLength === 0, but our unittests aren't great about setting that field, and also this makes it more explicit
          handle.quiet = false;
          callback(null, responseMap);
        } else {
          var key = response.key.toString();
          responseMap[key] = deserialized.value;
        }
      }
      break;
    case constants.RESPONSE_STATUS_KEY_NOT_FOUND:
      if (callback) { callback(null, null, null); }
      break;
    default:
      var errorMessage = 'MemJS GET: ' + errors[response.header.status];
      this.options.logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  };
  // This prevents the handler from being deleted
  // after the first response. Logic in server.js.
  handle.quiet = true;

  var request = this._buildGetMultiRequest(keys);
  serv.onResponse(this.seq, handle);
  serv.onError(this.seq, (err) => {
    if (callback) { callback(err, serv.hostportString(), null); }
  });
  this.incrSeq();
  serv.write(request);
};

// MULTI-GET / GET-MULTI
//
// Retrieves the value at the given keys in memcache.
//
// The callback signature is:
//
//     callback(err, values, flags)
//
// _values_ is a map of { [key]: Buffer }
// _flags_ is a `string`.
Client.prototype.getMulti = function(keys, callback) {
  if(callback === undefined) {
    return promisify((callback) => {
      this.getMulti(keys, (err, values, flags) => {
        callback(err, {values: values, flags: flags});
      });
    });
  }


  var serverKeytoLookupKeys = {};
  keys.forEach((lookupKey) => {
    var serverKey = this.lookupKeyToServerKey(lookupKey);
    if (!serverKeytoLookupKeys[serverKey]) {
      serverKeytoLookupKeys[serverKey] = [];
    }
    serverKeytoLookupKeys[serverKey].push(lookupKey);
  });

  var usedServerKeys = Object.keys(serverKeytoLookupKeys);
  var outstandingCalls = usedServerKeys.length;
  var recordMap = {};
  var hadError = false;
  const latchCallback = (err, values, flags) => {
    if (hadError) {
      return;
    }

    if (err) {
      hadError = true;
      callback(err, null, null);
      return;
    }

    merge(recordMap, values);
    outstandingCalls -= 1;
    if (outstandingCalls === 0) {
      callback(null, recordMap, flags);
    }
  };

  for (var serverKeyIndex in usedServerKeys) {
    var serverKey = usedServerKeys[serverKeyIndex];
    var server = this.serverKeyToServer(serverKey);
    this._getMultiToServer(server, serverKeytoLookupKeys[serverKey], latchCallback);
  }
};

// SET
//
// Sets the given _key_ and _value_ in memcache.
//
// The options dictionary takes:
// * _expires_: overrides the default expiration (see `Client.create`) for this
//              particular key-value pair.
//
// The callback signature is:
//
//     callback(err, success)
Client.prototype.set = function(key, value, options, callback) {
  if(callback === undefined && typeof options !== 'function') {
    if (!options) options = {};
    return promisify((callback) => { this.set(key, value, options, (err, success) => { callback(err, success); }); });
  }
  var logger = this.options.logger;
  var expires;
  if (typeof options === 'function' || typeof callback === 'number') {
    // OLD: function(key, value, callback, expires)
    logger.log('MemJS SET: using deprecated call - arguments have changed');
    expires = callback;
    callback = options;
    options = {};
  }

  logger = this.options.logger;
  expires = options.expires;

  // TODO: support flags, support version (CAS)
  this.incrSeq();
  var expiration = makeExpiration(expires || this.options.expires);
  var extras = Buffer.concat([Buffer.from('00000000', 'hex'), expiration]);

  var opcode = 1;
  var serialized = this.serializer.serialize(opcode, value, extras);
  var request = makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
  this.perform(key, request, this.seq, (err, response) => {
    if (err) {
      if (callback) { callback(err, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) { callback(null, true); }
      break;
    default:
      var errorMessage = 'MemJS SET: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  });
};

// ADD
//
// Adds the given _key_ and _value_ to memcache. The operation only succeeds
// if the key is not already set.
//
// The options dictionary takes:
// * _expires_: overrides the default expiration (see `Client.create`) for this
//              particular key-value pair.
//
// The callback signature is:
//
//     callback(err, success)
Client.prototype.add = function(key, value, options, callback) {
  if(callback === undefined && options !== 'function') {
    if (!options) options = {};
    return promisify((callback) => { this.add(key, value, options, function(err, success) { callback(err, success); }); });
  }
  var logger = this.options.logger;
  var expires;
  if (typeof options === 'function') {
    // OLD: function(key, value, callback, expires)
    logger.log('MemJS ADD: using deprecated call - arguments have changed');
    expires = callback;
    callback = options;
    options = {};
  }

  logger = this.options.logger;
  expires = options.expires;

  // TODO: support flags, support version (CAS)
  this.incrSeq();
  var expiration = makeExpiration(expires || this.options.expires);
  var extras = Buffer.concat([Buffer.from('00000000', 'hex'), expiration]);

  var opcode = 2;
  var serialized = this.serializer.serialize(opcode, value, extras);
  var request = makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) { callback(null, true); }
      break;
    case constants.RESPONSE_STATUS_KEY_EXISTS:
      if (callback) { callback(null, false); }
      break;
    default:
      var errorMessage = 'MemJS ADD: ' + errors[response.header.status];
      logger.log(errorMessage, false);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  });
};

// REPLACE
//
// Replaces the given _key_ and _value_ to memcache. The operation only succeeds
// if the key is already present.
//
// The options dictionary takes:
// * _expires_: overrides the default expiration (see `Client.create`) for this
//              particular key-value pair.
//
// The callback signature is:
//
//     callback(err, success)
Client.prototype.replace = function(key, value, options, callback) {
  if(callback === undefined && options !== 'function') {
    if (!options) options = {};
    return promisify((callback) => { this.replace(key, value, options, function(err, success) { callback(err, success); }); });
  }
  var logger = this.options.logger;
  var expires;
  if (typeof options === 'function') {
    // OLD: function(key, value, callback, expires)
    logger.log('MemJS REPLACE: using deprecated call - arguments have changed');
    expires = callback;
    callback = options;
    options = {};
  }

  logger = this.options.logger;
  expires = options.expires;

  // TODO: support flags, support version (CAS)
  this.incrSeq();
  var expiration = makeExpiration(expires || this.options.expires);
  var extras = Buffer.concat([Buffer.from('00000000', 'hex'), expiration]);

  var opcode = 3;
  var serialized = this.serializer.serialize(opcode, value, extras);
  var request = makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) { callback(null, true); }
      break;
    case constants.RESPONSE_STATUS_KEY_NOT_FOUND:
      if (callback) { callback(null, false); }
      break;
    default:
      var errorMessage = 'MemJS REPLACE: ' + errors[response.header.status];
      logger.log(errorMessage, false);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  });
};

// DELETE
//
// Deletes the given _key_ from memcache. The operation only succeeds
// if the key is already present.
//
// The callback signature is:
//
//     callback(err, success)
Client.prototype.delete = function(key, callback) {
  if(callback === undefined) {
    return promisify((callback) => { this.delete(key, function(err, success) { callback(err, success); }); });
  }
  // TODO: Support version (CAS)
  var logger = this.options.logger;
  this.incrSeq();
  var request = makeRequestBuffer(4, key, '', '', this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) { callback(null, true); }
      break;
    case constants.RESPONSE_STATUS_KEY_NOT_FOUND:
      if (callback) { callback(null, false); }
      break;
    default:
      var errorMessage = 'MemJS DELETE: ' + errors[response.header.status];
      logger.log(errorMessage, false);
      if (callback) { callback(new Error(errorMessage), null); }
    }
  });
};

// INCREMENT
//
// Increments the given _key_ in memcache.
//
// The options dictionary takes:
// * _initial_: the value for the key if not already present, defaults to 0.
// * _expires_: overrides the default expiration (see `Client.create`) for this
//              particular key-value pair.
//
// The callback signature is:
//
//     callback(err, success, value)
Client.prototype.increment = function(key, amount, options, callback) {
  if(callback === undefined && options !== 'function') {
    return promisify((callback) => {
      if (!options) options = {};
      this.increment(key, amount, options, function(err, success, value) {
        callback(err, {success: success, value: value});
      });
    });
  }
  var logger = this.options.logger;
  var initial;
  var expires;
  if (typeof options === 'function') {
    // OLD: function(key, amount, callback, expires, initial)
    logger.log('MemJS INCREMENT: using deprecated call - arguments have changed');
    initial = arguments[4];
    expires = callback;
    callback = options;
    options = {};
  }

  logger = this.options.logger;
  initial = options.initial;
  expires = options.expires;

  // TODO: support version (CAS)
  this.incrSeq();
  initial = initial || 0;
  expires = expires || this.options.expires;
  var extras = makeAmountInitialAndExpiration(amount, initial, expires);
  var request = makeRequestBuffer(5, key, extras, '', this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      var bufInt = (response.val.readUInt32BE(0) << 8) + response.val.readUInt32BE(4);
      if (callback) { callback(null, true, bufInt); }
      break;
    default:
      var errorMessage = 'MemJS INCREMENT: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  });
};

// DECREMENT
//
// Decrements the given _key_ in memcache.
//
// The options dictionary takes:
// * _initial_: the value for the key if not already present, defaults to 0.
// * _expires_: overrides the default expiration (see `Client.create`) for this
//              particular key-value pair.
//
// The callback signature is:
//
//     callback(err, success, value)
Client.prototype.decrement = function(key, amount, options, callback) {
  if(callback === undefined && options !== 'function') {
    return promisify((callback) => {
      this.decrement(key, amount, options, function(err, success, value) {
        callback(err, {success: success, value: value});
      });
    });
  }
  // TODO: support version (CAS)
  var logger = this.options.logger;
  var initial;
  var expires;
  if (typeof options === 'function') {
    // OLD: function(key, amount, callback, expires, initial)
    logger.log('MemJS DECREMENT: using deprecated call - arguments have changed');
    initial = arguments[4];
    expires = callback;
    callback = options;
    options = {};
  }

  // TODO: support version (CAS)
  logger = this.options.logger;
  initial = options.initial;
  expires = options.expires;

  this.incrSeq();
  initial = initial || 0;
  expires = expires || this.options.expires;
  var extras = makeAmountInitialAndExpiration(amount, initial, expires);
  var request = makeRequestBuffer(6, key, extras, '', this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      var bufInt = (response.val.readUInt32BE(0) << 8) + response.val.readUInt32BE(4);
      if (callback) { callback(null, true, bufInt); }
      break;
    default:
      var errorMessage = 'MemJS DECREMENT: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  });
};

// APPEND
//
// Append the given _value_ to the value associated with the given _key_ in
// memcache. The operation only succeeds if the key is already present. The
// callback signature is:
//
//     callback(err, success)
Client.prototype.append = function(key, value, callback) {
  if(callback === undefined) {
    return promisify((callback) => { this.append(key, value, function(err, success) { callback(err, success); }); });
  }
  // TODO: support version (CAS)
  var logger = this.options.logger;
  this.incrSeq();
  var opcode = 0x0E;
  var serialized = this.serializer.serialize(opcode, value, '');
  var request = makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) { callback(null, true); }
      break;
    case constants.RESPONSE_STATUS_KEY_NOT_FOUND:
      if (callback) { callback(null, false); }
      break;
    default:
      var errorMessage = 'MemJS APPEND: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null); }
    }
  });
};

// PREPEND
//
// Prepend the given _value_ to the value associated with the given _key_ in
// memcache. The operation only succeeds if the key is already present. The
// callback signature is:
//
//     callback(err, success)
Client.prototype.prepend = function(key, value, callback) {
  if(callback === undefined) {
    return promisify((callback) => { this.prepend(key, value, function(err, success) { callback(err, success); }); });
  }
  // TODO: support version (CAS)
  var logger = this.options.logger;
  this.incrSeq();

  var opcode = 0x0E;
  var serialized = this.serializer.serialize(opcode, value, '');
  var request = makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) { callback(null, true); }
      break;
    case constants.RESPONSE_STATUS_KEY_NOT_FOUND:
      if (callback) { callback(null, false); }
      break;
    default:
      var errorMessage = 'MemJS PREPEND: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null); }
    }
  });
};

// TOUCH
//
// Touch sets an expiration value, given by _expires_, on the given _key_ in
// memcache. The operation only succeeds if the key is already present. The
// callback signature is:
//
//     callback(err, success)
Client.prototype.touch = function(key, expires, callback) {
  if(callback === undefined) {
    return promisify((callback) => { this.touch(key, expires, function(err, success) { callback(err, success); }); });
  }
  // TODO: support version (CAS)
  var logger = this.options.logger;
  this.incrSeq();
  var extras = makeExpiration(expires || this.options.expires);
  var request = makeRequestBuffer(0x1C, key, extras, '', this.seq);
  this.perform(key, request, this.seq, function(err, response) {
    if (err) {
      if (callback) { callback(err, null); }
      return;
    }
    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      if (callback) { callback(null, true); }
      break;
    case constants.RESPONSE_STATUS_KEY_NOT_FOUND:
      if (callback) { callback(null, false); }
      break;
    default:
      var errorMessage = 'MemJS TOUCH: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null); }
    }
  });
};

// FLUSH
//
// Flushes the cache on each connected server. The callback signature is:
//
//     callback(lastErr, results)
//
// where _lastErr_ is the last error encountered (or null, in the common case
// of no errors). _results_ is a dictionary mapping `"hostname:port"` to either
// `true` (if the operation was successful), or an error.
Client.prototype.flush = function(callback) {
  if(callback === undefined) {
    return promisify((callback) => { this.flush((err, results) => { callback(err, results); }); });
  }
  // TODO: support expiration
  this.incrSeq();
  var request = makeRequestBuffer(0x08, '', '', '', this.seq);
  var count   = this.servers.length;
  var result  = {};
  var lastErr = null;
  var i;

  var handleFlush = (seq, serv) => {
    serv.onResponse(seq, (/* response */) => {
      count -= 1;
      result[serv.hostportString()] = true;
      if (callback && count === 0) {
        callback(lastErr, result);
      }
    });
    serv.onError(seq, (err) => {
      count -= 1;
      lastErr = err;
      result[serv.hostportString()] = err;
      if (callback && count === 0) {
        callback(lastErr, result);
      }
    });
    serv.write(request);
  };

  for (i = 0; i < this.servers.length; i++) {
    handleFlush(this.seq, this.servers[i]);
  }
};

// STATS_WITH_KEY
//
// Sends a memcache stats command with a key to each connected server. The
// callback is invoked **ONCE PER SERVER** and has the signature:
//
//     callback(err, server, stats)
//
// _server_ is the `"hostname:port"` of the server, and _stats_ is a dictionary
// mapping the stat name to the value of the statistic as a string.
Client.prototype.statsWithKey = function(key, callback) {
  var logger = this.options.logger;
  this.incrSeq();
  var request = makeRequestBuffer(0x10, key, '', '', this.seq);
  var i;

  var handleStats = (seq, serv) => {
    var result = {};
    var handle = (response) => {
      // end of stat responses
      if (response.header.totalBodyLength === 0) {
        if (callback) { callback(null, serv.hostportString(), result); }
        return;
      }
      // process single stat line response
      switch (response.header.status) {
      case constants.RESPONSE_STATUS_SUCCCESS:
        result[response.key.toString()] = response.val.toString();
        break;
      default:
        var errorMessage = 'MemJS STATS (' + key + '): ' +
          errors[response.header.status];
        logger.log(errorMessage, false);
        if (callback) {
          callback(new Error(errorMessage), serv.hostportString(), null);
        }
      }
    };
    handle.quiet = true;

    serv.onResponse(seq, handle);
    serv.onError(seq, function(err) {
      if (callback) { callback(err, serv.hostportString(), null); }
    });
    serv.write(request);
  };

  for (i = 0; i < this.servers.length; i++) {
    handleStats(this.seq, this.servers[i]);
  }
};


// STATS
//
// Fetches memcache stats from each connected server. The callback is invoked
// **ONCE PER SERVER** and has the signature:
//
//     callback(err, server, stats)
//
// _server_ is the `"hostname:port"` of the server, and _stats_ is a
// dictionary mapping the stat name to the value of the statistic as a string.
Client.prototype.stats = function(callback) {
  this.statsWithKey('', callback);
};

// RESET_STATS
//
// Reset the statistics each server is keeping back to zero. This doesn't clear
// stats such as item count, but temporary stats such as total number of
// connections over time.
//
// The callback is invoked **ONCE PER SERVER** and has the signature:
//
//     callback(err, server)
//
// _server_ is the `"hostname:port"` of the server.
Client.prototype.resetStats = function(callback) {
  this.statsWithKey('reset', callback);
};

// QUIT
//
// Closes the connection to each server, notifying them of this intention. Note
// that quit can race against already outstanding requests when those requests
// fail and are retried, leading to the quit command winning and closing the
// connection before the retries complete.
Client.prototype.quit = function() {
  this.incrSeq();
  // TODO: Nicer perhaps to do QUITQ (0x17) but need a new callback for when
  // write is done.
  var request = makeRequestBuffer(0x07, '', '', '', this.seq); // QUIT
  var serv;
  var i;

  var handleQuit = (seq, serv) => {
    serv.onResponse(seq, function(/* response */) {
      serv.close();
    });
    serv.onError(seq, function(/* err */) {
      serv.close();
    });
    serv.write(request);
  };

  for (i = 0; i < this.servers.length; i++) {
    serv = this.servers[i];
    handleQuit(this.seq, serv);
  }
};

Client.prototype._version = function(server, callback) {
  var self = this;
  if(callback === undefined) {
    return promisify(function(callback) {
      self._version(server, function(err, value, flags) {
        callback(err, {value: value, flags: flags});
      });
    });
  }

  this.incrSeq();
  var request = makeRequestBuffer(constants.OP_VERSION, '', '', '', this.seq);
  var logger = this.options.logger;

  this.performOnServer(server, request, this.seq, function (err, response) {
    if (err) {
      if (callback) { callback(err, null, null); }
      return;
    }

    switch (response.header.status) {
    case constants.RESPONSE_STATUS_SUCCCESS:
      var deserialized = self.serializer.deserialize(response.header.opcode, response.val, response.extras);
      callback(null, deserialized.value, deserialized.extras);
      break;
    default:
      var errorMessage = 'MemJS VERSION: ' + errors[response.header.status];
      logger.log(errorMessage);
      if (callback) { callback(new Error(errorMessage), null, null); }
    }
  });
};

// VERSION
//
// Request the server version from the "first" server in the backend pool
//
// The server responds with a packet containing the version string in the body with the following format: "x.y.z"

Client.prototype.version = function(callback) {
  const server = this.serverKeyToServer(this.serverKeys[0]);

  return this._version(server, callback);
};

Client.prototype.versionAll = function(callback) {
  const promise = Promise.all(this.serverKeys.map((serverKey) => {
    const server = this.serverKeyToServer(serverKey);

    return this._version(server).then((response) => {
      return {serverKey: serverKey, value: response.value};
    });
  })).then(versionObjects => {
    const values = versionObjects.reduce((accumulator, versionObject) => {
      accumulator[versionObject.serverKey] = versionObject.value;
      return accumulator;
    }, {});
    return {values: values};
  });

  if(callback === undefined) {
    return promise;
  }
  return promise.then((response) =>{
    callback(null, response.values);
  }).catch((err) => {
    callback(err, null);
  });
};

// CLOSE
//
// Closes (abruptly) connections to all the servers.
Client.prototype.close = function() {
  var i;
  for (i = 0; i < this.servers.length; i++) {
    this.servers[i].close();
  }
};

/**
 * Perform a generic single response operation (get, set etc) on one server
 *
 * @param {string} key the key to hash to get a server from the pool
 * @param {buffer} request a buffer containing the request
 * @param {number} seq the sequence number of the operation. It is used to pin the callbacks
                       to a specific operation and should never change during a `perform`.
 * @param {*} callback a callback invoked when a response is received or the request fails
 * @param {*} retries number of times to retry request on failure
 */
Client.prototype.perform = function(key, request, seq, callback, retries) {
  const performCallback = () => {
    const serverKey = this.lookupKeyToServerKey(key);
    const server = this.serverKeyToServer(serverKey);

    if (!server) {
      if (callback) { callback(new Error('No servers available'), null); }
      return;
    }

    this.performOnServer(server, request, seq, callback, retries, /* afterFailover: */ performCallback);
  };

  performCallback();
};

/**
 *
 * @param {memjs.Server} server The specific server to send a request to
 * @param {Object} request The server request
 * @param {number} seq the sequence number
 * @param {(err, response) => void} callback the response callback
 * @param {number} retries number of times to retry
 * @param {(serverKey: string) => void | undefined} afterFailover optional callback, called after retries is exceeded due to server errors with the key of the failing server (so that a hashing function might remove it for a time). It is optional because
 */
Client.prototype.performOnServer = function(
  server, request, seq, callback, retries, afterFailover) {

  retries = retries || this.options.retries;

  const origRetries = this.options.retries;
  const logger = this.options.logger;
  const retry_delay = this.options.retry_delay;

  const responseHandler = (response) => {
    if (callback) { callback(null, response); }
  };

  const errorHandler = (error) => {
    if (--retries > 0) {
      // Wait for retry_delay
      setTimeout(() => {
        this.performOnServer(server, request, seq, callback, retries, afterFailover);
      }, 1000 * retry_delay);
    } else {
      logger.log('MemJS: Server <' + server.hostportString() +
                  '> failed after (' + origRetries +
                  ') retries with error - ' + error.message);
      const { failover } = this.options;
      if (failover && afterFailover) {
        // First call the hashing function's failover, which might remove this server from rotation
        failover();
        // Then call the afterFailover logic, which might retry this call on the newly failed over server
        afterFailover(server.hostportString());
      } else {
        if (callback) { callback(error, null); }
      }
    }
  };

  server.onResponse(seq, responseHandler);
  server.onError(seq, errorHandler);
  server.write(request);
};

// Increment the seq value
Client.prototype.incrSeq = function() {
  this.seq++;

  // Wrap `this.seq` to 32-bits since the field we fit it into is only 32-bits.
  this.seq &= 0xffffffff;
};

Client.prototype.defaultKeyToServerHashFunction = function(servers, lookupKey) {
  const total = servers.length;
  const originalServerKeyIndex = (total > 1) ? (hashCode(lookupKey) % total) : 0;

  const indexToServer = (index) => {
    return this.serverKeyToServer(servers[index]);
  };

  let serverKeyIndex = originalServerKeyIndex;
  let server = indexToServer(serverKeyIndex);

  // This function is cheating a little by keeping the server wakeup times directly on the server objects in the internals, rather than keeping its own separate state like a pluggable hashing function would have to do
  while (server.wakeupAt && server.wakeupAt > Date.now()) {
    serverKeyIndex = (originalServerKeyIndex + 1) % total;
    if (serverKeyIndex === originalServerKeyIndex) {
      return null;
    }
    server = indexToServer(serverKeyIndex);
  }

  return server.hostportString();
};

exports.Client = Client;
exports.Server = Server;
exports.Utils = require('./utils');
exports.Header = require('./header');

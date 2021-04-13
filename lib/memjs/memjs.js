"use strict";
// MemTS Memcache Client
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Header = exports.Utils = exports.Server = exports.Client = void 0;
const server_1 = require("./server");
Object.defineProperty(exports, "Server", { enumerable: true, get: function () { return server_1.Server; } });
const noop_serializer_1 = require("./noop-serializer");
const utils_1 = require("./utils");
const constants = __importStar(require("./constants"));
const constants_1 = require("./constants");
const Utils = __importStar(require("./utils"));
exports.Utils = Utils;
const Header = __importStar(require("./header"));
exports.Header = Header;
function defaultKeyToServerHashFunction(servers, key) {
    const total = servers.length;
    const index = total > 1 ? utils_1.hashCode(key) % total : 0;
    return servers[index];
}
// converts a call into a promise-returning one
function promisify(command) {
    return new Promise(function (resolve, reject) {
        command(function (err, result) {
            err ? reject(err) : resolve(result);
        });
    });
}
class Client {
    // Client initializer takes a list of `Server`s and an `options` dictionary.
    // See `Client.create` for details.
    constructor(servers, options) {
        this.servers = servers;
        this.seq = 0;
        this.options = utils_1.merge(options || {}, {
            retries: 2,
            retry_delay: 0.2,
            expires: 0,
            logger: console,
            keyToServerHashFunction: defaultKeyToServerHashFunction,
        });
        this.serializer = this.options.serializer || noop_serializer_1.noopSerializer;
        // Store a mapping from hostport -> server so we can quickly get a server object from the serverKey returned by the hashing function
        const serverMap = {};
        this.servers.forEach(function (server) {
            serverMap[server.hostportString()] = server;
        });
        this.serverMap = serverMap;
        // store a list of all our serverKeys so we don't need to constantly reallocate this array
        this.serverKeys = Object.keys(this.serverMap);
    }
    /**
     * Creates a new client given an optional config string and optional hash of
     * options. The config string should be of the form:
     *
     *     "[user:pass@]server1[:11211],[user:pass@]server2[:11211],..."
     *
     * If the argument is not given, fallback on the `MEMCACHIER_SERVERS` environment
     * variable, `MEMCACHE_SERVERS` environment variable or `"localhost:11211"`.
     *
     * The options hash may contain the options:
     *
     * * `retries` - the number of times to retry an operation in lieu of failures
     * (default 2)
     * * `expires` - the default expiration in seconds to use (default 0 - never
     * expire). If `expires` is greater than 30 days (60 x 60 x 24 x 30), it is
     * treated as a UNIX time (number of seconds since January 1, 1970).
     * * `logger` - a logger object that responds to `log(string)` method calls.
     *
     *   ~~~~
     *     log(msg1[, msg2[, msg3[...]]])
     *   ~~~~
     *
     *   Defaults to `console`.
     * * `serializer` - the object which will (de)serialize the data. It needs
     *   two public methods: serialize and deserialize. It defaults to the
     *   noopSerializer:
     *
     *   ~~~~
     *   const noopSerializer = {
     *     serialize: function (opcode, value, extras) {
     *       return { value: value, extras: extras };
     *     },
     *     deserialize: function (opcode, value, extras) {
     *       return { value: value, extras: extras };
     *     }
     *   };
     *   ~~~~
     *
     * Or options for the servers including:
     * * `username` and `password` for fallback SASL authentication credentials.
     * * `timeout` in seconds to determine failure for operations. Default is 0.5
     *             seconds.
     * * 'conntimeout' in seconds to connection failure. Default is twice the value
     *                 of `timeout`.
     * * `keepAlive` whether to enable keep-alive functionality. Defaults to false.
     * * `keepAliveDelay` in seconds to the initial delay before the first keepalive
     *                    probe is sent on an idle socket. Defaults is 30 seconds.
     * * `keyToServerHashFunction` a function to map keys to servers, with the signature
     *                            (serverKeys: string[], key: string): string
     *                            NOTE: if you need to do some expensive initialization, *please* do it lazily the first time you this function is called with an array of serverKeys, not on every call
     */
    static create(serversStr, options) {
        serversStr =
            serversStr ||
                process.env.MEMCACHIER_SERVERS ||
                process.env.MEMCACHE_SERVERS ||
                "localhost:11211";
        const serverUris = serversStr.split(",");
        const servers = serverUris.map(function (uri) {
            const uriParts = uri.split("@");
            const hostPort = uriParts[uriParts.length - 1].split(":");
            const userPass = (uriParts[uriParts.length - 2] || "").split(":");
            return new server_1.Server(hostPort[0], parseInt(hostPort[1] || "11211", 10), userPass[0], userPass[1], options);
        });
        return new Client(servers, options);
    }
    /**
     * Given a serverKey fromlookupKeyToServerKey, return the corresponding Server instance
     *
     * @param  {string} serverKey
     * @returns {Server}
     */
    serverKeyToServer(serverKey) {
        return this.serverMap[serverKey];
    }
    /**
     * Given a key to look up in memcache, return a serverKey (based on some
     * hashing function) which can be used to index this.serverMap
     */
    lookupKeyToServerKey(key) {
        return this.options.keyToServerHashFunction(this.serverKeys, key);
    }
    get(key, callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this.get(key, function (err, value) {
                    callback(err, value);
                });
            });
        }
        this.incrSeq();
        const request = utils_1.makeRequestBuffer(constants.OP_GET, key, "", "", this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            var _a;
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        const deserialized = this.serializer.deserialize(response.header.opcode, response.val, response.extras);
                        callback(null, { ...deserialized, cas: response.header.cas });
                    }
                    break;
                case constants_1.ResponseStatus.KEY_NOT_FOUND:
                    if (callback) {
                        callback(null, null);
                    }
                    break;
                default:
                    this.handleResponseError("GET", (_a = response === null || response === void 0 ? void 0 : response.header) === null || _a === void 0 ? void 0 : _a.status, callback);
            }
        });
    }
    /** Build a pipelined get multi request by sending one GETKQ for each key (quiet, meaning it won't respond if the value is missing) followed by a no-op to force a response (and to give us a sentinel response that the pipeline is done)
     *
     * cf https://github.com/couchbase/memcached/blob/master/docs/BinaryProtocol.md#0x0d-getkq-get-with-key-quietly
     */
    _buildGetMultiRequest(keys) {
        // start at 24 for the no-op command at the end
        let requestSize = 24;
        for (const keyIdx in keys) {
            requestSize += Buffer.byteLength(keys[keyIdx], "utf8") + 24;
        }
        const request = Buffer.alloc(requestSize);
        let bytesWritten = 0;
        for (const keyIdx in keys) {
            const key = keys[keyIdx];
            bytesWritten += utils_1.copyIntoRequestBuffer(constants.OP_GETKQ, key, "", "", this.seq, request, bytesWritten);
        }
        bytesWritten += utils_1.copyIntoRequestBuffer(constants.OP_NO_OP, "", "", "", this.seq, request, bytesWritten);
        return request;
    }
    /** Executing a pipelined (multi) get against a single server. This is a private implementation detail of getMulti. */
    _getMultiToServer(serv, keys, callback) {
        const responseMap = {};
        const handle = (response) => {
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        const deserialized = this.serializer.deserialize(response.header.opcode, response.val, response.extras);
                        // When we get the no-op response, we are done with this one getMulti in the per-backend fan-out
                        if (response.header.opcode === constants.OP_NO_OP) {
                            // This ensures the handler will be deleted from the responseCallbacks map in server.js
                            // This isn't technically needed here because the logic in server.js also checks if totalBodyLength === 0, but our unittests aren't great about setting that field, and also this makes it more explicit
                            handle.quiet = false;
                            callback(null, responseMap);
                        }
                        else {
                            const key = response.key.toString();
                            responseMap[key] = { ...deserialized, cas: response.header.cas };
                        }
                    }
                    break;
                default:
                    this.handleResponseError("GET", response.header.status, callback);
            }
        };
        // This prevents the handler from being deleted
        // after the first response. Logic in server.js.
        handle.quiet = true;
        const request = this._buildGetMultiRequest(keys);
        serv.onResponse(this.seq, handle);
        serv.onError(this.seq, function (err) {
            if (callback) {
                callback(err, null);
            }
        });
        this.incrSeq();
        serv.write(request);
    }
    getMulti(keys, callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this.getMulti(keys, function (err, value) {
                    callback(err, value);
                });
            });
        }
        const serverKeytoLookupKeys = {};
        keys.forEach((lookupKey) => {
            const serverKey = this.lookupKeyToServerKey(lookupKey);
            if (!serverKeytoLookupKeys[serverKey]) {
                serverKeytoLookupKeys[serverKey] = [];
            }
            serverKeytoLookupKeys[serverKey].push(lookupKey);
        });
        const usedServerKeys = Object.keys(serverKeytoLookupKeys);
        let outstandingCalls = usedServerKeys.length;
        const recordMap = {};
        let hadError = false;
        function latchCallback(err, values) {
            if (hadError) {
                return;
            }
            if (err) {
                hadError = true;
                callback(err, null);
                return;
            }
            utils_1.merge(recordMap, values);
            outstandingCalls -= 1;
            if (outstandingCalls === 0) {
                callback(null, recordMap);
            }
        }
        for (const serverKeyIndex in usedServerKeys) {
            const serverKey = usedServerKeys[serverKeyIndex];
            const server = this.serverKeyToServer(serverKey);
            this._getMultiToServer(server, serverKeytoLookupKeys[serverKey], latchCallback);
        }
    }
    set(key, value, options, callback) {
        if (callback === undefined && typeof options !== "function") {
            if (!options)
                options = {};
            return promisify((callback) => {
                this.set(key, value, options, function (err, success) {
                    callback(err, success);
                });
            });
        }
        const expires = options.expires;
        // TODO: support flags
        this.incrSeq();
        const expiration = utils_1.makeExpiration(expires || this.options.expires);
        const extras = Buffer.concat([Buffer.from("00000000", "hex"), expiration]);
        const opcode = 1;
        const serialized = this.serializer.serialize(opcode, value, extras);
        const request = Utils.encodeRequest({
            header: {
                opcode: constants.OP_SET,
                opaque: this.seq,
                cas: options.cas,
            },
            key,
            value: serialized.value,
            extras: serialized.extras,
        });
        this.perform(key, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        callback(null, true);
                    }
                    break;
                case constants_1.ResponseStatus.KEY_EXISTS:
                    if (options.cas) {
                        if (callback) {
                            callback(null, false);
                        }
                        break;
                    }
                default:
                    this.handleResponseError("SET", response.header.status, callback);
            }
        });
    }
    add(key, value, options, callback) {
        if (callback === undefined && options !== "function") {
            if (!options)
                options = {};
            return promisify((callback) => {
                this.add(key, value, options, function (err, success) {
                    callback(err, success);
                });
            });
        }
        // TODO: support flags, support version (CAS)
        this.incrSeq();
        const expiration = utils_1.makeExpiration((options || {}).expires || this.options.expires);
        const extras = Buffer.concat([Buffer.from("00000000", "hex"), expiration]);
        const opcode = 2;
        const serialized = this.serializer.serialize(opcode, value, extras);
        const request = utils_1.makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            var _a;
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        callback(null, true);
                    }
                    break;
                case constants_1.ResponseStatus.KEY_EXISTS:
                    if (callback) {
                        callback(null, false);
                    }
                    break;
                default:
                    return this.handleResponseError("ADD", (_a = response === null || response === void 0 ? void 0 : response.header) === null || _a === void 0 ? void 0 : _a.status, callback);
            }
        });
    }
    /**
     * REPLACE
     *
     * Replaces the given _key_ and _value_ to memcache. The operation only succeeds
     * if the key is already present.
     *
     * The options dictionary takes:
     * * _expires_: overrides the default expiration (see `Client.create`) for this
     *              particular key-value pair.
     *
     * The callback signature is:
     *
     *     callback(err, success)
     * @param key
     * @param value
     * @param options
     * @param callback
     */
    replace(key, value, options, callback) {
        if (callback === undefined && options !== "function") {
            if (!options)
                options = {};
            return promisify((callback) => {
                this.replace(key, value, options, function (err, success) {
                    callback(err, success);
                });
            });
        }
        // TODO: support flags, support version (CAS)
        this.incrSeq();
        const expiration = utils_1.makeExpiration((options || {}).expires || this.options.expires);
        const extras = Buffer.concat([Buffer.from("00000000", "hex"), expiration]);
        const opcode = 3;
        const serialized = this.serializer.serialize(opcode, value, extras);
        const request = utils_1.makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            var _a;
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        callback(null, true);
                    }
                    break;
                case constants_1.ResponseStatus.KEY_NOT_FOUND:
                    if (callback) {
                        callback(null, false);
                    }
                    break;
                default:
                    this.handleResponseError("REPLACE", (_a = response === null || response === void 0 ? void 0 : response.header) === null || _a === void 0 ? void 0 : _a.status, callback);
            }
        });
    }
    delete(key, callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this.delete(key, function (err, success) {
                    callback(err, Boolean(success));
                });
            });
        }
        // TODO: Support version (CAS)
        this.incrSeq();
        const request = utils_1.makeRequestBuffer(4, key, "", "", this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        callback(null, true);
                    }
                    break;
                case constants_1.ResponseStatus.KEY_NOT_FOUND:
                    if (callback) {
                        callback(null, false);
                    }
                    break;
                default:
                    this.handleResponseError("DELETE", response === null || response === void 0 ? void 0 : response.header.status, callback);
            }
        });
    }
    increment(key, amount, options, callback) {
        if (callback === undefined && options !== "function") {
            return promisify((callback) => {
                if (!options)
                    options = {};
                this.increment(key, amount, options, function (err, success, value) {
                    callback(err, { success: success, value: value || null });
                });
            });
        }
        // TODO: support version (CAS)
        this.incrSeq();
        const initial = options.initial || 0;
        const expires = options.expires || this.options.expires;
        const extras = utils_1.makeAmountInitialAndExpiration(amount, initial, expires);
        const request = utils_1.makeRequestBuffer(constants.OP_INCREMENT, key, extras, "", this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    const bufInt = (response.val.readUInt32BE(0) << 8) +
                        response.val.readUInt32BE(4);
                    if (callback) {
                        callback(null, true, bufInt);
                    }
                    break;
                default:
                    const error = this.handleResponseError("INCREMENT", response.header.status, undefined);
                    if (callback) {
                        callback(error, null, null);
                    }
            }
        });
    }
    decrement(key, amount, options, callback) {
        if (callback === undefined && options !== "function") {
            return promisify((callback) => {
                this.decrement(key, amount, options, function (err, success, value) {
                    callback(err, { success: success, value: value || null });
                });
            });
        }
        // TODO: support version (CAS)
        this.incrSeq();
        const initial = options.initial || 0;
        const expires = options.expires || this.options.expires;
        const extras = utils_1.makeAmountInitialAndExpiration(amount, initial, expires);
        const request = utils_1.makeRequestBuffer(constants.OP_DECREMENT, key, extras, "", this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    const bufInt = (response.val.readUInt32BE(0) << 8) +
                        response.val.readUInt32BE(4);
                    if (callback) {
                        callback(null, true, bufInt);
                    }
                    break;
                default:
                    const error = this.handleResponseError("DECREMENT", response.header.status, undefined);
                    if (callback) {
                        callback(error, null, null);
                    }
            }
        });
    }
    append(key, value, callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this.append(key, value, function (err, success) {
                    callback(err, success);
                });
            });
        }
        // TODO: support version (CAS)
        this.incrSeq();
        const opcode = constants.OP_APPEND;
        const serialized = this.serializer.serialize(opcode, value, "");
        const request = utils_1.makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        callback(null, true);
                    }
                    break;
                case constants_1.ResponseStatus.KEY_NOT_FOUND:
                    if (callback) {
                        callback(null, false);
                    }
                    break;
                default:
                    this.handleResponseError("APPEND", response.header.status, callback);
            }
        });
    }
    prepend(key, value, callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this.prepend(key, value, function (err, success) {
                    callback(err, success);
                });
            });
        }
        // TODO: support version (CAS)
        this.incrSeq();
        const opcode = constants.OP_PREPEND;
        const serialized = this.serializer.serialize(opcode, value, "");
        const request = utils_1.makeRequestBuffer(opcode, key, serialized.extras, serialized.value, this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        callback(null, true);
                    }
                    break;
                case constants_1.ResponseStatus.KEY_NOT_FOUND:
                    if (callback) {
                        callback(null, false);
                    }
                    break;
                default:
                    this.handleResponseError("PREPEND", response.header.status, callback);
            }
        });
    }
    touch(key, expires, callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this.touch(key, expires, function (err, success) {
                    callback(err, Boolean(success));
                });
            });
        }
        // TODO: support version (CAS)
        this.incrSeq();
        const extras = utils_1.makeExpiration(expires || this.options.expires);
        const request = utils_1.makeRequestBuffer(0x1c, key, extras, "", this.seq);
        this.perform(key, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    if (callback) {
                        callback(null, true);
                    }
                    break;
                case constants_1.ResponseStatus.KEY_NOT_FOUND:
                    if (callback) {
                        callback(null, false);
                    }
                    break;
                default:
                    this.handleResponseError("TOUCH", response.header.status, callback);
            }
        });
    }
    flush(callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this.flush(function (err, results) {
                    callback(err, results);
                });
            });
        }
        // TODO: support expiration
        this.incrSeq();
        const request = utils_1.makeRequestBuffer(0x08, "", "", "", this.seq);
        let count = this.servers.length;
        const result = {};
        let lastErr = null;
        const handleFlush = function (seq, serv) {
            serv.onResponse(seq, function ( /* response */) {
                count -= 1;
                result[serv.hostportString()] = true;
                if (callback && count === 0) {
                    callback(lastErr, result);
                }
            });
            serv.onError(seq, function (err) {
                count -= 1;
                lastErr = err;
                result[serv.hostportString()] = err;
                if (callback && count === 0) {
                    callback(lastErr, result);
                }
            });
            serv.write(request);
        };
        for (let i = 0; i < this.servers.length; i++) {
            handleFlush(this.seq, this.servers[i]);
        }
    }
    /**
     * STATS_WITH_KEY
     *
     * Sends a memcache stats command with a key to each connected server. The
     * callback is invoked **ONCE PER SERVER** and has the signature:
     *
     *     callback(err, server, stats)
     *
     * _server_ is the `"hostname:port"` of the server, and _stats_ is a dictionary
     * mapping the stat name to the value of the statistic as a string.
     * @param key
     * @param callback
     */
    statsWithKey(key, callback) {
        this.incrSeq();
        const request = utils_1.makeRequestBuffer(0x10, key, "", "", this.seq);
        const handleStats = (seq, serv) => {
            const result = {};
            const handle = (response) => {
                // end of stat responses
                if (response.header.totalBodyLength === 0) {
                    if (callback) {
                        callback(null, serv.hostportString(), result);
                    }
                    return;
                }
                // process single stat line response
                switch (response.header.status) {
                    case constants_1.ResponseStatus.SUCCESS:
                        result[response.key.toString()] = response.val.toString();
                        break;
                    default:
                        const error = this.handleResponseError(`STATS (${key})`, response.header.status, undefined);
                        if (callback) {
                            callback(error, serv.hostportString(), null);
                        }
                }
            };
            handle.quiet = true;
            serv.onResponse(seq, handle);
            serv.onError(seq, function (err) {
                if (callback) {
                    callback(err, serv.hostportString(), null);
                }
            });
            serv.write(request);
        };
        for (let i = 0; i < this.servers.length; i++) {
            handleStats(this.seq, this.servers[i]);
        }
    }
    /**
     * STATS
     *
     * Fetches memcache stats from each connected server. The callback is invoked
     * **ONCE PER SERVER** and has the signature:
     *
     *     callback(err, server, stats)
     *
     * _server_ is the `"hostname:port"` of the server, and _stats_ is a
     * dictionary mapping the stat name to the value of the statistic as a string.
     * @param callback
     */
    stats(callback) {
        this.statsWithKey("", callback);
    }
    /**
     * RESET_STATS
     *
     * Reset the statistics each server is keeping back to zero. This doesn't clear
     * stats such as item count, but temporary stats such as total number of
     * connections over time.
     *
     * The callback is invoked **ONCE PER SERVER** and has the signature:
     *
     *     callback(err, server)
     *
     * _server_ is the `"hostname:port"` of the server.
     * @param callback
     */
    resetStats(callback) {
        this.statsWithKey("reset", callback);
    }
    /**
     * QUIT
     *
     * Closes the connection to each server, notifying them of this intention. Note
     * that quit can race against already outstanding requests when those requests
     * fail and are retried, leading to the quit command winning and closing the
     * connection before the retries complete.
     */
    quit() {
        this.incrSeq();
        // TODO: Nicer perhaps to do QUITQ (0x17) but need a new callback for when
        // write is done.
        const request = utils_1.makeRequestBuffer(0x07, "", "", "", this.seq); // QUIT
        let serv;
        const handleQuit = function (seq, serv) {
            serv.onResponse(seq, function ( /* response */) {
                serv.close();
            });
            serv.onError(seq, function ( /* err */) {
                serv.close();
            });
            serv.write(request);
        };
        for (let i = 0; i < this.servers.length; i++) {
            serv = this.servers[i];
            handleQuit(this.seq, serv);
        }
    }
    _version(server, callback) {
        if (callback === undefined) {
            return promisify((callback) => {
                this._version(server, function (err, value) {
                    callback(err, { value: value });
                });
            });
        }
        this.incrSeq();
        const request = utils_1.makeRequestBuffer(constants.OP_VERSION, "", "", "", this.seq);
        this.performOnServer(server, request, this.seq, (err, response) => {
            if (err) {
                if (callback) {
                    callback(err, null);
                }
                return;
            }
            switch (response.header.status) {
                case constants_1.ResponseStatus.SUCCESS:
                    /* TODO: this is bugged, we should't use the deserializer here, since version always returns a version string.
                       The deserializer should only be used on user key data. */
                    const deserialized = this.serializer.deserialize(response.header.opcode, response.val, response.extras);
                    callback(null, deserialized.value);
                    break;
                default:
                    this.handleResponseError("VERSION", response.header.status, callback);
            }
        });
    }
    version(callback) {
        const server = this.serverKeyToServer(this.serverKeys[0]);
        if (callback) {
            this._version(server, callback);
        }
        else {
            return this._version(server);
        }
    }
    versionAll(callback) {
        const promise = Promise.all(this.serverKeys.map((serverKey) => {
            const server = this.serverKeyToServer(serverKey);
            return this._version(server).then((response) => {
                return { serverKey: serverKey, value: response.value };
            });
        })).then((versionObjects) => {
            const values = versionObjects.reduce((accumulator, versionObject) => {
                accumulator[versionObject.serverKey] = versionObject.value;
                return accumulator;
            }, {});
            return { values: values };
        });
        if (callback === undefined) {
            return promise;
        }
        promise
            .then((response) => {
            callback(null, response.values);
        })
            .catch((err) => {
            callback(err, null);
        });
    }
    /**
     * CLOSE
     *
     * Closes (abruptly) connections to all the servers.
     */
    close() {
        for (let i = 0; i < this.servers.length; i++) {
            this.servers[i].close();
        }
    }
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
    perform(key, request, seq, callback, retries) {
        const serverKey = this.lookupKeyToServerKey(key);
        const server = this.serverKeyToServer(serverKey);
        if (!server) {
            if (callback) {
                callback(new Error("No servers available"), null);
            }
            return;
        }
        return this.performOnServer(server, request, seq, callback, retries);
    }
    performOnServer(server, request, seq, callback, retries = 0) {
        const _this = this;
        retries = retries || this.options.retries;
        const origRetries = this.options.retries;
        const logger = this.options.logger;
        const retry_delay = this.options.retry_delay;
        const responseHandler = function (response) {
            if (callback) {
                callback(null, response);
            }
        };
        const errorHandler = function (error) {
            if (--retries > 0) {
                // Wait for retry_delay
                setTimeout(function () {
                    _this.performOnServer(server, request, seq, callback, retries);
                }, 1000 * retry_delay);
            }
            else {
                logger.log("MemJS: Server <" +
                    server.hostportString() +
                    "> failed after (" +
                    origRetries +
                    ") retries with error - " +
                    error.message);
                if (callback) {
                    callback(error, null);
                }
            }
        };
        server.onResponse(seq, responseHandler);
        server.onError(seq, errorHandler);
        server.write(request);
    }
    // Increment the seq value
    incrSeq() {
        this.seq++;
        // Wrap `this.seq` to 32-bits since the field we fit it into is only 32-bits.
        this.seq &= 0xffffffff;
    }
    /**
     * Log an error to the logger, then return the error.
     * If a callback is given, call it with callback(error, null).
     */
    handleResponseError(commandName, responseStatus, callback) {
        const errorMessage = `MemJS ${commandName}: ${constants.responseStatusToString(responseStatus)}`;
        this.options.logger.log(errorMessage);
        const error = new Error(errorMessage);
        if (callback) {
            callback(error, null);
        }
        return error;
    }
}
exports.Client = Client;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVtanMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvbWVtanMvbWVtanMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLHdCQUF3Qjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUV4QixxQ0FLa0I7QUE2akRELHVGQS9qRGYsZUFBTSxPQStqRGU7QUE1akR2Qix1REFBK0Q7QUFDL0QsbUNBU2lCO0FBQ2pCLHVEQUF5QztBQUN6QywyQ0FBNkM7QUFDN0MsK0NBQWlDO0FBK2lEUixzQkFBSztBQTlpRDlCLGlEQUFtQztBQThpREgsd0JBQU07QUE1aUR0QyxTQUFTLDhCQUE4QixDQUNyQyxPQUFpQixFQUNqQixHQUFXO0lBRVgsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQztJQUM3QixNQUFNLEtBQUssR0FBRyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxnQkFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3BELE9BQU8sT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3hCLENBQUM7QUFFRCwrQ0FBK0M7QUFDL0MsU0FBUyxTQUFTLENBQ2hCLE9BQTBFO0lBRTFFLE9BQU8sSUFBSSxPQUFPLENBQUMsVUFBVSxPQUFPLEVBQUUsTUFBTTtRQUMxQyxPQUFPLENBQUMsVUFBVSxHQUFHLEVBQUUsTUFBTTtZQUMzQixHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3RDLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBNkRELE1BQU0sTUFBTTtJQVFWLDRFQUE0RTtJQUM1RSxtQ0FBbUM7SUFDbkMsWUFBWSxPQUFpQixFQUFFLE9BQTBDO1FBQ3ZFLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElB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QUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3hCLENBQUM7SUFFRCwwQkFBMEI7SUFDMUIsT0FBTztRQUNMLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUVYLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsR0FBRyxJQUFJLFVBQVUsQ0FBQztJQUN6QixDQUFDO0lBRUQ7OztPQUdHO0lBQ0ssbUJBQW1CLENBQ3pCLFdBQW1CLEVBQ25CLGNBQTBDLEVBQzFDLFFBQWtFO1FBRWxFLE1BQU0sWUFBWSxHQUFHLFNBQVMsV0FBVyxLQUFLLFNBQVMsQ0FBQyxzQkFBc0IsQ0FDNUUsY0FBYyxDQUNmLEVBQUUsQ0FBQztRQUNKLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUN0QyxNQUFNLEtBQUssR0FBRyxJQUFJLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUN0QyxJQUFJLFFBQVEsRUFBRTtZQUNaLFFBQVEsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLENBQUM7U0FDdkI7UUFDRCxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7Q0FDRjtBQUVRLHdCQUFNIiwic291cmNlc0NvbnRlbnQiOlsiLy8gTWVtVFMgTWVtY2FjaGUgQ2xpZW50XG5cbmltcG9ydCB7XG4gIE9uRXJyb3JDYWxsYmFjayxcbiAgT25SZXNwb25zZUNhbGxiYWNrLFxuICBTZXJ2ZXIsXG4gIFNlcnZlck9wdGlvbnMsXG59IGZyb20gXCIuL3NlcnZlclwiO1xuaW1wb3J0IHsgbm9vcFNlcmlhbGl6ZXIsIFNlcmlhbGl6ZXIgfSBmcm9tIFwiLi9ub29wLXNlcmlhbGl6ZXJcIjtcbmltcG9ydCB7XG4gIG1ha2VSZXF1ZXN0QnVmZmVyLFxuICBjb3B5SW50b1JlcXVlc3RCdWZmZXIsXG4gIG1lcmdlLFxuICBtYWtlRXhwaXJhdGlvbixcbiAgbWFrZUFtb3VudEluaXRpYWxBbmRFeHBpcmF0aW9uLFxuICBoYXNoQ29kZSxcbiAgTWF5YmVCdWZmZXIsXG4gIE1lc3NhZ2UsXG59IGZyb20gXCIuL3V0aWxzXCI7XG5pbXBvcnQgKiBhcyBjb25zdGFudHMgZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBSZXNwb25zZVN0YXR1cyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0ICogYXMgVXRpbHMgZnJvbSBcIi4vdXRpbHNcIjtcbmltcG9ydCAqIGFzIEhlYWRlciBmcm9tIFwiLi9oZWFkZXJcIjtcblxuZnVuY3Rpb24gZGVmYXVsdEtleVRvU2VydmVySGFzaEZ1bmN0aW9uKFxuICBzZXJ2ZXJzOiBzdHJpbmdbXSxcbiAga2V5OiBzdHJpbmdcbik6IHN0cmluZyB7XG4gIGNvbnN0IHRvdGFsID0gc2VydmVycy5sZW5ndGg7XG4gIGNvbnN0IGluZGV4ID0gdG90YWwgPiAxID8gaGFzaENvZGUoa2V5KSAlIHRvdGFsIDogMDtcbiAgcmV0dXJuIHNlcnZlcnNbaW5kZXhdO1xufVxuXG4vLyBjb252ZXJ0cyBhIGNhbGwgaW50byBhIHByb21pc2UtcmV0dXJuaW5nIG9uZVxuZnVuY3Rpb24gcHJvbWlzaWZ5PFJlc3VsdD4oXG4gIGNvbW1hbmQ6IChjYWxsYmFjazogKGVycm9yOiBFcnJvciB8IG51bGwsIHJlc3VsdDogUmVzdWx0KSA9PiB2b2lkKSA9PiB2b2lkXG4pOiBQcm9taXNlPFJlc3VsdD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIGNvbW1hbmQoZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgICBlcnIgPyByZWplY3QoZXJyKSA6IHJlc29sdmUocmVzdWx0KTtcbiAgICB9KTtcbiAgfSk7XG59XG5cbnR5cGUgUmVzcG9uc2VPckVycm9yQ2FsbGJhY2sgPSAoXG4gIGVycm9yOiBFcnJvciB8IG51bGwsXG4gIHJlc3BvbnNlOiBNZXNzYWdlIHwgbnVsbFxuKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgQmFzZUNsaWVudE9wdGlvbnMge1xuICByZXRyaWVzOiBudW1iZXI7XG4gIHJldHJ5X2RlbGF5OiBudW1iZXI7XG4gIGV4cGlyZXM6IG51bWJlcjtcbiAgbG9nZ2VyOiB7IGxvZzogdHlwZW9mIGNvbnNvbGUubG9nIH07XG4gIGtleVRvU2VydmVySGFzaEZ1bmN0aW9uOiB0eXBlb2YgZGVmYXVsdEtleVRvU2VydmVySGFzaEZ1bmN0aW9uO1xufVxuXG5pbnRlcmZhY2UgU2VyaWFsaXplclByb3A8VmFsdWUsIEV4dHJhcz4ge1xuICBzZXJpYWxpemVyOiBTZXJpYWxpemVyPFZhbHVlLCBFeHRyYXM+O1xufVxuXG4vKipcbiAqIFRoZSBjbGllbnQgaGFzIHBhcnRpYWwgc3VwcG9ydCBmb3Igc2VyaWFsaXppbmcgYW5kIGRlc2VyaWFsaXppbmcgdmFsdWVzIGZyb20gdGhlXG4gKiBCdWZmZXIgYnl0ZSBzdHJpbmdzIHdlIHJlY2lldmUgZnJvbSB0aGUgd2lyZS4gVGhlIGRlZmF1bHQgc2VyaWFsaXplciBpcyBmb3IgTWF5YmVCdWZmZXIuXG4gKlxuICogSWYgVmFsdWUgYW5kIEV4dHJhcyBhcmUgb2YgdHlwZSBCdWZmZXIsIHRoZW4gcmV0dXJuIHR5cGUgV2hlbkJ1ZmZlci4gT3RoZXJ3aXNlLFxuICogcmV0dXJuIHR5cGUgTm90QnVmZmVyLlxuICovXG50eXBlIElmQnVmZmVyPFxuICBWYWx1ZSxcbiAgRXh0cmFzLFxuICBXaGVuVmFsdWVBbmRFeHRyYXNBcmVCdWZmZXJzLFxuICBOb3RCdWZmZXJcbj4gPSBWYWx1ZSBleHRlbmRzIEJ1ZmZlclxuICA/IEV4dHJhcyBleHRlbmRzIEJ1ZmZlclxuICAgID8gV2hlblZhbHVlQW5kRXh0cmFzQXJlQnVmZmVyc1xuICAgIDogTm90QnVmZmVyXG4gIDogTm90QnVmZmVyO1xuXG5leHBvcnQgdHlwZSBHaXZlbkNsaWVudE9wdGlvbnM8VmFsdWUsIEV4dHJhcz4gPSBQYXJ0aWFsPEJhc2VDbGllbnRPcHRpb25zPiAmXG4gIElmQnVmZmVyPFxuICAgIFZhbHVlLFxuICAgIEV4dHJhcyxcbiAgICBQYXJ0aWFsPFNlcmlhbGl6ZXJQcm9wPFZhbHVlLCBFeHRyYXM+PixcbiAgICBTZXJpYWxpemVyUHJvcDxWYWx1ZSwgRXh0cmFzPlxuICA+O1xuXG5leHBvcnQgdHlwZSBDQVNUb2tlbiA9IEJ1ZmZlcjtcblxuZXhwb3J0IGludGVyZmFjZSBHZXRSZXN1bHQ8VmFsdWUgPSBNYXliZUJ1ZmZlciwgRXh0cmFzID0gTWF5YmVCdWZmZXI+IHtcbiAgdmFsdWU6IFZhbHVlO1xuICBleHRyYXM6IEV4dHJhcztcbiAgY2FzOiBDQVNUb2tlbiB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IHR5cGUgR2V0TXVsdGlSZXN1bHQ8XG4gIEtleXMgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmcsXG4gIFZhbHVlID0gTWF5YmVCdWZmZXIsXG4gIEV4dHJhcyA9IE1heWJlQnVmZmVyXG4+ID0ge1xuICBbSyBpbiBLZXlzXT86IEdldFJlc3VsdDxWYWx1ZSwgRXh0cmFzPjtcbn07XG5cbmNsYXNzIENsaWVudDxWYWx1ZSA9IE1heWJlQnVmZmVyLCBFeHRyYXMgPSBNYXliZUJ1ZmZlcj4ge1xuICBzZXJ2ZXJzOiBTZXJ2ZXJbXTtcbiAgc2VxOiBudW1iZXI7XG4gIG9wdGlvbnM6IEJhc2VDbGllbnRPcHRpb25zICYgUGFydGlhbDxTZXJpYWxpemVyUHJvcDxWYWx1ZSwgRXh0cmFzPj47XG4gIHNlcmlhbGl6ZXI6IFNlcmlhbGl6ZXI8VmFsdWUsIEV4dHJhcz47XG4gIHNlcnZlck1hcDogeyBbaG9zdHBvcnQ6IHN0cmluZ106IFNlcnZlciB9O1xuICBzZXJ2ZXJLZXlzOiBzdHJpbmdbXTtcblxuICAvLyBDbGllbnQgaW5pdGlhbGl6ZXIgdGFrZXMgYSBsaXN0IG9mIGBTZXJ2ZXJgcyBhbmQgYW4gYG9wdGlvbnNgIGRpY3Rpb25hcnkuXG4gIC8vIFNlZSBgQ2xpZW50LmNyZWF0ZWAgZm9yIGRldGFpbHMuXG4gIGNvbnN0cnVjdG9yKHNlcnZlcnM6IFNlcnZlcltdLCBvcHRpb25zOiBHaXZlbkNsaWVudE9wdGlvbnM8VmFsdWUsIEV4dHJhcz4pIHtcbiAgICB0aGlzLnNlcnZlcnMgPSBzZXJ2ZXJzO1xuICAgIHRoaXMuc2VxID0gMDtcbiAgICB0aGlzLm9wdGlvbnMgPSBtZXJnZShvcHRpb25zIHx8IHt9LCB7XG4gICAgICByZXRyaWVzOiAyLFxuICAgICAgcmV0cnlfZGVsYXk6IDAuMixcbiAgICAgIGV4cGlyZXM6IDAsXG4gICAgICBsb2dnZXI6IGNvbnNvbGUsXG4gICAgICBrZXlUb1NlcnZlckhhc2hGdW5jdGlvbjogZGVmYXVsdEtleVRvU2VydmVySGFzaEZ1bmN0aW9uLFxuICAgIH0pO1xuXG4gICAgdGhpcy5zZXJpYWxpemVyID0gdGhpcy5vcHRpb25zLnNlcmlhbGl6ZXIgfHwgKG5vb3BTZXJpYWxpemVyIGFzIGFueSk7XG5cbiAgICAvLyBTdG9yZSBhIG1hcHBpbmcgZnJvbSBob3N0cG9ydCAtPiBzZXJ2ZXIgc28gd2UgY2FuIHF1aWNrbHkgZ2V0IGEgc2VydmVyIG9iamVjdCBmcm9tIHRoZSBzZXJ2ZXJLZXkgcmV0dXJuZWQgYnkgdGhlIGhhc2hpbmcgZnVuY3Rpb25cbiAgICBjb25zdCBzZXJ2ZXJNYXA6IHsgW2hvc3Rwb3J0OiBzdHJpbmddOiBTZXJ2ZXIgfSA9IHt9O1xuICAgIHRoaXMuc2VydmVycy5mb3JFYWNoKGZ1bmN0aW9uIChzZXJ2ZXIpIHtcbiAgICAgIHNlcnZlck1hcFtzZXJ2ZXIuaG9zdHBvcnRTdHJpbmcoKV0gPSBzZXJ2ZXI7XG4gICAgfSk7XG4gICAgdGhpcy5zZXJ2ZXJNYXAgPSBzZXJ2ZXJNYXA7XG5cbiAgICAvLyBzdG9yZSBhIGxpc3Qgb2YgYWxsIG91ciBzZXJ2ZXJLZXlzIHNvIHdlIGRvbid0IG5lZWQgdG8gY29uc3RhbnRseSByZWFsbG9jYXRlIHRoaXMgYXJyYXlcbiAgICB0aGlzLnNlcnZlcktleXMgPSBPYmplY3Qua2V5cyh0aGlzLnNlcnZlck1hcCk7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlcyBhIG5ldyBjbGllbnQgZ2l2ZW4gYW4gb3B0aW9uYWwgY29uZmlnIHN0cmluZyBhbmQgb3B0aW9uYWwgaGFzaCBvZlxuICAgKiBvcHRpb25zLiBUaGUgY29uZmlnIHN0cmluZyBzaG91bGQgYmUgb2YgdGhlIGZvcm06XG4gICAqXG4gICAqICAgICBcIlt1c2VyOnBhc3NAXXNlcnZlcjFbOjExMjExXSxbdXNlcjpwYXNzQF1zZXJ2ZXIyWzoxMTIxMV0sLi4uXCJcbiAgICpcbiAgICogSWYgdGhlIGFyZ3VtZW50IGlzIG5vdCBnaXZlbiwgZmFsbGJhY2sgb24gdGhlIGBNRU1DQUNISUVSX1NFUlZFUlNgIGVudmlyb25tZW50XG4gICAqIHZhcmlhYmxlLCBgTUVNQ0FDSEVfU0VSVkVSU2AgZW52aXJvbm1lbnQgdmFyaWFibGUgb3IgYFwibG9jYWxob3N0OjExMjExXCJgLlxuICAgKlxuICAgKiBUaGUgb3B0aW9ucyBoYXNoIG1heSBjb250YWluIHRoZSBvcHRpb25zOlxuICAgKlxuICAgKiAqIGByZXRyaWVzYCAtIHRoZSBudW1iZXIgb2YgdGltZXMgdG8gcmV0cnkgYW4gb3BlcmF0aW9uIGluIGxpZXUgb2YgZmFpbHVyZXNcbiAgICogKGRlZmF1bHQgMilcbiAgICogKiBgZXhwaXJlc2AgLSB0aGUgZGVmYXVsdCBleHBpcmF0aW9uIGluIHNlY29uZHMgdG8gdXNlIChkZWZhdWx0IDAgLSBuZXZlclxuICAgKiBleHBpcmUpLiBJZiBgZXhwaXJlc2AgaXMgZ3JlYXRlciB0aGFuIDMwIGRheXMgKDYwIHggNjAgeCAyNCB4IDMwKSwgaXQgaXNcbiAgICogdHJlYXRlZCBhcyBhIFVOSVggdGltZSAobnVtYmVyIG9mIHNlY29uZHMgc2luY2UgSmFudWFyeSAxLCAxOTcwKS5cbiAgICogKiBgbG9nZ2VyYCAtIGEgbG9nZ2VyIG9iamVjdCB0aGF0IHJlc3BvbmRzIHRvIGBsb2coc3RyaW5nKWAgbWV0aG9kIGNhbGxzLlxuICAgKlxuICAgKiAgIH5+fn5cbiAgICogICAgIGxvZyhtc2cxWywgbXNnMlssIG1zZzNbLi4uXV1dKVxuICAgKiAgIH5+fn5cbiAgICpcbiAgICogICBEZWZhdWx0cyB0byBgY29uc29sZWAuXG4gICAqICogYHNlcmlhbGl6ZXJgIC0gdGhlIG9iamVjdCB3aGljaCB3aWxsIChkZSlzZXJpYWxpemUgdGhlIGRhdGEuIEl0IG5lZWRzXG4gICAqICAgdHdvIHB1YmxpYyBtZXRob2RzOiBzZXJpYWxpemUgYW5kIGRlc2VyaWFsaXplLiBJdCBkZWZhdWx0cyB0byB0aGVcbiAgICogICBub29wU2VyaWFsaXplcjpcbiAgICpcbiAgICogICB+fn5+XG4gICAqICAgY29uc3Qgbm9vcFNlcmlhbGl6ZXIgPSB7XG4gICAqICAgICBzZXJpYWxpemU6IGZ1bmN0aW9uIChvcGNvZGUsIHZhbHVlLCBleHRyYXMpIHtcbiAgICogICAgICAgcmV0dXJuIHsgdmFsdWU6IHZhbHVlLCBleHRyYXM6IGV4dHJhcyB9O1xuICAgKiAgICAgfSxcbiAgICogICAgIGRlc2VyaWFsaXplOiBmdW5jdGlvbiAob3Bjb2RlLCB2YWx1ZSwgZXh0cmFzKSB7XG4gICAqICAgICAgIHJldHVybiB7IHZhbHVlOiB2YWx1ZSwgZXh0cmFzOiBleHRyYXMgfTtcbiAgICogICAgIH1cbiAgICogICB9O1xuICAgKiAgIH5+fn5cbiAgICpcbiAgICogT3Igb3B0aW9ucyBmb3IgdGhlIHNlcnZlcnMgaW5jbHVkaW5nOlxuICAgKiAqIGB1c2VybmFtZWAgYW5kIGBwYXNzd29yZGAgZm9yIGZhbGxiYWNrIFNBU0wgYXV0aGVudGljYXRpb24gY3JlZGVudGlhbHMuXG4gICAqICogYHRpbWVvdXRgIGluIHNlY29uZHMgdG8gZGV0ZXJtaW5lIGZhaWx1cmUgZm9yIG9wZXJhdGlvbnMuIERlZmF1bHQgaXMgMC41XG4gICAqICAgICAgICAgICAgIHNlY29uZHMuXG4gICAqICogJ2Nvbm50aW1lb3V0JyBpbiBzZWNvbmRzIHRvIGNvbm5lY3Rpb24gZmFpbHVyZS4gRGVmYXVsdCBpcyB0d2ljZSB0aGUgdmFsdWVcbiAgICogICAgICAgICAgICAgICAgIG9mIGB0aW1lb3V0YC5cbiAgICogKiBga2VlcEFsaXZlYCB3aGV0aGVyIHRvIGVuYWJsZSBrZWVwLWFsaXZlIGZ1bmN0aW9uYWxpdHkuIERlZmF1bHRzIHRvIGZhbHNlLlxuICAgKiAqIGBrZWVwQWxpdmVEZWxheWAgaW4gc2Vjb25kcyB0byB0aGUgaW5pdGlhbCBkZWxheSBiZWZvcmUgdGhlIGZpcnN0IGtlZXBhbGl2ZVxuICAgKiAgICAgICAgICAgICAgICAgICAgcHJvYmUgaXMgc2VudCBvbiBhbiBpZGxlIHNvY2tldC4gRGVmYXVsdHMgaXMgMzAgc2Vjb25kcy5cbiAgICogKiBga2V5VG9TZXJ2ZXJIYXNoRnVuY3Rpb25gIGEgZnVuY3Rpb24gdG8gbWFwIGtleXMgdG8gc2VydmVycywgd2l0aCB0aGUgc2lnbmF0dXJlXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgIChzZXJ2ZXJLZXlzOiBzdHJpbmdbXSwga2V5OiBzdHJpbmcpOiBzdHJpbmdcbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgTk9URTogaWYgeW91IG5lZWQgdG8gZG8gc29tZSBleHBlbnNpdmUgaW5pdGlhbGl6YXRpb24sICpwbGVhc2UqIGRvIGl0IGxhemlseSB0aGUgZmlyc3QgdGltZSB5b3UgdGhpcyBmdW5jdGlvbiBpcyBjYWxsZWQgd2l0aCBhbiBhcnJheSBvZiBzZXJ2ZXJLZXlzLCBub3Qgb24gZXZlcnkgY2FsbFxuICAgKi9cbiAgc3RhdGljIGNyZWF0ZTxWYWx1ZSwgRXh0cmFzPihcbiAgICBzZXJ2ZXJzU3RyOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgb3B0aW9uczogSWZCdWZmZXI8XG4gICAgICBWYWx1ZSxcbiAgICAgIEV4dHJhcyxcbiAgICAgIHVuZGVmaW5lZCB8IChQYXJ0aWFsPFNlcnZlck9wdGlvbnM+ICYgR2l2ZW5DbGllbnRPcHRpb25zPFZhbHVlLCBFeHRyYXM+KSxcbiAgICAgIFBhcnRpYWw8U2VydmVyT3B0aW9ucz4gJiBHaXZlbkNsaWVudE9wdGlvbnM8VmFsdWUsIEV4dHJhcz5cbiAgICA+XG4gICk6IENsaWVudDxWYWx1ZSwgRXh0cmFzPiB7XG4gICAgc2VydmVyc1N0ciA9XG4gICAgICBzZXJ2ZXJzU3RyIHx8XG4gICAgICBwcm9jZXNzLmVudi5NRU1DQUNISUVSX1NFUlZFUlMgfHxcbiAgICAgIHByb2Nlc3MuZW52Lk1FTUNBQ0hFX1NFUlZFUlMgfHxcbiAgICAgIFwibG9jYWxob3N0OjExMjExXCI7XG4gICAgY29uc3Qgc2VydmVyVXJpcyA9IHNlcnZlcnNTdHIuc3BsaXQoXCIsXCIpO1xuICAgIGNvbnN0IHNlcnZlcnMgPSBzZXJ2ZXJVcmlzLm1hcChmdW5jdGlvbiAodXJpKSB7XG4gICAgICBjb25zdCB1cmlQYXJ0cyA9IHVyaS5zcGxpdChcIkBcIik7XG4gICAgICBjb25zdCBob3N0UG9ydCA9IHVyaVBhcnRzW3VyaVBhcnRzLmxlbmd0aCAtIDFdLnNwbGl0KFwiOlwiKTtcbiAgICAgIGNvbnN0IHVzZXJQYXNzID0gKHVyaVBhcnRzW3VyaVBhcnRzLmxlbmd0aCAtIDJdIHx8IFwiXCIpLnNwbGl0KFwiOlwiKTtcbiAgICAgIHJldHVybiBuZXcgU2VydmVyKFxuICAgICAgICBob3N0UG9ydFswXSxcbiAgICAgICAgcGFyc2VJbnQoaG9zdFBvcnRbMV0gfHwgXCIxMTIxMVwiLCAxMCksXG4gICAgICAgIHVzZXJQYXNzWzBdLFxuICAgICAgICB1c2VyUGFzc1sxXSxcbiAgICAgICAgb3B0aW9uc1xuICAgICAgKTtcbiAgICB9KTtcbiAgICByZXR1cm4gbmV3IENsaWVudChzZXJ2ZXJzLCBvcHRpb25zIGFzIGFueSk7XG4gIH1cblxuICAvKipcbiAgICogR2l2ZW4gYSBzZXJ2ZXJLZXkgZnJvbWxvb2t1cEtleVRvU2VydmVyS2V5LCByZXR1cm4gdGhlIGNvcnJlc3BvbmRpbmcgU2VydmVyIGluc3RhbmNlXG4gICAqXG4gICAqIEBwYXJhbSAge3N0cmluZ30gc2VydmVyS2V5XG4gICAqIEByZXR1cm5zIHtTZXJ2ZXJ9XG4gICAqL1xuICBzZXJ2ZXJLZXlUb1NlcnZlcihzZXJ2ZXJLZXk6IHN0cmluZyk6IFNlcnZlciB7XG4gICAgcmV0dXJuIHRoaXMuc2VydmVyTWFwW3NlcnZlcktleV07XG4gIH1cblxuICAvKipcbiAgICogR2l2ZW4gYSBrZXkgdG8gbG9vayB1cCBpbiBtZW1jYWNoZSwgcmV0dXJuIGEgc2VydmVyS2V5IChiYXNlZCBvbiBzb21lXG4gICAqIGhhc2hpbmcgZnVuY3Rpb24pIHdoaWNoIGNhbiBiZSB1c2VkIHRvIGluZGV4IHRoaXMuc2VydmVyTWFwXG4gICAqL1xuICBsb29rdXBLZXlUb1NlcnZlcktleShrZXk6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMub3B0aW9ucy5rZXlUb1NlcnZlckhhc2hGdW5jdGlvbih0aGlzLnNlcnZlcktleXMsIGtleSk7XG4gIH1cblxuICAvLyAjIyBNZW1jYWNoZSBDb21tYW5kc1xuICAvL1xuICAvLyBBbGwgY29tbWFuZHMgcmV0dXJuIHRoZWlyIHJlc3VsdHMgdGhyb3VnaCBhIGNhbGxiYWNrIHBhc3NlZCBhcyB0aGUgbGFzdFxuICAvLyByZXF1aXJlZCBhcmd1bWVudCAoc29tZSBjb21tYW5kcywgbGlrZSBgQ2xpZW50I3NldGAsIHRha2Ugb3B0aW9uYWwgYXJndW1lbnRzXG4gIC8vIGFmdGVyIHRoZSBjYWxsYmFjaykuXG4gIC8vXG4gIC8vIFRoZSBjYWxsYmFjayBzaWduYXR1cmUgYWx3YXlzIGZvbGxvd3M6XG4gIC8vXG4gIC8vICAgICBjYWxsYmFjayhlcnIsIFthcmcxWywgYXJnMlssIGFyZzNbLi4uXV1dXSlcbiAgLy9cbiAgLy8gSW4gY2FzZSBvZiBhbiBlcnJvciB0aGUgX2Vycl8gYXJndW1lbnQgd2lsbCBiZSBub24tbnVsbCBhbmQgY29udGFpbiB0aGVcbiAgLy8gYEVycm9yYC4gQSBub3RhYmxlIGV4Y2VwdGlvbiBpbmNsdWRlcyBhIGBDbGllbnQjZ2V0YCBvbiBhIGtleSB0aGF0IGRvZXNuJ3RcbiAgLy8gZXhpc3QuIEluIHRoaXMgY2FzZSwgX2Vycl8gd2lsbCBiZSBudWxsLCBhcyB3aWxsIHRoZSBfdmFsdWUgYW5kIF9leHRyYXNfXG4gIC8vIGFyZ3VtZW50cy5cblxuICAvKipcbiAgICogUmV0cmlldmVzIHRoZSB2YWx1ZSBhdCB0aGUgZ2l2ZW4ga2V5IGluIG1lbWNhY2hlLlxuICAgKi9cbiAgZ2V0KGtleTogc3RyaW5nKTogUHJvbWlzZTxHZXRSZXN1bHQ8VmFsdWUsIEV4dHJhcz4gfCBudWxsPjtcbiAgZ2V0KFxuICAgIGtleTogc3RyaW5nLFxuICAgIGNhbGxiYWNrOiAoXG4gICAgICBlcnJvcjogRXJyb3IgfCBudWxsLFxuICAgICAgcmVzdWx0OiBHZXRSZXN1bHQ8VmFsdWUsIEV4dHJhcz4gfCBudWxsXG4gICAgKSA9PiB2b2lkXG4gICk6IHZvaWQ7XG4gIGdldChcbiAgICBrZXk6IHN0cmluZyxcbiAgICBjYWxsYmFjaz86IChcbiAgICAgIGVycm9yOiBFcnJvciB8IG51bGwsXG4gICAgICByZXN1bHQ6IEdldFJlc3VsdDxWYWx1ZSwgRXh0cmFzPiB8IG51bGxcbiAgICApID0+IHZvaWRcbiAgKTogUHJvbWlzZTxHZXRSZXN1bHQ8VmFsdWUsIEV4dHJhcz4gfCBudWxsPiB8IHZvaWQge1xuICAgIGlmIChjYWxsYmFjayA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gcHJvbWlzaWZ5KChjYWxsYmFjaykgPT4ge1xuICAgICAgICB0aGlzLmdldChrZXksIGZ1bmN0aW9uIChlcnIsIHZhbHVlKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCB2YWx1ZSk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuICAgIHRoaXMuaW5jclNlcSgpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSBtYWtlUmVxdWVzdEJ1ZmZlcihjb25zdGFudHMuT1BfR0VULCBrZXksIFwiXCIsIFwiXCIsIHRoaXMuc2VxKTtcbiAgICB0aGlzLnBlcmZvcm0oa2V5LCByZXF1ZXN0LCB0aGlzLnNlcSwgKGVyciwgcmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzKSB7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuU1VDQ0VTUzpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNvbnN0IGRlc2VyaWFsaXplZCA9IHRoaXMuc2VyaWFsaXplci5kZXNlcmlhbGl6ZShcbiAgICAgICAgICAgICAgcmVzcG9uc2UhLmhlYWRlci5vcGNvZGUsXG4gICAgICAgICAgICAgIHJlc3BvbnNlIS52YWwsXG4gICAgICAgICAgICAgIHJlc3BvbnNlIS5leHRyYXNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBjYWxsYmFjayhudWxsLCB7IC4uLmRlc2VyaWFsaXplZCwgY2FzOiByZXNwb25zZSEuaGVhZGVyLmNhcyB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuS0VZX05PVF9GT1VORDpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aGlzLmhhbmRsZVJlc3BvbnNlRXJyb3IoXCJHRVRcIiwgcmVzcG9uc2U/LmhlYWRlcj8uc3RhdHVzLCBjYWxsYmFjayk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvKiogQnVpbGQgYSBwaXBlbGluZWQgZ2V0IG11bHRpIHJlcXVlc3QgYnkgc2VuZGluZyBvbmUgR0VUS1EgZm9yIGVhY2gga2V5IChxdWlldCwgbWVhbmluZyBpdCB3b24ndCByZXNwb25kIGlmIHRoZSB2YWx1ZSBpcyBtaXNzaW5nKSBmb2xsb3dlZCBieSBhIG5vLW9wIHRvIGZvcmNlIGEgcmVzcG9uc2UgKGFuZCB0byBnaXZlIHVzIGEgc2VudGluZWwgcmVzcG9uc2UgdGhhdCB0aGUgcGlwZWxpbmUgaXMgZG9uZSlcbiAgICpcbiAgICogY2YgaHR0cHM6Ly9naXRodWIuY29tL2NvdWNoYmFzZS9tZW1jYWNoZWQvYmxvYi9tYXN0ZXIvZG9jcy9CaW5hcnlQcm90b2NvbC5tZCMweDBkLWdldGtxLWdldC13aXRoLWtleS1xdWlldGx5XG4gICAqL1xuICBfYnVpbGRHZXRNdWx0aVJlcXVlc3Qoa2V5czogc3RyaW5nW10pOiBCdWZmZXIge1xuICAgIC8vIHN0YXJ0IGF0IDI0IGZvciB0aGUgbm8tb3AgY29tbWFuZCBhdCB0aGUgZW5kXG4gICAgbGV0IHJlcXVlc3RTaXplID0gMjQ7XG4gICAgZm9yIChjb25zdCBrZXlJZHggaW4ga2V5cykge1xuICAgICAgcmVxdWVzdFNpemUgKz0gQnVmZmVyLmJ5dGVMZW5ndGgoa2V5c1trZXlJZHhdLCBcInV0ZjhcIikgKyAyNDtcbiAgICB9XG5cbiAgICBjb25zdCByZXF1ZXN0ID0gQnVmZmVyLmFsbG9jKHJlcXVlc3RTaXplKTtcblxuICAgIGxldCBieXRlc1dyaXR0ZW4gPSAwO1xuICAgIGZvciAoY29uc3Qga2V5SWR4IGluIGtleXMpIHtcbiAgICAgIGNvbnN0IGtleSA9IGtleXNba2V5SWR4XTtcbiAgICAgIGJ5dGVzV3JpdHRlbiArPSBjb3B5SW50b1JlcXVlc3RCdWZmZXIoXG4gICAgICAgIGNvbnN0YW50cy5PUF9HRVRLUSxcbiAgICAgICAga2V5LFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICB0aGlzLnNlcSxcbiAgICAgICAgcmVxdWVzdCxcbiAgICAgICAgYnl0ZXNXcml0dGVuXG4gICAgICApO1xuICAgIH1cblxuICAgIGJ5dGVzV3JpdHRlbiArPSBjb3B5SW50b1JlcXVlc3RCdWZmZXIoXG4gICAgICBjb25zdGFudHMuT1BfTk9fT1AsXG4gICAgICBcIlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiXCIsXG4gICAgICB0aGlzLnNlcSxcbiAgICAgIHJlcXVlc3QsXG4gICAgICBieXRlc1dyaXR0ZW5cbiAgICApO1xuXG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cblxuICAvKiogRXhlY3V0aW5nIGEgcGlwZWxpbmVkIChtdWx0aSkgZ2V0IGFnYWluc3QgYSBzaW5nbGUgc2VydmVyLiBUaGlzIGlzIGEgcHJpdmF0ZSBpbXBsZW1lbnRhdGlvbiBkZXRhaWwgb2YgZ2V0TXVsdGkuICovXG4gIF9nZXRNdWx0aVRvU2VydmVyPEtleXMgZXh0ZW5kcyBzdHJpbmc+KFxuICAgIHNlcnY6IFNlcnZlcixcbiAgICBrZXlzOiBLZXlzW10sXG4gICAgY2FsbGJhY2s6IChcbiAgICAgIGVycm9yOiBFcnJvciB8IG51bGwsXG4gICAgICB2YWx1ZXM6IEdldE11bHRpUmVzdWx0PEtleXMsIFZhbHVlLCBFeHRyYXM+IHwgbnVsbFxuICAgICkgPT4gdm9pZFxuICApIHtcbiAgICBjb25zdCByZXNwb25zZU1hcDogR2V0TXVsdGlSZXN1bHQ8c3RyaW5nLCBWYWx1ZSwgRXh0cmFzPiA9IHt9O1xuXG4gICAgY29uc3QgaGFuZGxlOiBPblJlc3BvbnNlQ2FsbGJhY2sgPSAocmVzcG9uc2UpID0+IHtcbiAgICAgIHN3aXRjaCAocmVzcG9uc2UuaGVhZGVyLnN0YXR1cykge1xuICAgICAgICBjYXNlIFJlc3BvbnNlU3RhdHVzLlNVQ0NFU1M6XG4gICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjb25zdCBkZXNlcmlhbGl6ZWQgPSB0aGlzLnNlcmlhbGl6ZXIuZGVzZXJpYWxpemUoXG4gICAgICAgICAgICAgIHJlc3BvbnNlLmhlYWRlci5vcGNvZGUsXG4gICAgICAgICAgICAgIHJlc3BvbnNlLnZhbCxcbiAgICAgICAgICAgICAgcmVzcG9uc2UuZXh0cmFzXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgLy8gV2hlbiB3ZSBnZXQgdGhlIG5vLW9wIHJlc3BvbnNlLCB3ZSBhcmUgZG9uZSB3aXRoIHRoaXMgb25lIGdldE11bHRpIGluIHRoZSBwZXItYmFja2VuZCBmYW4tb3V0XG4gICAgICAgICAgICBpZiAocmVzcG9uc2UuaGVhZGVyLm9wY29kZSA9PT0gY29uc3RhbnRzLk9QX05PX09QKSB7XG4gICAgICAgICAgICAgIC8vIFRoaXMgZW5zdXJlcyB0aGUgaGFuZGxlciB3aWxsIGJlIGRlbGV0ZWQgZnJvbSB0aGUgcmVzcG9uc2VDYWxsYmFja3MgbWFwIGluIHNlcnZlci5qc1xuICAgICAgICAgICAgICAvLyBUaGlzIGlzbid0IHRlY2huaWNhbGx5IG5lZWRlZCBoZXJlIGJlY2F1c2UgdGhlIGxvZ2ljIGluIHNlcnZlci5qcyBhbHNvIGNoZWNrcyBpZiB0b3RhbEJvZHlMZW5ndGggPT09IDAsIGJ1dCBvdXIgdW5pdHRlc3RzIGFyZW4ndCBncmVhdCBhYm91dCBzZXR0aW5nIHRoYXQgZmllbGQsIGFuZCBhbHNvIHRoaXMgbWFrZXMgaXQgbW9yZSBleHBsaWNpdFxuICAgICAgICAgICAgICBoYW5kbGUucXVpZXQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzcG9uc2VNYXApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzcG9uc2Uua2V5LnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgIHJlc3BvbnNlTWFwW2tleV0gPSB7IC4uLmRlc2VyaWFsaXplZCwgY2FzOiByZXNwb25zZS5oZWFkZXIuY2FzIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHRoaXMuaGFuZGxlUmVzcG9uc2VFcnJvcihcIkdFVFwiLCByZXNwb25zZS5oZWFkZXIuc3RhdHVzLCBjYWxsYmFjayk7XG4gICAgICB9XG4gICAgfTtcbiAgICAvLyBUaGlzIHByZXZlbnRzIHRoZSBoYW5kbGVyIGZyb20gYmVpbmcgZGVsZXRlZFxuICAgIC8vIGFmdGVyIHRoZSBmaXJzdCByZXNwb25zZS4gTG9naWMgaW4gc2VydmVyLmpzLlxuICAgIGhhbmRsZS5xdWlldCA9IHRydWU7XG5cbiAgICBjb25zdCByZXF1ZXN0ID0gdGhpcy5fYnVpbGRHZXRNdWx0aVJlcXVlc3Qoa2V5cyk7XG4gICAgc2Vydi5vblJlc3BvbnNlKHRoaXMuc2VxLCBoYW5kbGUpO1xuICAgIHNlcnYub25FcnJvcih0aGlzLnNlcSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgc2Vydi53cml0ZShyZXF1ZXN0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXRyaWV2cyB0aGUgdmFsdWUgYXQgdGhlIGdpdmVuIGtleXMgaW4gbWVtY2FjaGVkLiBSZXR1cm5zIGEgbWFwIGZyb20gdGhlXG4gICAqIHJlcXVlc3RlZCBrZXlzIHRvIHJlc3VsdHMsIG9yIG51bGwgaWYgdGhlIGtleSB3YXMgbm90IGZvdW5kLlxuICAgKi9cbiAgZ2V0TXVsdGk8S2V5cyBleHRlbmRzIHN0cmluZz4oXG4gICAga2V5czogS2V5c1tdXG4gICk6IFByb21pc2U8R2V0TXVsdGlSZXN1bHQ8S2V5cywgVmFsdWUsIEV4dHJhcz4gfCBudWxsPjtcbiAgZ2V0TXVsdGk8S2V5cyBleHRlbmRzIHN0cmluZz4oXG4gICAga2V5czogS2V5c1tdLFxuICAgIGNhbGxiYWNrOiAoXG4gICAgICBlcnJvcjogRXJyb3IgfCBudWxsLFxuICAgICAgdmFsdWU6IEdldE11bHRpUmVzdWx0PEtleXMsIFZhbHVlLCBFeHRyYXM+IHwgbnVsbFxuICAgICkgPT4gdm9pZFxuICApOiB2b2lkO1xuICBnZXRNdWx0aTxLZXlzIGV4dGVuZHMgc3RyaW5nPihcbiAgICBrZXlzOiBLZXlzW10sXG4gICAgY2FsbGJhY2s/OiAoXG4gICAgICBlcnJvcjogRXJyb3IgfCBudWxsLFxuICAgICAgdmFsdWU6IEdldE11bHRpUmVzdWx0PEtleXMsIFZhbHVlLCBFeHRyYXM+IHwgbnVsbFxuICAgICkgPT4gdm9pZFxuICApOiBQcm9taXNlPEdldE11bHRpUmVzdWx0PEtleXMsIFZhbHVlLCBFeHRyYXM+IHwgbnVsbD4gfCB2b2lkIHtcbiAgICBpZiAoY2FsbGJhY2sgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHByb21pc2lmeSgoY2FsbGJhY2spID0+IHtcbiAgICAgICAgdGhpcy5nZXRNdWx0aShrZXlzLCBmdW5jdGlvbiAoZXJyLCB2YWx1ZSkge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgdmFsdWUpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHNlcnZlcktleXRvTG9va3VwS2V5czoge1xuICAgICAgW3NlcnZlcktleTogc3RyaW5nXTogc3RyaW5nW107XG4gICAgfSA9IHt9O1xuICAgIGtleXMuZm9yRWFjaCgobG9va3VwS2V5KSA9PiB7XG4gICAgICBjb25zdCBzZXJ2ZXJLZXkgPSB0aGlzLmxvb2t1cEtleVRvU2VydmVyS2V5KGxvb2t1cEtleSk7XG4gICAgICBpZiAoIXNlcnZlcktleXRvTG9va3VwS2V5c1tzZXJ2ZXJLZXldKSB7XG4gICAgICAgIHNlcnZlcktleXRvTG9va3VwS2V5c1tzZXJ2ZXJLZXldID0gW107XG4gICAgICB9XG4gICAgICBzZXJ2ZXJLZXl0b0xvb2t1cEtleXNbc2VydmVyS2V5XS5wdXNoKGxvb2t1cEtleSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCB1c2VkU2VydmVyS2V5cyA9IE9iamVjdC5rZXlzKHNlcnZlcktleXRvTG9va3VwS2V5cyk7XG4gICAgbGV0IG91dHN0YW5kaW5nQ2FsbHMgPSB1c2VkU2VydmVyS2V5cy5sZW5ndGg7XG4gICAgY29uc3QgcmVjb3JkTWFwOiBHZXRNdWx0aVJlc3VsdDxzdHJpbmcsIFZhbHVlLCBFeHRyYXM+ID0ge307XG4gICAgbGV0IGhhZEVycm9yID0gZmFsc2U7XG4gICAgZnVuY3Rpb24gbGF0Y2hDYWxsYmFjayhcbiAgICAgIGVycjogRXJyb3IgfCBudWxsLFxuICAgICAgdmFsdWVzOiBHZXRNdWx0aVJlc3VsdDxzdHJpbmcsIFZhbHVlLCBFeHRyYXM+IHwgbnVsbFxuICAgICkge1xuICAgICAgaWYgKGhhZEVycm9yKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKGVycikge1xuICAgICAgICBoYWRFcnJvciA9IHRydWU7XG4gICAgICAgIGNhbGxiYWNrIShlcnIsIG51bGwpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIG1lcmdlKHJlY29yZE1hcCwgdmFsdWVzKTtcbiAgICAgIG91dHN0YW5kaW5nQ2FsbHMgLT0gMTtcbiAgICAgIGlmIChvdXRzdGFuZGluZ0NhbGxzID09PSAwKSB7XG4gICAgICAgIGNhbGxiYWNrIShudWxsLCByZWNvcmRNYXApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoY29uc3Qgc2VydmVyS2V5SW5kZXggaW4gdXNlZFNlcnZlcktleXMpIHtcbiAgICAgIGNvbnN0IHNlcnZlcktleSA9IHVzZWRTZXJ2ZXJLZXlzW3NlcnZlcktleUluZGV4XTtcbiAgICAgIGNvbnN0IHNlcnZlciA9IHRoaXMuc2VydmVyS2V5VG9TZXJ2ZXIoc2VydmVyS2V5KTtcbiAgICAgIHRoaXMuX2dldE11bHRpVG9TZXJ2ZXIoXG4gICAgICAgIHNlcnZlcixcbiAgICAgICAgc2VydmVyS2V5dG9Mb29rdXBLZXlzW3NlcnZlcktleV0sXG4gICAgICAgIGxhdGNoQ2FsbGJhY2tcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNldHMgdGhlIGdpdmVuIF9rZXlfIHRvIF92YWx1ZV8uXG4gICAqL1xuICBzZXQoXG4gICAga2V5OiBzdHJpbmcsXG4gICAgdmFsdWU6IFZhbHVlLFxuICAgIG9wdGlvbnM/OiB7IGV4cGlyZXM/OiBudW1iZXI7IGNhcz86IENBU1Rva2VuIH1cbiAgKTogUHJvbWlzZTxib29sZWFuIHwgbnVsbD47XG4gIHNldChcbiAgICBrZXk6IHN0cmluZyxcbiAgICB2YWx1ZTogVmFsdWUsXG4gICAgb3B0aW9uczogeyBleHBpcmVzPzogbnVtYmVyOyBjYXM/OiBDQVNUb2tlbiB9LFxuICAgIGNhbGxiYWNrOiAoZXJyb3I6IEVycm9yIHwgbnVsbCwgc3VjY2VzczogYm9vbGVhbiB8IG51bGwpID0+IHZvaWRcbiAgKTogdm9pZDtcbiAgc2V0KFxuICAgIGtleTogc3RyaW5nLFxuICAgIHZhbHVlOiBWYWx1ZSxcbiAgICBvcHRpb25zOiB7IGV4cGlyZXM/OiBudW1iZXI7IGNhcz86IENBU1Rva2VuIH0sXG4gICAgY2FsbGJhY2s/OiAoZXJyb3I6IEVycm9yIHwgbnVsbCwgc3VjY2VzczogYm9vbGVhbiB8IG51bGwpID0+IHZvaWRcbiAgKTogUHJvbWlzZTxib29sZWFuIHwgbnVsbD4gfCB2b2lkIHtcbiAgICBpZiAoY2FsbGJhY2sgPT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb3B0aW9ucyAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBpZiAoIW9wdGlvbnMpIG9wdGlvbnMgPSB7fTtcbiAgICAgIHJldHVybiBwcm9taXNpZnkoKGNhbGxiYWNrKSA9PiB7XG4gICAgICAgIHRoaXMuc2V0KGtleSwgdmFsdWUsIG9wdGlvbnMsIGZ1bmN0aW9uIChlcnIsIHN1Y2Nlc3MpIHtcbiAgICAgICAgICBjYWxsYmFjayhlcnIsIHN1Y2Nlc3MpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGV4cGlyZXMgPSBvcHRpb25zLmV4cGlyZXM7XG5cbiAgICAvLyBUT0RPOiBzdXBwb3J0IGZsYWdzXG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgY29uc3QgZXhwaXJhdGlvbiA9IG1ha2VFeHBpcmF0aW9uKGV4cGlyZXMgfHwgdGhpcy5vcHRpb25zLmV4cGlyZXMpO1xuICAgIGNvbnN0IGV4dHJhcyA9IEJ1ZmZlci5jb25jYXQoW0J1ZmZlci5mcm9tKFwiMDAwMDAwMDBcIiwgXCJoZXhcIiksIGV4cGlyYXRpb25dKTtcblxuICAgIGNvbnN0IG9wY29kZTogY29uc3RhbnRzLk9QID0gMTtcbiAgICBjb25zdCBzZXJpYWxpemVkID0gdGhpcy5zZXJpYWxpemVyLnNlcmlhbGl6ZShvcGNvZGUsIHZhbHVlLCBleHRyYXMpO1xuXG4gICAgY29uc3QgcmVxdWVzdCA9IFV0aWxzLmVuY29kZVJlcXVlc3Qoe1xuICAgICAgaGVhZGVyOiB7XG4gICAgICAgIG9wY29kZTogY29uc3RhbnRzLk9QX1NFVCxcbiAgICAgICAgb3BhcXVlOiB0aGlzLnNlcSxcbiAgICAgICAgY2FzOiBvcHRpb25zLmNhcyxcbiAgICAgIH0sXG4gICAgICBrZXksXG4gICAgICB2YWx1ZTogc2VyaWFsaXplZC52YWx1ZSxcbiAgICAgIGV4dHJhczogc2VyaWFsaXplZC5leHRyYXMsXG4gICAgfSk7XG4gICAgdGhpcy5wZXJmb3JtKGtleSwgcmVxdWVzdCwgdGhpcy5zZXEsIChlcnIsIHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChyZXNwb25zZSEuaGVhZGVyLnN0YXR1cykge1xuICAgICAgICBjYXNlIFJlc3BvbnNlU3RhdHVzLlNVQ0NFU1M6XG4gICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhudWxsLCB0cnVlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuS0VZX0VYSVNUUzpcbiAgICAgICAgICBpZiAob3B0aW9ucy5jYXMpIHtcbiAgICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgICBjYWxsYmFjayhudWxsLCBmYWxzZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhpcy5oYW5kbGVSZXNwb25zZUVycm9yKFwiU0VUXCIsIHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzLCBjYWxsYmFjayk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQUREXG4gICAqXG4gICAqIEFkZHMgdGhlIGdpdmVuIF9rZXlfIGFuZCBfdmFsdWVfIHRvIG1lbWNhY2hlLiBUaGUgb3BlcmF0aW9uIG9ubHkgc3VjY2VlZHNcbiAgICogaWYgdGhlIGtleSBpcyBub3QgYWxyZWFkeSBzZXQuXG4gICAqXG4gICAqIFRoZSBvcHRpb25zIGRpY3Rpb25hcnkgdGFrZXM6XG4gICAqICogX2V4cGlyZXNfOiBvdmVycmlkZXMgdGhlIGRlZmF1bHQgZXhwaXJhdGlvbiAoc2VlIGBDbGllbnQuY3JlYXRlYCkgZm9yIHRoaXNcbiAgICogICAgICAgICAgICAgIHBhcnRpY3VsYXIga2V5LXZhbHVlIHBhaXIuXG4gICAqXG4gICAqIFRoZSBjYWxsYmFjayBzaWduYXR1cmUgaXM6XG4gICAqXG4gICAqICAgICBjYWxsYmFjayhlcnIsIHN1Y2Nlc3MpXG4gICAqIEBwYXJhbSBrZXlcbiAgICogQHBhcmFtIHZhbHVlXG4gICAqIEBwYXJhbSBvcHRpb25zXG4gICAqIEBwYXJhbSBjYWxsYmFja1xuICAgKi9cbiAgYWRkKFxuICAgIGtleTogc3RyaW5nLFxuICAgIHZhbHVlOiBWYWx1ZSxcbiAgICBvcHRpb25zPzogeyBleHBpcmVzPzogbnVtYmVyIH1cbiAgKTogUHJvbWlzZTxib29sZWFuIHwgbnVsbD47XG4gIGFkZChcbiAgICBrZXk6IHN0cmluZyxcbiAgICB2YWx1ZTogVmFsdWUsXG4gICAgb3B0aW9uczogeyBleHBpcmVzPzogbnVtYmVyIH0sXG4gICAgY2FsbGJhY2s6IChlcnJvcjogRXJyb3IgfCBudWxsLCBzdWNjZXNzOiBib29sZWFuIHwgbnVsbCkgPT4gdm9pZFxuICApOiB2b2lkO1xuICBhZGQoXG4gICAga2V5OiBzdHJpbmcsXG4gICAgdmFsdWU6IFZhbHVlLFxuICAgIG9wdGlvbnM/OiB7IGV4cGlyZXM/OiBudW1iZXIgfSxcbiAgICBjYWxsYmFjaz86IChlcnJvcjogRXJyb3IgfCBudWxsLCBzdWNjZXNzOiBib29sZWFuIHwgbnVsbCkgPT4gdm9pZFxuICApOiBQcm9taXNlPGJvb2xlYW4gfCBudWxsPiB8IHZvaWQge1xuICAgIGlmIChjYWxsYmFjayA9PT0gdW5kZWZpbmVkICYmIG9wdGlvbnMgIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaWYgKCFvcHRpb25zKSBvcHRpb25zID0ge307XG4gICAgICByZXR1cm4gcHJvbWlzaWZ5KChjYWxsYmFjaykgPT4ge1xuICAgICAgICB0aGlzLmFkZChcbiAgICAgICAgICBrZXksXG4gICAgICAgICAgdmFsdWUsXG4gICAgICAgICAgb3B0aW9ucyBhcyB7IGV4cGlyZXM/OiBudW1iZXIgfSxcbiAgICAgICAgICBmdW5jdGlvbiAoZXJyLCBzdWNjZXNzKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIsIHN1Y2Nlc3MpO1xuICAgICAgICAgIH1cbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFRPRE86IHN1cHBvcnQgZmxhZ3MsIHN1cHBvcnQgdmVyc2lvbiAoQ0FTKVxuICAgIHRoaXMuaW5jclNlcSgpO1xuICAgIGNvbnN0IGV4cGlyYXRpb24gPSBtYWtlRXhwaXJhdGlvbihcbiAgICAgIChvcHRpb25zIHx8IHt9KS5leHBpcmVzIHx8IHRoaXMub3B0aW9ucy5leHBpcmVzXG4gICAgKTtcbiAgICBjb25zdCBleHRyYXMgPSBCdWZmZXIuY29uY2F0KFtCdWZmZXIuZnJvbShcIjAwMDAwMDAwXCIsIFwiaGV4XCIpLCBleHBpcmF0aW9uXSk7XG5cbiAgICBjb25zdCBvcGNvZGU6IGNvbnN0YW50cy5PUCA9IDI7XG4gICAgY29uc3Qgc2VyaWFsaXplZCA9IHRoaXMuc2VyaWFsaXplci5zZXJpYWxpemUob3Bjb2RlLCB2YWx1ZSwgZXh0cmFzKTtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWFrZVJlcXVlc3RCdWZmZXIoXG4gICAgICBvcGNvZGUsXG4gICAgICBrZXksXG4gICAgICBzZXJpYWxpemVkLmV4dHJhcyxcbiAgICAgIHNlcmlhbGl6ZWQudmFsdWUsXG4gICAgICB0aGlzLnNlcVxuICAgICk7XG4gICAgdGhpcy5wZXJmb3JtKGtleSwgcmVxdWVzdCwgdGhpcy5zZXEsIChlcnIsIHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChyZXNwb25zZSEuaGVhZGVyLnN0YXR1cykge1xuICAgICAgICBjYXNlIFJlc3BvbnNlU3RhdHVzLlNVQ0NFU1M6XG4gICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhudWxsLCB0cnVlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuS0VZX0VYSVNUUzpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGZhbHNlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlUmVzcG9uc2VFcnJvcihcbiAgICAgICAgICAgIFwiQUREXCIsXG4gICAgICAgICAgICByZXNwb25zZT8uaGVhZGVyPy5zdGF0dXMsXG4gICAgICAgICAgICBjYWxsYmFja1xuICAgICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUkVQTEFDRVxuICAgKlxuICAgKiBSZXBsYWNlcyB0aGUgZ2l2ZW4gX2tleV8gYW5kIF92YWx1ZV8gdG8gbWVtY2FjaGUuIFRoZSBvcGVyYXRpb24gb25seSBzdWNjZWVkc1xuICAgKiBpZiB0aGUga2V5IGlzIGFscmVhZHkgcHJlc2VudC5cbiAgICpcbiAgICogVGhlIG9wdGlvbnMgZGljdGlvbmFyeSB0YWtlczpcbiAgICogKiBfZXhwaXJlc186IG92ZXJyaWRlcyB0aGUgZGVmYXVsdCBleHBpcmF0aW9uIChzZWUgYENsaWVudC5jcmVhdGVgKSBmb3IgdGhpc1xuICAgKiAgICAgICAgICAgICAgcGFydGljdWxhciBrZXktdmFsdWUgcGFpci5cbiAgICpcbiAgICogVGhlIGNhbGxiYWNrIHNpZ25hdHVyZSBpczpcbiAgICpcbiAgICogICAgIGNhbGxiYWNrKGVyciwgc3VjY2VzcylcbiAgICogQHBhcmFtIGtleVxuICAgKiBAcGFyYW0gdmFsdWVcbiAgICogQHBhcmFtIG9wdGlvbnNcbiAgICogQHBhcmFtIGNhbGxiYWNrXG4gICAqL1xuICByZXBsYWNlKFxuICAgIGtleTogc3RyaW5nLFxuICAgIHZhbHVlOiBWYWx1ZSxcbiAgICBvcHRpb25zPzogeyBleHBpcmVzPzogbnVtYmVyIH0sXG4gICAgY2FsbGJhY2s/OiAoZXJyb3I6IEVycm9yIHwgbnVsbCwgc3VjY2VzczogYm9vbGVhbiB8IG51bGwpID0+IHZvaWRcbiAgKTogUHJvbWlzZTxib29sZWFuIHwgbnVsbD4gfCB2b2lkIHtcbiAgICBpZiAoY2FsbGJhY2sgPT09IHVuZGVmaW5lZCAmJiBvcHRpb25zICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGlmICghb3B0aW9ucykgb3B0aW9ucyA9IHt9O1xuICAgICAgcmV0dXJuIHByb21pc2lmeSgoY2FsbGJhY2spID0+IHtcbiAgICAgICAgdGhpcy5yZXBsYWNlKFxuICAgICAgICAgIGtleSxcbiAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICBvcHRpb25zIGFzIHsgZXhwaXJlcz86IG51bWJlciB9LFxuICAgICAgICAgIGZ1bmN0aW9uIChlcnIsIHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVyciwgc3VjY2Vzcyk7XG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gVE9ETzogc3VwcG9ydCBmbGFncywgc3VwcG9ydCB2ZXJzaW9uIChDQVMpXG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgY29uc3QgZXhwaXJhdGlvbiA9IG1ha2VFeHBpcmF0aW9uKFxuICAgICAgKG9wdGlvbnMgfHwge30pLmV4cGlyZXMgfHwgdGhpcy5vcHRpb25zLmV4cGlyZXNcbiAgICApO1xuICAgIGNvbnN0IGV4dHJhcyA9IEJ1ZmZlci5jb25jYXQoW0J1ZmZlci5mcm9tKFwiMDAwMDAwMDBcIiwgXCJoZXhcIiksIGV4cGlyYXRpb25dKTtcblxuICAgIGNvbnN0IG9wY29kZTogY29uc3RhbnRzLk9QID0gMztcbiAgICBjb25zdCBzZXJpYWxpemVkID0gdGhpcy5zZXJpYWxpemVyLnNlcmlhbGl6ZShvcGNvZGUsIHZhbHVlLCBleHRyYXMpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSBtYWtlUmVxdWVzdEJ1ZmZlcihcbiAgICAgIG9wY29kZSxcbiAgICAgIGtleSxcbiAgICAgIHNlcmlhbGl6ZWQuZXh0cmFzLFxuICAgICAgc2VyaWFsaXplZC52YWx1ZSxcbiAgICAgIHRoaXMuc2VxXG4gICAgKTtcbiAgICB0aGlzLnBlcmZvcm0oa2V5LCByZXF1ZXN0LCB0aGlzLnNlcSwgKGVyciwgcmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzKSB7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuU1VDQ0VTUzpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHRydWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBSZXNwb25zZVN0YXR1cy5LRVlfTk9UX0ZPVU5EOlxuICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwgZmFsc2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aGlzLmhhbmRsZVJlc3BvbnNlRXJyb3IoXG4gICAgICAgICAgICBcIlJFUExBQ0VcIixcbiAgICAgICAgICAgIHJlc3BvbnNlPy5oZWFkZXI/LnN0YXR1cyxcbiAgICAgICAgICAgIGNhbGxiYWNrXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBERUxFVEVcbiAgICpcbiAgICogRGVsZXRlcyB0aGUgZ2l2ZW4gX2tleV8gZnJvbSBtZW1jYWNoZS4gVGhlIG9wZXJhdGlvbiBvbmx5IHN1Y2NlZWRzXG4gICAqIGlmIHRoZSBrZXkgaXMgYWxyZWFkeSBwcmVzZW50LlxuICAgKlxuICAgKiBUaGUgY2FsbGJhY2sgc2lnbmF0dXJlIGlzOlxuICAgKlxuICAgKiAgICAgY2FsbGJhY2soZXJyLCBzdWNjZXNzKVxuICAgKiBAcGFyYW0ga2V5XG4gICAqIEBwYXJhbSBjYWxsYmFja1xuICAgKi9cbiAgZGVsZXRlKGtleTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPjtcbiAgZGVsZXRlKFxuICAgIGtleTogc3RyaW5nLFxuICAgIGNhbGxiYWNrOiAoZXJyOiBFcnJvciB8IG51bGwsIHN1Y2Nlc3M6IGJvb2xlYW4gfCBudWxsKSA9PiB2b2lkXG4gICk6IHZvaWQ7XG4gIGRlbGV0ZShcbiAgICBrZXk6IHN0cmluZyxcbiAgICBjYWxsYmFjaz86IChlcnI6IEVycm9yIHwgbnVsbCwgc3VjY2VzczogYm9vbGVhbiB8IG51bGwpID0+IHZvaWRcbiAgKTogUHJvbWlzZTxib29sZWFuPiB8IHZvaWQge1xuICAgIGlmIChjYWxsYmFjayA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gcHJvbWlzaWZ5KChjYWxsYmFjaykgPT4ge1xuICAgICAgICB0aGlzLmRlbGV0ZShrZXksIGZ1bmN0aW9uIChlcnIsIHN1Y2Nlc3MpIHtcbiAgICAgICAgICBjYWxsYmFjayhlcnIsIEJvb2xlYW4oc3VjY2VzcykpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICAvLyBUT0RPOiBTdXBwb3J0IHZlcnNpb24gKENBUylcbiAgICB0aGlzLmluY3JTZXEoKTtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWFrZVJlcXVlc3RCdWZmZXIoNCwga2V5LCBcIlwiLCBcIlwiLCB0aGlzLnNlcSk7XG4gICAgdGhpcy5wZXJmb3JtKGtleSwgcmVxdWVzdCwgdGhpcy5zZXEsIChlcnIsIHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChyZXNwb25zZSEuaGVhZGVyLnN0YXR1cykge1xuICAgICAgICBjYXNlIFJlc3BvbnNlU3RhdHVzLlNVQ0NFU1M6XG4gICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhudWxsLCB0cnVlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuS0VZX05PVF9GT1VORDpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGZhbHNlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhpcy5oYW5kbGVSZXNwb25zZUVycm9yKFwiREVMRVRFXCIsIHJlc3BvbnNlPy5oZWFkZXIuc3RhdHVzLCBjYWxsYmFjayk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogSU5DUkVNRU5UXG4gICAqXG4gICAqIEluY3JlbWVudHMgdGhlIGdpdmVuIF9rZXlfIGluIG1lbWNhY2hlLlxuICAgKlxuICAgKiBUaGUgb3B0aW9ucyBkaWN0aW9uYXJ5IHRha2VzOlxuICAgKiAqIF9pbml0aWFsXzogdGhlIHZhbHVlIGZvciB0aGUga2V5IGlmIG5vdCBhbHJlYWR5IHByZXNlbnQsIGRlZmF1bHRzIHRvIDAuXG4gICAqICogX2V4cGlyZXNfOiBvdmVycmlkZXMgdGhlIGRlZmF1bHQgZXhwaXJhdGlvbiAoc2VlIGBDbGllbnQuY3JlYXRlYCkgZm9yIHRoaXNcbiAgICogICAgICAgICAgICAgIHBhcnRpY3VsYXIga2V5LXZhbHVlIHBhaXIuXG4gICAqXG4gICAqIFRoZSBjYWxsYmFjayBzaWduYXR1cmUgaXM6XG4gICAqXG4gICAqICAgICBjYWxsYmFjayhlcnIsIHN1Y2Nlc3MsIHZhbHVlKVxuICAgKiBAcGFyYW0ga2V5XG4gICAqIEBwYXJhbSBhbW91bnRcbiAgICogQHBhcmFtIG9wdGlvbnNcbiAgICogQHBhcmFtIGNhbGxiYWNrXG4gICAqL1xuICBpbmNyZW1lbnQoXG4gICAga2V5OiBzdHJpbmcsXG4gICAgYW1vdW50OiBudW1iZXIsXG4gICAgb3B0aW9uczogeyBpbml0aWFsPzogbnVtYmVyOyBleHBpcmVzPzogbnVtYmVyIH1cbiAgKTogUHJvbWlzZTx7IHZhbHVlOiBudW1iZXIgfCBudWxsOyBzdWNjZXNzOiBib29sZWFuIHwgbnVsbCB9PjtcbiAgaW5jcmVtZW50KFxuICAgIGtleTogc3RyaW5nLFxuICAgIGFtb3VudDogbnVtYmVyLFxuICAgIG9wdGlvbnM6IHsgaW5pdGlhbD86IG51bWJlcjsgZXhwaXJlcz86IG51bWJlciB9LFxuICAgIGNhbGxiYWNrOiAoXG4gICAgICBlcnJvcjogRXJyb3IgfCBudWxsLFxuICAgICAgc3VjY2VzczogYm9vbGVhbiB8IG51bGwsXG4gICAgICB2YWx1ZT86IG51bWJlciB8IG51bGxcbiAgICApID0+IHZvaWRcbiAgKTogdm9pZDtcbiAgaW5jcmVtZW50KFxuICAgIGtleTogc3RyaW5nLFxuICAgIGFtb3VudDogbnVtYmVyLFxuICAgIG9wdGlvbnM6IHsgaW5pdGlhbD86IG51bWJlcjsgZXhwaXJlcz86IG51bWJlciB9LFxuICAgIGNhbGxiYWNrPzogKFxuICAgICAgZXJyb3I6IEVycm9yIHwgbnVsbCxcbiAgICAgIHN1Y2Nlc3M6IGJvb2xlYW4gfCBudWxsLFxuICAgICAgdmFsdWU/OiBudW1iZXIgfCBudWxsXG4gICAgKSA9PiB2b2lkXG4gICk6IFByb21pc2U8eyB2YWx1ZTogbnVtYmVyIHwgbnVsbDsgc3VjY2VzczogYm9vbGVhbiB8IG51bGwgfT4gfCB2b2lkIHtcbiAgICBpZiAoY2FsbGJhY2sgPT09IHVuZGVmaW5lZCAmJiBvcHRpb25zICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIHJldHVybiBwcm9taXNpZnkoKGNhbGxiYWNrKSA9PiB7XG4gICAgICAgIGlmICghb3B0aW9ucykgb3B0aW9ucyA9IHt9O1xuICAgICAgICB0aGlzLmluY3JlbWVudChrZXksIGFtb3VudCwgb3B0aW9ucywgZnVuY3Rpb24gKGVyciwgc3VjY2VzcywgdmFsdWUpIHtcbiAgICAgICAgICBjYWxsYmFjayhlcnIsIHsgc3VjY2Vzczogc3VjY2VzcywgdmFsdWU6IHZhbHVlIHx8IG51bGwgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gVE9ETzogc3VwcG9ydCB2ZXJzaW9uIChDQVMpXG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgY29uc3QgaW5pdGlhbCA9IG9wdGlvbnMuaW5pdGlhbCB8fCAwO1xuICAgIGNvbnN0IGV4cGlyZXMgPSBvcHRpb25zLmV4cGlyZXMgfHwgdGhpcy5vcHRpb25zLmV4cGlyZXM7XG4gICAgY29uc3QgZXh0cmFzID0gbWFrZUFtb3VudEluaXRpYWxBbmRFeHBpcmF0aW9uKGFtb3VudCwgaW5pdGlhbCwgZXhwaXJlcyk7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1ha2VSZXF1ZXN0QnVmZmVyKFxuICAgICAgY29uc3RhbnRzLk9QX0lOQ1JFTUVOVCxcbiAgICAgIGtleSxcbiAgICAgIGV4dHJhcyxcbiAgICAgIFwiXCIsXG4gICAgICB0aGlzLnNlcVxuICAgICk7XG4gICAgdGhpcy5wZXJmb3JtKGtleSwgcmVxdWVzdCwgdGhpcy5zZXEsIChlcnIsIHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChyZXNwb25zZSEuaGVhZGVyLnN0YXR1cykge1xuICAgICAgICBjYXNlIFJlc3BvbnNlU3RhdHVzLlNVQ0NFU1M6XG4gICAgICAgICAgY29uc3QgYnVmSW50ID1cbiAgICAgICAgICAgIChyZXNwb25zZSEudmFsLnJlYWRVSW50MzJCRSgwKSA8PCA4KSArXG4gICAgICAgICAgICByZXNwb25zZSEudmFsLnJlYWRVSW50MzJCRSg0KTtcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHRydWUsIGJ1ZkludCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIGNvbnN0IGVycm9yID0gdGhpcy5oYW5kbGVSZXNwb25zZUVycm9yKFxuICAgICAgICAgICAgXCJJTkNSRU1FTlRcIixcbiAgICAgICAgICAgIHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzLFxuICAgICAgICAgICAgdW5kZWZpbmVkXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVycm9yLCBudWxsLCBudWxsKTtcbiAgICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBERUNSRU1FTlRcbiAgLy9cbiAgLy8gRGVjcmVtZW50cyB0aGUgZ2l2ZW4gX2tleV8gaW4gbWVtY2FjaGUuXG4gIC8vXG4gIC8vIFRoZSBvcHRpb25zIGRpY3Rpb25hcnkgdGFrZXM6XG4gIC8vICogX2luaXRpYWxfOiB0aGUgdmFsdWUgZm9yIHRoZSBrZXkgaWYgbm90IGFscmVhZHkgcHJlc2VudCwgZGVmYXVsdHMgdG8gMC5cbiAgLy8gKiBfZXhwaXJlc186IG92ZXJyaWRlcyB0aGUgZGVmYXVsdCBleHBpcmF0aW9uIChzZWUgYENsaWVudC5jcmVhdGVgKSBmb3IgdGhpc1xuICAvLyAgICAgICAgICAgICAgcGFydGljdWxhciBrZXktdmFsdWUgcGFpci5cbiAgLy9cbiAgLy8gVGhlIGNhbGxiYWNrIHNpZ25hdHVyZSBpczpcbiAgLy9cbiAgLy8gICAgIGNhbGxiYWNrKGVyciwgc3VjY2VzcywgdmFsdWUpXG4gIGRlY3JlbWVudChcbiAgICBrZXk6IHN0cmluZyxcbiAgICBhbW91bnQ6IG51bWJlcixcbiAgICBvcHRpb25zOiB7IGluaXRpYWw/OiBudW1iZXI7IGV4cGlyZXM/OiBudW1iZXIgfVxuICApOiBQcm9taXNlPHsgdmFsdWU6IG51bWJlciB8IG51bGw7IHN1Y2Nlc3M6IGJvb2xlYW4gfCBudWxsIH0+O1xuICBkZWNyZW1lbnQoXG4gICAga2V5OiBzdHJpbmcsXG4gICAgYW1vdW50OiBudW1iZXIsXG4gICAgb3B0aW9uczogeyBpbml0aWFsPzogbnVtYmVyOyBleHBpcmVzPzogbnVtYmVyIH0sXG4gICAgY2FsbGJhY2s6IChcbiAgICAgIGVycm9yOiBFcnJvciB8IG51bGwsXG4gICAgICBzdWNjZXNzOiBib29sZWFuIHwgbnVsbCxcbiAgICAgIHZhbHVlPzogbnVtYmVyIHwgbnVsbFxuICAgICkgPT4gdm9pZFxuICApOiB2b2lkO1xuICBkZWNyZW1lbnQoXG4gICAga2V5OiBzdHJpbmcsXG4gICAgYW1vdW50OiBudW1iZXIsXG4gICAgb3B0aW9uczogeyBpbml0aWFsPzogbnVtYmVyOyBleHBpcmVzPzogbnVtYmVyIH0sXG4gICAgY2FsbGJhY2s/OiAoXG4gICAgICBlcnJvcjogRXJyb3IgfCBudWxsLFxuICAgICAgc3VjY2VzczogYm9vbGVhbiB8IG51bGwsXG4gICAgICB2YWx1ZT86IG51bWJlciB8IG51bGxcbiAgICApID0+IHZvaWRcbiAgKTogUHJvbWlzZTx7IHZhbHVlOiBudW1iZXIgfCBudWxsOyBzdWNjZXNzOiBib29sZWFuIHwgbnVsbCB9PiB8IHZvaWQge1xuICAgIGlmIChjYWxsYmFjayA9PT0gdW5kZWZpbmVkICYmIG9wdGlvbnMgIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgcmV0dXJuIHByb21pc2lmeSgoY2FsbGJhY2spID0+IHtcbiAgICAgICAgdGhpcy5kZWNyZW1lbnQoa2V5LCBhbW91bnQsIG9wdGlvbnMsIGZ1bmN0aW9uIChlcnIsIHN1Y2Nlc3MsIHZhbHVlKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCB7IHN1Y2Nlc3M6IHN1Y2Nlc3MsIHZhbHVlOiB2YWx1ZSB8fCBudWxsIH0pO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICAvLyBUT0RPOiBzdXBwb3J0IHZlcnNpb24gKENBUylcbiAgICB0aGlzLmluY3JTZXEoKTtcbiAgICBjb25zdCBpbml0aWFsID0gb3B0aW9ucy5pbml0aWFsIHx8IDA7XG4gICAgY29uc3QgZXhwaXJlcyA9IG9wdGlvbnMuZXhwaXJlcyB8fCB0aGlzLm9wdGlvbnMuZXhwaXJlcztcbiAgICBjb25zdCBleHRyYXMgPSBtYWtlQW1vdW50SW5pdGlhbEFuZEV4cGlyYXRpb24oYW1vdW50LCBpbml0aWFsLCBleHBpcmVzKTtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWFrZVJlcXVlc3RCdWZmZXIoXG4gICAgICBjb25zdGFudHMuT1BfREVDUkVNRU5ULFxuICAgICAga2V5LFxuICAgICAgZXh0cmFzLFxuICAgICAgXCJcIixcbiAgICAgIHRoaXMuc2VxXG4gICAgKTtcbiAgICB0aGlzLnBlcmZvcm0oa2V5LCByZXF1ZXN0LCB0aGlzLnNlcSwgKGVyciwgcmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzKSB7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuU1VDQ0VTUzpcbiAgICAgICAgICBjb25zdCBidWZJbnQgPVxuICAgICAgICAgICAgKHJlc3BvbnNlIS52YWwucmVhZFVJbnQzMkJFKDApIDw8IDgpICtcbiAgICAgICAgICAgIHJlc3BvbnNlIS52YWwucmVhZFVJbnQzMkJFKDQpO1xuICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwgdHJ1ZSwgYnVmSW50KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgY29uc3QgZXJyb3IgPSB0aGlzLmhhbmRsZVJlc3BvbnNlRXJyb3IoXG4gICAgICAgICAgICBcIkRFQ1JFTUVOVFwiLFxuICAgICAgICAgICAgcmVzcG9uc2UhLmhlYWRlci5zdGF0dXMsXG4gICAgICAgICAgICB1bmRlZmluZWRcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgY2FsbGJhY2soZXJyb3IsIG51bGwsIG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBUFBFTkRcbiAgICpcbiAgICogQXBwZW5kIHRoZSBnaXZlbiBfdmFsdWVfIHRvIHRoZSB2YWx1ZSBhc3NvY2lhdGVkIHdpdGggdGhlIGdpdmVuIF9rZXlfIGluXG4gICAqIG1lbWNhY2hlLiBUaGUgb3BlcmF0aW9uIG9ubHkgc3VjY2VlZHMgaWYgdGhlIGtleSBpcyBhbHJlYWR5IHByZXNlbnQuIFRoZVxuICAgKiBjYWxsYmFjayBzaWduYXR1cmUgaXM6XG4gICAqXG4gICAqICAgICBjYWxsYmFjayhlcnIsIHN1Y2Nlc3MpXG4gICAqIEBwYXJhbSBrZXlcbiAgICogQHBhcmFtIHZhbHVlXG4gICAqIEBwYXJhbSBjYWxsYmFja1xuICAgKi9cbiAgYXBwZW5kKGtleTogc3RyaW5nLCB2YWx1ZTogVmFsdWUpOiBQcm9taXNlPGJvb2xlYW4+O1xuICBhcHBlbmQoXG4gICAga2V5OiBzdHJpbmcsXG4gICAgdmFsdWU6IFZhbHVlLFxuICAgIGNhbGxiYWNrOiAoZXJyOiBFcnJvciB8IG51bGwsIHN1Y2Nlc3M6IGJvb2xlYW4gfCBudWxsKSA9PiB2b2lkXG4gICk6IHZvaWQ7XG4gIGFwcGVuZChcbiAgICBrZXk6IHN0cmluZyxcbiAgICB2YWx1ZTogVmFsdWUsXG4gICAgY2FsbGJhY2s/OiAoZXJyOiBFcnJvciB8IG51bGwsIHN1Y2Nlc3M6IGJvb2xlYW4gfCBudWxsKSA9PiB2b2lkXG4gICkge1xuICAgIGlmIChjYWxsYmFjayA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gcHJvbWlzaWZ5KChjYWxsYmFjaykgPT4ge1xuICAgICAgICB0aGlzLmFwcGVuZChrZXksIHZhbHVlLCBmdW5jdGlvbiAoZXJyLCBzdWNjZXNzKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBzdWNjZXNzKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgLy8gVE9ETzogc3VwcG9ydCB2ZXJzaW9uIChDQVMpXG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgY29uc3Qgb3Bjb2RlOiBjb25zdGFudHMuT1AgPSBjb25zdGFudHMuT1BfQVBQRU5EO1xuICAgIGNvbnN0IHNlcmlhbGl6ZWQgPSB0aGlzLnNlcmlhbGl6ZXIuc2VyaWFsaXplKG9wY29kZSwgdmFsdWUsIFwiXCIpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSBtYWtlUmVxdWVzdEJ1ZmZlcihcbiAgICAgIG9wY29kZSxcbiAgICAgIGtleSxcbiAgICAgIHNlcmlhbGl6ZWQuZXh0cmFzLFxuICAgICAgc2VyaWFsaXplZC52YWx1ZSxcbiAgICAgIHRoaXMuc2VxXG4gICAgKTtcbiAgICB0aGlzLnBlcmZvcm0oa2V5LCByZXF1ZXN0LCB0aGlzLnNlcSwgKGVyciwgcmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzKSB7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuU1VDQ0VTUzpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHRydWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBSZXNwb25zZVN0YXR1cy5LRVlfTk9UX0ZPVU5EOlxuICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwgZmFsc2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aGlzLmhhbmRsZVJlc3BvbnNlRXJyb3IoXCJBUFBFTkRcIiwgcmVzcG9uc2UhLmhlYWRlci5zdGF0dXMsIGNhbGxiYWNrKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBQUkVQRU5EXG4gICAqXG4gICAqIFByZXBlbmQgdGhlIGdpdmVuIF92YWx1ZV8gdG8gdGhlIHZhbHVlIGFzc29jaWF0ZWQgd2l0aCB0aGUgZ2l2ZW4gX2tleV8gaW5cbiAgICogbWVtY2FjaGUuIFRoZSBvcGVyYXRpb24gb25seSBzdWNjZWVkcyBpZiB0aGUga2V5IGlzIGFscmVhZHkgcHJlc2VudC4gVGhlXG4gICAqIGNhbGxiYWNrIHNpZ25hdHVyZSBpczpcbiAgICpcbiAgICogICAgIGNhbGxiYWNrKGVyciwgc3VjY2VzcylcbiAgICogQHBhcmFtIGtleVxuICAgKiBAcGFyYW0gdmFsdWVcbiAgICogQHBhcmFtIGNhbGxiYWNrXG4gICAqL1xuICBwcmVwZW5kKGtleTogc3RyaW5nLCB2YWx1ZTogVmFsdWUpOiBQcm9taXNlPGJvb2xlYW4+O1xuICBwcmVwZW5kKFxuICAgIGtleTogc3RyaW5nLFxuICAgIHZhbHVlOiBWYWx1ZSxcbiAgICBjYWxsYmFjazogKGVycjogRXJyb3IgfCBudWxsLCBzdWNjZXNzOiBib29sZWFuIHwgbnVsbCkgPT4gdm9pZFxuICApOiB2b2lkO1xuICBwcmVwZW5kKFxuICAgIGtleTogc3RyaW5nLFxuICAgIHZhbHVlOiBWYWx1ZSxcbiAgICBjYWxsYmFjaz86IChlcnI6IEVycm9yIHwgbnVsbCwgc3VjY2VzczogYm9vbGVhbiB8IG51bGwpID0+IHZvaWRcbiAgKSB7XG4gICAgaWYgKGNhbGxiYWNrID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBwcm9taXNpZnkoKGNhbGxiYWNrKSA9PiB7XG4gICAgICAgIHRoaXMucHJlcGVuZChrZXksIHZhbHVlLCBmdW5jdGlvbiAoZXJyLCBzdWNjZXNzKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBzdWNjZXNzKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgLy8gVE9ETzogc3VwcG9ydCB2ZXJzaW9uIChDQVMpXG4gICAgdGhpcy5pbmNyU2VxKCk7XG5cbiAgICBjb25zdCBvcGNvZGU6IGNvbnN0YW50cy5PUCA9IGNvbnN0YW50cy5PUF9QUkVQRU5EO1xuICAgIGNvbnN0IHNlcmlhbGl6ZWQgPSB0aGlzLnNlcmlhbGl6ZXIuc2VyaWFsaXplKG9wY29kZSwgdmFsdWUsIFwiXCIpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSBtYWtlUmVxdWVzdEJ1ZmZlcihcbiAgICAgIG9wY29kZSxcbiAgICAgIGtleSxcbiAgICAgIHNlcmlhbGl6ZWQuZXh0cmFzLFxuICAgICAgc2VyaWFsaXplZC52YWx1ZSxcbiAgICAgIHRoaXMuc2VxXG4gICAgKTtcbiAgICB0aGlzLnBlcmZvcm0oa2V5LCByZXF1ZXN0LCB0aGlzLnNlcSwgKGVyciwgcmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzKSB7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuU1VDQ0VTUzpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHRydWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBSZXNwb25zZVN0YXR1cy5LRVlfTk9UX0ZPVU5EOlxuICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwgZmFsc2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aGlzLmhhbmRsZVJlc3BvbnNlRXJyb3IoXG4gICAgICAgICAgICBcIlBSRVBFTkRcIixcbiAgICAgICAgICAgIHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzLFxuICAgICAgICAgICAgY2FsbGJhY2tcbiAgICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFRPVUNIXG4gICAqXG4gICAqIFRvdWNoIHNldHMgYW4gZXhwaXJhdGlvbiB2YWx1ZSwgZ2l2ZW4gYnkgX2V4cGlyZXNfLCBvbiB0aGUgZ2l2ZW4gX2tleV8gaW5cbiAgICogbWVtY2FjaGUuIFRoZSBvcGVyYXRpb24gb25seSBzdWNjZWVkcyBpZiB0aGUga2V5IGlzIGFscmVhZHkgcHJlc2VudC4gVGhlXG4gICAqIGNhbGxiYWNrIHNpZ25hdHVyZSBpczpcbiAgICpcbiAgICogICAgIGNhbGxiYWNrKGVyciwgc3VjY2VzcylcbiAgICogQHBhcmFtIGtleVxuICAgKiBAcGFyYW0gZXhwaXJlc1xuICAgKiBAcGFyYW0gY2FsbGJhY2tcbiAgICovXG4gIHRvdWNoKGtleTogc3RyaW5nLCBleHBpcmVzOiBudW1iZXIpOiBQcm9taXNlPGJvb2xlYW4+O1xuICB0b3VjaChcbiAgICBrZXk6IHN0cmluZyxcbiAgICBleHBpcmVzOiBudW1iZXIsXG4gICAgY2FsbGJhY2s6IChlcnI6IEVycm9yIHwgbnVsbCwgc3VjY2VzczogYm9vbGVhbiB8IG51bGwpID0+IHZvaWRcbiAgKTogdm9pZDtcbiAgdG91Y2goXG4gICAga2V5OiBzdHJpbmcsXG4gICAgZXhwaXJlczogbnVtYmVyLFxuICAgIGNhbGxiYWNrPzogKGVycjogRXJyb3IgfCBudWxsLCBzdWNjZXNzOiBib29sZWFuIHwgbnVsbCkgPT4gdm9pZFxuICApOiBQcm9taXNlPGJvb2xlYW4+IHwgdm9pZCB7XG4gICAgaWYgKGNhbGxiYWNrID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBwcm9taXNpZnkoKGNhbGxiYWNrKSA9PiB7XG4gICAgICAgIHRoaXMudG91Y2goa2V5LCBleHBpcmVzLCBmdW5jdGlvbiAoZXJyLCBzdWNjZXNzKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCBCb29sZWFuKHN1Y2Nlc3MpKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgLy8gVE9ETzogc3VwcG9ydCB2ZXJzaW9uIChDQVMpXG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgY29uc3QgZXh0cmFzID0gbWFrZUV4cGlyYXRpb24oZXhwaXJlcyB8fCB0aGlzLm9wdGlvbnMuZXhwaXJlcyk7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1ha2VSZXF1ZXN0QnVmZmVyKDB4MWMsIGtleSwgZXh0cmFzLCBcIlwiLCB0aGlzLnNlcSk7XG4gICAgdGhpcy5wZXJmb3JtKGtleSwgcmVxdWVzdCwgdGhpcy5zZXEsIChlcnIsIHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChyZXNwb25zZSEuaGVhZGVyLnN0YXR1cykge1xuICAgICAgICBjYXNlIFJlc3BvbnNlU3RhdHVzLlNVQ0NFU1M6XG4gICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhudWxsLCB0cnVlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuS0VZX05PVF9GT1VORDpcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGZhbHNlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhpcy5oYW5kbGVSZXNwb25zZUVycm9yKFwiVE9VQ0hcIiwgcmVzcG9uc2UhLmhlYWRlci5zdGF0dXMsIGNhbGxiYWNrKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGTFVTSFxuICAgKlxuICAgKiBGbHVzaGVzIHRoZSBjYWNoZSBvbiBlYWNoIGNvbm5lY3RlZCBzZXJ2ZXIuIFRoZSBjYWxsYmFjayBzaWduYXR1cmUgaXM6XG4gICAqXG4gICAqICAgICBjYWxsYmFjayhsYXN0RXJyLCByZXN1bHRzKVxuICAgKlxuICAgKiB3aGVyZSBfbGFzdEVycl8gaXMgdGhlIGxhc3QgZXJyb3IgZW5jb3VudGVyZWQgKG9yIG51bGwsIGluIHRoZSBjb21tb24gY2FzZVxuICAgKiBvZiBubyBlcnJvcnMpLiBfcmVzdWx0c18gaXMgYSBkaWN0aW9uYXJ5IG1hcHBpbmcgYFwiaG9zdG5hbWU6cG9ydFwiYCB0byBlaXRoZXJcbiAgICogYHRydWVgIChpZiB0aGUgb3BlcmF0aW9uIHdhcyBzdWNjZXNzZnVsKSwgb3IgYW4gZXJyb3IuXG4gICAqIEBwYXJhbSBjYWxsYmFja1xuICAgKi9cbiAgZmx1c2goKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBib29sZWFuIHwgRXJyb3I+PjtcbiAgZmx1c2goXG4gICAgY2FsbGJhY2s6IChcbiAgICAgIGVycjogRXJyb3IgfCBudWxsLFxuICAgICAgcmVzdWx0czogUmVjb3JkPHN0cmluZywgYm9vbGVhbiB8IEVycm9yPlxuICAgICkgPT4gdm9pZFxuICApOiB2b2lkO1xuICBmbHVzaChcbiAgICBjYWxsYmFjaz86IChcbiAgICAgIGVycjogRXJyb3IgfCBudWxsLFxuICAgICAgcmVzdWx0czogUmVjb3JkPHN0cmluZywgYm9vbGVhbiB8IEVycm9yPlxuICAgICkgPT4gdm9pZFxuICApIHtcbiAgICBpZiAoY2FsbGJhY2sgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHByb21pc2lmeSgoY2FsbGJhY2spID0+IHtcbiAgICAgICAgdGhpcy5mbHVzaChmdW5jdGlvbiAoZXJyLCByZXN1bHRzKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCByZXN1bHRzKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgLy8gVE9ETzogc3VwcG9ydCBleHBpcmF0aW9uXG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1ha2VSZXF1ZXN0QnVmZmVyKDB4MDgsIFwiXCIsIFwiXCIsIFwiXCIsIHRoaXMuc2VxKTtcbiAgICBsZXQgY291bnQgPSB0aGlzLnNlcnZlcnMubGVuZ3RoO1xuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgYm9vbGVhbiB8IEVycm9yPiA9IHt9O1xuICAgIGxldCBsYXN0RXJyOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXG4gICAgY29uc3QgaGFuZGxlRmx1c2ggPSBmdW5jdGlvbiAoc2VxOiBudW1iZXIsIHNlcnY6IFNlcnZlcikge1xuICAgICAgc2Vydi5vblJlc3BvbnNlKHNlcSwgZnVuY3Rpb24gKC8qIHJlc3BvbnNlICovKSB7XG4gICAgICAgIGNvdW50IC09IDE7XG4gICAgICAgIHJlc3VsdFtzZXJ2Lmhvc3Rwb3J0U3RyaW5nKCldID0gdHJ1ZTtcbiAgICAgICAgaWYgKGNhbGxiYWNrICYmIGNvdW50ID09PSAwKSB7XG4gICAgICAgICAgY2FsbGJhY2sobGFzdEVyciwgcmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBzZXJ2Lm9uRXJyb3Ioc2VxLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGNvdW50IC09IDE7XG4gICAgICAgIGxhc3RFcnIgPSBlcnI7XG4gICAgICAgIHJlc3VsdFtzZXJ2Lmhvc3Rwb3J0U3RyaW5nKCldID0gZXJyO1xuICAgICAgICBpZiAoY2FsbGJhY2sgJiYgY291bnQgPT09IDApIHtcbiAgICAgICAgICBjYWxsYmFjayhsYXN0RXJyLCByZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHNlcnYud3JpdGUocmVxdWVzdCk7XG4gICAgfTtcblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5zZXJ2ZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBoYW5kbGVGbHVzaCh0aGlzLnNlcSwgdGhpcy5zZXJ2ZXJzW2ldKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU1RBVFNfV0lUSF9LRVlcbiAgICpcbiAgICogU2VuZHMgYSBtZW1jYWNoZSBzdGF0cyBjb21tYW5kIHdpdGggYSBrZXkgdG8gZWFjaCBjb25uZWN0ZWQgc2VydmVyLiBUaGVcbiAgICogY2FsbGJhY2sgaXMgaW52b2tlZCAqKk9OQ0UgUEVSIFNFUlZFUioqIGFuZCBoYXMgdGhlIHNpZ25hdHVyZTpcbiAgICpcbiAgICogICAgIGNhbGxiYWNrKGVyciwgc2VydmVyLCBzdGF0cylcbiAgICpcbiAgICogX3NlcnZlcl8gaXMgdGhlIGBcImhvc3RuYW1lOnBvcnRcImAgb2YgdGhlIHNlcnZlciwgYW5kIF9zdGF0c18gaXMgYSBkaWN0aW9uYXJ5XG4gICAqIG1hcHBpbmcgdGhlIHN0YXQgbmFtZSB0byB0aGUgdmFsdWUgb2YgdGhlIHN0YXRpc3RpYyBhcyBhIHN0cmluZy5cbiAgICogQHBhcmFtIGtleVxuICAgKiBAcGFyYW0gY2FsbGJhY2tcbiAgICovXG4gIHN0YXRzV2l0aEtleShcbiAgICBrZXk6IHN0cmluZyxcbiAgICBjYWxsYmFjaz86IChcbiAgICAgIGVycjogRXJyb3IgfCBudWxsLFxuICAgICAgc2VydmVyOiBzdHJpbmcsXG4gICAgICBzdGF0czogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IG51bGxcbiAgICApID0+IHZvaWRcbiAgKTogdm9pZCB7XG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1ha2VSZXF1ZXN0QnVmZmVyKDB4MTAsIGtleSwgXCJcIiwgXCJcIiwgdGhpcy5zZXEpO1xuXG4gICAgY29uc3QgaGFuZGxlU3RhdHMgPSAoc2VxOiBudW1iZXIsIHNlcnY6IFNlcnZlcikgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgICBjb25zdCBoYW5kbGU6IE9uUmVzcG9uc2VDYWxsYmFjayA9IChyZXNwb25zZSkgPT4ge1xuICAgICAgICAvLyBlbmQgb2Ygc3RhdCByZXNwb25zZXNcbiAgICAgICAgaWYgKHJlc3BvbnNlLmhlYWRlci50b3RhbEJvZHlMZW5ndGggPT09IDApIHtcbiAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHNlcnYuaG9zdHBvcnRTdHJpbmcoKSwgcmVzdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIC8vIHByb2Nlc3Mgc2luZ2xlIHN0YXQgbGluZSByZXNwb25zZVxuICAgICAgICBzd2l0Y2ggKHJlc3BvbnNlLmhlYWRlci5zdGF0dXMpIHtcbiAgICAgICAgICBjYXNlIFJlc3BvbnNlU3RhdHVzLlNVQ0NFU1M6XG4gICAgICAgICAgICByZXN1bHRbcmVzcG9uc2Uua2V5LnRvU3RyaW5nKCldID0gcmVzcG9uc2UudmFsLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgY29uc3QgZXJyb3IgPSB0aGlzLmhhbmRsZVJlc3BvbnNlRXJyb3IoXG4gICAgICAgICAgICAgIGBTVEFUUyAoJHtrZXl9KWAsXG4gICAgICAgICAgICAgIHJlc3BvbnNlLmhlYWRlci5zdGF0dXMsXG4gICAgICAgICAgICAgIHVuZGVmaW5lZFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgICBjYWxsYmFjayhlcnJvciwgc2Vydi5ob3N0cG9ydFN0cmluZygpLCBudWxsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGhhbmRsZS5xdWlldCA9IHRydWU7XG5cbiAgICAgIHNlcnYub25SZXNwb25zZShzZXEsIGhhbmRsZSk7XG4gICAgICBzZXJ2Lm9uRXJyb3Ioc2VxLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgc2Vydi5ob3N0cG9ydFN0cmluZygpLCBudWxsKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBzZXJ2LndyaXRlKHJlcXVlc3QpO1xuICAgIH07XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuc2VydmVycy5sZW5ndGg7IGkrKykge1xuICAgICAgaGFuZGxlU3RhdHModGhpcy5zZXEsIHRoaXMuc2VydmVyc1tpXSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNUQVRTXG4gICAqXG4gICAqIEZldGNoZXMgbWVtY2FjaGUgc3RhdHMgZnJvbSBlYWNoIGNvbm5lY3RlZCBzZXJ2ZXIuIFRoZSBjYWxsYmFjayBpcyBpbnZva2VkXG4gICAqICoqT05DRSBQRVIgU0VSVkVSKiogYW5kIGhhcyB0aGUgc2lnbmF0dXJlOlxuICAgKlxuICAgKiAgICAgY2FsbGJhY2soZXJyLCBzZXJ2ZXIsIHN0YXRzKVxuICAgKlxuICAgKiBfc2VydmVyXyBpcyB0aGUgYFwiaG9zdG5hbWU6cG9ydFwiYCBvZiB0aGUgc2VydmVyLCBhbmQgX3N0YXRzXyBpcyBhXG4gICAqIGRpY3Rpb25hcnkgbWFwcGluZyB0aGUgc3RhdCBuYW1lIHRvIHRoZSB2YWx1ZSBvZiB0aGUgc3RhdGlzdGljIGFzIGEgc3RyaW5nLlxuICAgKiBAcGFyYW0gY2FsbGJhY2tcbiAgICovXG4gIHN0YXRzKFxuICAgIGNhbGxiYWNrPzogKFxuICAgICAgZXJyOiBFcnJvciB8IG51bGwsXG4gICAgICBzZXJ2ZXI6IHN0cmluZyxcbiAgICAgIHN0YXRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgbnVsbFxuICAgICkgPT4gdm9pZFxuICApOiB2b2lkIHtcbiAgICB0aGlzLnN0YXRzV2l0aEtleShcIlwiLCBjYWxsYmFjayk7XG4gIH1cblxuICAvKipcbiAgICogUkVTRVRfU1RBVFNcbiAgICpcbiAgICogUmVzZXQgdGhlIHN0YXRpc3RpY3MgZWFjaCBzZXJ2ZXIgaXMga2VlcGluZyBiYWNrIHRvIHplcm8uIFRoaXMgZG9lc24ndCBjbGVhclxuICAgKiBzdGF0cyBzdWNoIGFzIGl0ZW0gY291bnQsIGJ1dCB0ZW1wb3Jhcnkgc3RhdHMgc3VjaCBhcyB0b3RhbCBudW1iZXIgb2ZcbiAgICogY29ubmVjdGlvbnMgb3ZlciB0aW1lLlxuICAgKlxuICAgKiBUaGUgY2FsbGJhY2sgaXMgaW52b2tlZCAqKk9OQ0UgUEVSIFNFUlZFUioqIGFuZCBoYXMgdGhlIHNpZ25hdHVyZTpcbiAgICpcbiAgICogICAgIGNhbGxiYWNrKGVyciwgc2VydmVyKVxuICAgKlxuICAgKiBfc2VydmVyXyBpcyB0aGUgYFwiaG9zdG5hbWU6cG9ydFwiYCBvZiB0aGUgc2VydmVyLlxuICAgKiBAcGFyYW0gY2FsbGJhY2tcbiAgICovXG4gIHJlc2V0U3RhdHMoXG4gICAgY2FsbGJhY2s/OiAoXG4gICAgICBlcnI6IEVycm9yIHwgbnVsbCxcbiAgICAgIHNlcnZlcjogc3RyaW5nLFxuICAgICAgc3RhdHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCBudWxsXG4gICAgKSA9PiB2b2lkXG4gICk6IHZvaWQge1xuICAgIHRoaXMuc3RhdHNXaXRoS2V5KFwicmVzZXRcIiwgY2FsbGJhY2spO1xuICB9XG5cbiAgLyoqXG4gICAqIFFVSVRcbiAgICpcbiAgICogQ2xvc2VzIHRoZSBjb25uZWN0aW9uIHRvIGVhY2ggc2VydmVyLCBub3RpZnlpbmcgdGhlbSBvZiB0aGlzIGludGVudGlvbi4gTm90ZVxuICAgKiB0aGF0IHF1aXQgY2FuIHJhY2UgYWdhaW5zdCBhbHJlYWR5IG91dHN0YW5kaW5nIHJlcXVlc3RzIHdoZW4gdGhvc2UgcmVxdWVzdHNcbiAgICogZmFpbCBhbmQgYXJlIHJldHJpZWQsIGxlYWRpbmcgdG8gdGhlIHF1aXQgY29tbWFuZCB3aW5uaW5nIGFuZCBjbG9zaW5nIHRoZVxuICAgKiBjb25uZWN0aW9uIGJlZm9yZSB0aGUgcmV0cmllcyBjb21wbGV0ZS5cbiAgICovXG4gIHF1aXQoKSB7XG4gICAgdGhpcy5pbmNyU2VxKCk7XG4gICAgLy8gVE9ETzogTmljZXIgcGVyaGFwcyB0byBkbyBRVUlUUSAoMHgxNykgYnV0IG5lZWQgYSBuZXcgY2FsbGJhY2sgZm9yIHdoZW5cbiAgICAvLyB3cml0ZSBpcyBkb25lLlxuICAgIGNvbnN0IHJlcXVlc3QgPSBtYWtlUmVxdWVzdEJ1ZmZlcigweDA3LCBcIlwiLCBcIlwiLCBcIlwiLCB0aGlzLnNlcSk7IC8vIFFVSVRcbiAgICBsZXQgc2VydjtcblxuICAgIGNvbnN0IGhhbmRsZVF1aXQgPSBmdW5jdGlvbiAoc2VxOiBudW1iZXIsIHNlcnY6IFNlcnZlcikge1xuICAgICAgc2Vydi5vblJlc3BvbnNlKHNlcSwgZnVuY3Rpb24gKC8qIHJlc3BvbnNlICovKSB7XG4gICAgICAgIHNlcnYuY2xvc2UoKTtcbiAgICAgIH0pO1xuICAgICAgc2Vydi5vbkVycm9yKHNlcSwgZnVuY3Rpb24gKC8qIGVyciAqLykge1xuICAgICAgICBzZXJ2LmNsb3NlKCk7XG4gICAgICB9KTtcbiAgICAgIHNlcnYud3JpdGUocmVxdWVzdCk7XG4gICAgfTtcblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5zZXJ2ZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBzZXJ2ID0gdGhpcy5zZXJ2ZXJzW2ldO1xuICAgICAgaGFuZGxlUXVpdCh0aGlzLnNlcSwgc2Vydik7XG4gICAgfVxuICB9XG5cbiAgX3ZlcnNpb24oc2VydmVyOiBTZXJ2ZXIpOiBQcm9taXNlPHsgdmFsdWU6IFZhbHVlIHwgbnVsbCB9PjtcbiAgX3ZlcnNpb24oXG4gICAgc2VydmVyOiBTZXJ2ZXIsXG4gICAgY2FsbGJhY2s6IChlcnJvcjogRXJyb3IgfCBudWxsLCB2YWx1ZTogVmFsdWUgfCBudWxsKSA9PiB2b2lkXG4gICk6IHZvaWQ7XG4gIF92ZXJzaW9uKFxuICAgIHNlcnZlcjogU2VydmVyLFxuICAgIGNhbGxiYWNrPzogKGVycm9yOiBFcnJvciB8IG51bGwsIHZhbHVlOiBWYWx1ZSB8IG51bGwpID0+IHZvaWRcbiAgKTogUHJvbWlzZTx7IHZhbHVlOiBWYWx1ZSB8IG51bGwgfT4gfCB2b2lkIHtcbiAgICBpZiAoY2FsbGJhY2sgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHByb21pc2lmeSgoY2FsbGJhY2spID0+IHtcbiAgICAgICAgdGhpcy5fdmVyc2lvbihzZXJ2ZXIsIGZ1bmN0aW9uIChlcnIsIHZhbHVlKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyLCB7IHZhbHVlOiB2YWx1ZSB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLmluY3JTZXEoKTtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWFrZVJlcXVlc3RCdWZmZXIoXG4gICAgICBjb25zdGFudHMuT1BfVkVSU0lPTixcbiAgICAgIFwiXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJcIixcbiAgICAgIHRoaXMuc2VxXG4gICAgKTtcblxuICAgIHRoaXMucGVyZm9ybU9uU2VydmVyKHNlcnZlciwgcmVxdWVzdCwgdGhpcy5zZXEsIChlcnIsIHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzd2l0Y2ggKHJlc3BvbnNlIS5oZWFkZXIuc3RhdHVzKSB7XG4gICAgICAgIGNhc2UgUmVzcG9uc2VTdGF0dXMuU1VDQ0VTUzpcbiAgICAgICAgICAvKiBUT0RPOiB0aGlzIGlzIGJ1Z2dlZCwgd2Ugc2hvdWxkJ3QgdXNlIHRoZSBkZXNlcmlhbGl6ZXIgaGVyZSwgc2luY2UgdmVyc2lvbiBhbHdheXMgcmV0dXJucyBhIHZlcnNpb24gc3RyaW5nLlxuICAgICAgICAgICAgIFRoZSBkZXNlcmlhbGl6ZXIgc2hvdWxkIG9ubHkgYmUgdXNlZCBvbiB1c2VyIGtleSBkYXRhLiAqL1xuICAgICAgICAgIGNvbnN0IGRlc2VyaWFsaXplZCA9IHRoaXMuc2VyaWFsaXplci5kZXNlcmlhbGl6ZShcbiAgICAgICAgICAgIHJlc3BvbnNlIS5oZWFkZXIub3Bjb2RlLFxuICAgICAgICAgICAgcmVzcG9uc2UhLnZhbCxcbiAgICAgICAgICAgIHJlc3BvbnNlIS5leHRyYXNcbiAgICAgICAgICApO1xuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGRlc2VyaWFsaXplZC52YWx1ZSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhpcy5oYW5kbGVSZXNwb25zZUVycm9yKFxuICAgICAgICAgICAgXCJWRVJTSU9OXCIsXG4gICAgICAgICAgICByZXNwb25zZSEuaGVhZGVyLnN0YXR1cyxcbiAgICAgICAgICAgIGNhbGxiYWNrXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBWRVJTSU9OXG4gICAqXG4gICAqIFJlcXVlc3QgdGhlIHNlcnZlciB2ZXJzaW9uIGZyb20gdGhlIFwiZmlyc3RcIiBzZXJ2ZXIgaW4gdGhlIGJhY2tlbmQgcG9vbC5cbiAgICpcbiAgICogVGhlIHNlcnZlciByZXNwb25kcyB3aXRoIGEgcGFja2V0IGNvbnRhaW5pbmcgdGhlIHZlcnNpb24gc3RyaW5nIGluIHRoZSBib2R5IHdpdGggdGhlIGZvbGxvd2luZyBmb3JtYXQ6IFwieC55LnpcIlxuICAgKi9cbiAgdmVyc2lvbigpOiBQcm9taXNlPHsgdmFsdWU6IFZhbHVlIHwgbnVsbCB9PjtcbiAgdmVyc2lvbihjYWxsYmFjazogKGVycm9yOiBFcnJvciB8IG51bGwsIHZhbHVlOiBWYWx1ZSB8IG51bGwpID0+IHZvaWQpOiB2b2lkO1xuICB2ZXJzaW9uKGNhbGxiYWNrPzogKGVycm9yOiBFcnJvciB8IG51bGwsIHZhbHVlOiBWYWx1ZSB8IG51bGwpID0+IHZvaWQpIHtcbiAgICBjb25zdCBzZXJ2ZXIgPSB0aGlzLnNlcnZlcktleVRvU2VydmVyKHRoaXMuc2VydmVyS2V5c1swXSk7XG4gICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICB0aGlzLl92ZXJzaW9uKHNlcnZlciwgY2FsbGJhY2spO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gdGhpcy5fdmVyc2lvbihzZXJ2ZXIpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBWRVJTSU9OLUFMTFxuICAgKlxuICAgKiBSZXRyaWV2ZXMgdGhlIHNlcnZlciB2ZXJzaW9uIGZyb20gYWxsIHRoZSBzZXJ2ZXJzXG4gICAqIGluIHRoZSBiYWNrZW5kIHBvb2wsIGVycm9ycyBpZiBhbnkgb25lIG9mIHRoZW0gaGFzIGFuXG4gICAqIGVycm9yXG4gICAqXG4gICAqIFRoZSBjYWxsYmFjayBzaWduYXR1cmUgaXM6XG4gICAqXG4gICAqICAgICBjYWxsYmFjayhlcnIsIHZhbHVlLCBmbGFncylcbiAgICpcbiAgICogQHBhcmFtIGtleXNcbiAgICogQHBhcmFtIGNhbGxiYWNrXG4gICAqL1xuICB2ZXJzaW9uQWxsKCk6IFByb21pc2U8e1xuICAgIHZhbHVlczogUmVjb3JkPHN0cmluZywgVmFsdWUgfCBudWxsPjtcbiAgfT47XG4gIHZlcnNpb25BbGwoXG4gICAgY2FsbGJhY2s6IChcbiAgICAgIGVycjogRXJyb3IgfCBudWxsLFxuICAgICAgdmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBWYWx1ZSB8IG51bGw+IHwgbnVsbFxuICAgICkgPT4gdm9pZFxuICApOiB2b2lkO1xuICB2ZXJzaW9uQWxsKFxuICAgIGNhbGxiYWNrPzogKFxuICAgICAgZXJyOiBFcnJvciB8IG51bGwsXG4gICAgICB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIFZhbHVlIHwgbnVsbD4gfCBudWxsXG4gICAgKSA9PiB2b2lkXG4gICk6IFByb21pc2U8e1xuICAgIHZhbHVlczogUmVjb3JkPHN0cmluZywgVmFsdWUgfCBudWxsPjtcbiAgfT4gfCB2b2lkIHtcbiAgICBjb25zdCBwcm9taXNlID0gUHJvbWlzZS5hbGwoXG4gICAgICB0aGlzLnNlcnZlcktleXMubWFwKChzZXJ2ZXJLZXkpID0+IHtcbiAgICAgICAgY29uc3Qgc2VydmVyID0gdGhpcy5zZXJ2ZXJLZXlUb1NlcnZlcihzZXJ2ZXJLZXkpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl92ZXJzaW9uKHNlcnZlcikudGhlbigocmVzcG9uc2UpID0+IHtcbiAgICAgICAgICByZXR1cm4geyBzZXJ2ZXJLZXk6IHNlcnZlcktleSwgdmFsdWU6IHJlc3BvbnNlLnZhbHVlIH07XG4gICAgICAgIH0pO1xuICAgICAgfSlcbiAgICApLnRoZW4oKHZlcnNpb25PYmplY3RzKSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZXMgPSB2ZXJzaW9uT2JqZWN0cy5yZWR1Y2UoKGFjY3VtdWxhdG9yLCB2ZXJzaW9uT2JqZWN0KSA9PiB7XG4gICAgICAgIGFjY3VtdWxhdG9yW3ZlcnNpb25PYmplY3Quc2VydmVyS2V5XSA9IHZlcnNpb25PYmplY3QudmFsdWU7XG4gICAgICAgIHJldHVybiBhY2N1bXVsYXRvcjtcbiAgICAgIH0sIHt9IGFzIFJlY29yZDxzdHJpbmcsIFZhbHVlIHwgbnVsbD4pO1xuICAgICAgcmV0dXJuIHsgdmFsdWVzOiB2YWx1ZXMgfTtcbiAgICB9KTtcblxuICAgIGlmIChjYWxsYmFjayA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICB9XG4gICAgcHJvbWlzZVxuICAgICAgLnRoZW4oKHJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3BvbnNlLnZhbHVlcyk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIENMT1NFXG4gICAqXG4gICAqIENsb3NlcyAoYWJydXB0bHkpIGNvbm5lY3Rpb25zIHRvIGFsbCB0aGUgc2VydmVycy5cbiAgICovXG4gIGNsb3NlKCkge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5zZXJ2ZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLnNlcnZlcnNbaV0uY2xvc2UoKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUGVyZm9ybSBhIGdlbmVyaWMgc2luZ2xlIHJlc3BvbnNlIG9wZXJhdGlvbiAoZ2V0LCBzZXQgZXRjKSBvbiBvbmUgc2VydmVyXG4gICAqXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBrZXkgdGhlIGtleSB0byBoYXNoIHRvIGdldCBhIHNlcnZlciBmcm9tIHRoZSBwb29sXG4gICAqIEBwYXJhbSB7YnVmZmVyfSByZXF1ZXN0IGEgYnVmZmVyIGNvbnRhaW5pbmcgdGhlIHJlcXVlc3RcbiAgICogQHBhcmFtIHtudW1iZXJ9IHNlcSB0aGUgc2VxdWVuY2UgbnVtYmVyIG9mIHRoZSBvcGVyYXRpb24uIEl0IGlzIHVzZWQgdG8gcGluIHRoZSBjYWxsYmFja3NcbiAgICAgICAgICAgICAgICAgICAgICAgICB0byBhIHNwZWNpZmljIG9wZXJhdGlvbiBhbmQgc2hvdWxkIG5ldmVyIGNoYW5nZSBkdXJpbmcgYSBgcGVyZm9ybWAuXG4gICAqIEBwYXJhbSB7Kn0gY2FsbGJhY2sgYSBjYWxsYmFjayBpbnZva2VkIHdoZW4gYSByZXNwb25zZSBpcyByZWNlaXZlZCBvciB0aGUgcmVxdWVzdCBmYWlsc1xuICAgKiBAcGFyYW0geyp9IHJldHJpZXMgbnVtYmVyIG9mIHRpbWVzIHRvIHJldHJ5IHJlcXVlc3Qgb24gZmFpbHVyZVxuICAgKi9cbiAgcGVyZm9ybShcbiAgICBrZXk6IHN0cmluZyxcbiAgICByZXF1ZXN0OiBCdWZmZXIsXG4gICAgc2VxOiBudW1iZXIsXG4gICAgY2FsbGJhY2s6IFJlc3BvbnNlT3JFcnJvckNhbGxiYWNrLFxuICAgIHJldHJpZXM/OiBudW1iZXJcbiAgKSB7XG4gICAgY29uc3Qgc2VydmVyS2V5ID0gdGhpcy5sb29rdXBLZXlUb1NlcnZlcktleShrZXkpO1xuXG4gICAgY29uc3Qgc2VydmVyID0gdGhpcy5zZXJ2ZXJLZXlUb1NlcnZlcihzZXJ2ZXJLZXkpO1xuXG4gICAgaWYgKCFzZXJ2ZXIpIHtcbiAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICBjYWxsYmFjayhuZXcgRXJyb3IoXCJObyBzZXJ2ZXJzIGF2YWlsYWJsZVwiKSwgbnVsbCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnBlcmZvcm1PblNlcnZlcihzZXJ2ZXIsIHJlcXVlc3QsIHNlcSwgY2FsbGJhY2ssIHJldHJpZXMpO1xuICB9XG5cbiAgcGVyZm9ybU9uU2VydmVyKFxuICAgIHNlcnZlcjogU2VydmVyLFxuICAgIHJlcXVlc3Q6IEJ1ZmZlcixcbiAgICBzZXE6IG51bWJlcixcbiAgICBjYWxsYmFjazogUmVzcG9uc2VPckVycm9yQ2FsbGJhY2ssXG4gICAgcmV0cmllczogbnVtYmVyID0gMFxuICApIHtcbiAgICBjb25zdCBfdGhpcyA9IHRoaXM7XG5cbiAgICByZXRyaWVzID0gcmV0cmllcyB8fCB0aGlzLm9wdGlvbnMucmV0cmllcztcbiAgICBjb25zdCBvcmlnUmV0cmllcyA9IHRoaXMub3B0aW9ucy5yZXRyaWVzO1xuICAgIGNvbnN0IGxvZ2dlciA9IHRoaXMub3B0aW9ucy5sb2dnZXI7XG4gICAgY29uc3QgcmV0cnlfZGVsYXkgPSB0aGlzLm9wdGlvbnMucmV0cnlfZGVsYXk7XG5cbiAgICBjb25zdCByZXNwb25zZUhhbmRsZXI6IE9uUmVzcG9uc2VDYWxsYmFjayA9IGZ1bmN0aW9uIChyZXNwb25zZSkge1xuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3QgZXJyb3JIYW5kbGVyOiBPbkVycm9yQ2FsbGJhY2sgPSBmdW5jdGlvbiAoZXJyb3IpIHtcbiAgICAgIGlmICgtLXJldHJpZXMgPiAwKSB7XG4gICAgICAgIC8vIFdhaXQgZm9yIHJldHJ5X2RlbGF5XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgIF90aGlzLnBlcmZvcm1PblNlcnZlcihzZXJ2ZXIsIHJlcXVlc3QsIHNlcSwgY2FsbGJhY2ssIHJldHJpZXMpO1xuICAgICAgICB9LCAxMDAwICogcmV0cnlfZGVsYXkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nZ2VyLmxvZyhcbiAgICAgICAgICBcIk1lbUpTOiBTZXJ2ZXIgPFwiICtcbiAgICAgICAgICAgIHNlcnZlci5ob3N0cG9ydFN0cmluZygpICtcbiAgICAgICAgICAgIFwiPiBmYWlsZWQgYWZ0ZXIgKFwiICtcbiAgICAgICAgICAgIG9yaWdSZXRyaWVzICtcbiAgICAgICAgICAgIFwiKSByZXRyaWVzIHdpdGggZXJyb3IgLSBcIiArXG4gICAgICAgICAgICBlcnJvci5tZXNzYWdlXG4gICAgICAgICk7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKGVycm9yLCBudWxsKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG5cbiAgICBzZXJ2ZXIub25SZXNwb25zZShzZXEsIHJlc3BvbnNlSGFuZGxlcik7XG4gICAgc2VydmVyLm9uRXJyb3Ioc2VxLCBlcnJvckhhbmRsZXIpO1xuICAgIHNlcnZlci53cml0ZShyZXF1ZXN0KTtcbiAgfVxuXG4gIC8vIEluY3JlbWVudCB0aGUgc2VxIHZhbHVlXG4gIGluY3JTZXEoKSB7XG4gICAgdGhpcy5zZXErKztcblxuICAgIC8vIFdyYXAgYHRoaXMuc2VxYCB0byAzMi1iaXRzIHNpbmNlIHRoZSBmaWVsZCB3ZSBmaXQgaXQgaW50byBpcyBvbmx5IDMyLWJpdHMuXG4gICAgdGhpcy5zZXEgJj0gMHhmZmZmZmZmZjtcbiAgfVxuXG4gIC8qKlxuICAgKiBMb2cgYW4gZXJyb3IgdG8gdGhlIGxvZ2dlciwgdGhlbiByZXR1cm4gdGhlIGVycm9yLlxuICAgKiBJZiBhIGNhbGxiYWNrIGlzIGdpdmVuLCBjYWxsIGl0IHdpdGggY2FsbGJhY2soZXJyb3IsIG51bGwpLlxuICAgKi9cbiAgcHJpdmF0ZSBoYW5kbGVSZXNwb25zZUVycm9yKFxuICAgIGNvbW1hbmROYW1lOiBzdHJpbmcsXG4gICAgcmVzcG9uc2VTdGF0dXM6IFJlc3BvbnNlU3RhdHVzIHwgdW5kZWZpbmVkLFxuICAgIGNhbGxiYWNrOiB1bmRlZmluZWQgfCAoKGVycm9yOiBFcnJvciB8IG51bGwsIG90aGVyOiBudWxsKSA9PiB2b2lkKVxuICApOiBFcnJvciB7XG4gICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYE1lbUpTICR7Y29tbWFuZE5hbWV9OiAke2NvbnN0YW50cy5yZXNwb25zZVN0YXR1c1RvU3RyaW5nKFxuICAgICAgcmVzcG9uc2VTdGF0dXNcbiAgICApfWA7XG4gICAgdGhpcy5vcHRpb25zLmxvZ2dlci5sb2coZXJyb3JNZXNzYWdlKTtcbiAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgY2FsbGJhY2soZXJyb3IsIG51bGwpO1xuICAgIH1cbiAgICByZXR1cm4gZXJyb3I7XG4gIH1cbn1cblxuZXhwb3J0IHsgQ2xpZW50LCBTZXJ2ZXIsIFV0aWxzLCBIZWFkZXIgfTtcbiJdfQ==
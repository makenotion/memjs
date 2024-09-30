"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Server = void 0;
const net_1 = __importDefault(require("net"));
const events_1 = __importDefault(require("events"));
const utils_1 = require("./utils");
class Server extends events_1.default.EventEmitter {
    constructor(host, 
    /* TODO: allowing port to be string or undefined is used by the tests, but seems bad overall. */
    port, username, password, options) {
        super();
        this.responseBuffer = Buffer.from([]);
        this.host = host;
        this.port = port;
        this.connected = false;
        this.connectionTimeoutSet = false;
        this.commandTimeoutId = undefined;
        this.connectCallbacks = [];
        this.responseCallbacks = {};
        this.requestTimeouts = [];
        this.errorCallbacks = {};
        this.options = utils_1.merge(options || {}, {
            timeout: 0.5,
            keepAlive: false,
            keepAliveDelay: 30,
        });
        if (this.options.conntimeout === undefined ||
            this.options.conntimeout === null) {
            this.options.conntimeout = 2 * this.options.timeout;
        }
        this.username =
            username ||
                this.options.username ||
                process.env.MEMCACHIER_USERNAME ||
                process.env.MEMCACHE_USERNAME;
        this.password =
            password ||
                this.options.password ||
                process.env.MEMCACHIER_PASSWORD ||
                process.env.MEMCACHE_PASSWORD;
        return this;
    }
    onConnect(func) {
        this.connectCallbacks.push(func);
    }
    onResponse(seq, func) {
        this.responseCallbacks[seq] = func;
    }
    respond(response) {
        const callback = this.responseCallbacks[response.header.opaque];
        if (!callback) {
            // in case of authentication, no callback is registered
            return;
        }
        callback(response);
        if (!callback.quiet || response.header.totalBodyLength === 0) {
            delete this.responseCallbacks[response.header.opaque];
            this.requestTimeouts.shift();
            delete this.errorCallbacks[response.header.opaque];
        }
    }
    onError(seq, func) {
        this.errorCallbacks[seq] = func;
    }
    error(err) {
        const errcalls = this.errorCallbacks;
        // reset all states except host, port, options, username, password
        this.responseBuffer = Buffer.from([]);
        this.connected = false;
        this.connectionTimeoutSet = false;
        this.commandTimeoutId = undefined;
        this.connectCallbacks = [];
        this.responseCallbacks = {};
        this.requestTimeouts = [];
        this.errorCallbacks = {};
        if (this._socket) {
            this._socket.destroy();
            delete this._socket;
        }
        for (let errcall of Object.values(errcalls)) {
            errcall(err);
        }
    }
    listSasl() {
        const buf = utils_1.makeRequestBuffer(0x20, "", "", "");
        this.writeSASL(buf);
    }
    saslAuth() {
        const authStr = "\x00" + this.username + "\x00" + this.password;
        const buf = utils_1.makeRequestBuffer(0x21, "PLAIN", "", authStr);
        this.writeSASL(buf);
    }
    appendToBuffer(dataBuf) {
        const old = this.responseBuffer;
        this.responseBuffer = Buffer.alloc(old.length + dataBuf.length);
        old.copy(this.responseBuffer, 0);
        dataBuf.copy(this.responseBuffer, old.length);
        return this.responseBuffer;
    }
    responseHandler(dataBuf) {
        let response;
        try {
            response = utils_1.parseMessage(this.appendToBuffer(dataBuf));
        }
        catch (e) {
            this.error(e);
            return;
        }
        let respLength;
        while (response) {
            if (response.header.opcode === 0x20) {
                this.saslAuth();
            }
            else if (response.header.status === 0x20 /* TODO: wtf? */) {
                this.error(new Error("Memcached server authentication failed!"));
            }
            else if (response.header.opcode === 0x21) {
                this.emit("authenticated");
            }
            else {
                this.respond(response);
            }
            respLength = response.header.totalBodyLength + 24;
            this.responseBuffer = this.responseBuffer.slice(respLength);
            response = utils_1.parseMessage(this.responseBuffer);
        }
    }
    sock(sasl, go) {
        const self = this;
        if (!self._socket) {
            // CASE 1: completely new socket
            self.connected = false;
            self.responseBuffer = Buffer.from([]);
            self._socket = net_1.default.connect(
            /* TODO: allowing port to be string or undefined is used by the tests, but seems bad overall. */
            typeof this.port === "string"
                ? parseInt(this.port, 10)
                : this.port || 11211, this.host, function () {
                // SASL authentication handler
                self.once("authenticated", function () {
                    if (self._socket) {
                        const socket = self._socket;
                        self.connected = true;
                        // cancel connection timeout
                        self._socket.setTimeout(0);
                        self.connectionTimeoutSet = false;
                        // run actual request(s)
                        go(self._socket);
                        self.connectCallbacks.forEach(function (cb) {
                            cb(socket);
                        });
                        self.connectCallbacks = [];
                    }
                });
                // setup response handler
                this.on("data", function (dataBuf) {
                    self.responseHandler(dataBuf);
                });
                // kick of SASL if needed
                if (self.username && self.password) {
                    self.listSasl();
                }
                else {
                    self.emit("authenticated");
                }
            });
            // setup error handler
            self._socket.on("error", function (error) {
                self.error(error);
            });
            self._socket.on("close", function () {
                var _a;
                if (Object.keys(self.errorCallbacks).length > 0) {
                    self.error(new Error("socket closed unexpectedly."));
                }
                self.connected = false;
                self.responseBuffer = Buffer.from([]);
                if (self.connectionTimeoutSet) {
                    (_a = self._socket) === null || _a === void 0 ? void 0 : _a.setTimeout(0);
                    self.connectionTimeoutSet = false;
                }
                if (self.commandTimeoutId !== undefined) {
                    clearTimeout(self.commandTimeoutId);
                    self.commandTimeoutId = undefined;
                }
                self._socket = undefined;
            });
            // setup connection timeout handler
            self.connectionTimeoutSet = true;
            self._socket.setTimeout(self.options.conntimeout * 1000, function () {
                self.connectionTimeoutSet = false;
                if (!self.connected) {
                    this.end();
                    self._socket = undefined;
                    self.error(new Error("socket timed out connecting to server."));
                }
            });
            // use TCP keep-alive
            self._socket.setKeepAlive(self.options.keepAlive, self.options.keepAliveDelay * 1000);
        }
        else if (!self.connected && !sasl) {
            // CASE 2: socket exists, but still connecting / authenticating
            self.onConnect(go);
        }
        else {
            // CASE 3: socket exists and connected / ready to use
            go(self._socket);
        }
    }
    write(blob) {
        const self = this;
        const deadline = Math.round(self.options.timeout * 1000);
        this.sock(false, function (s) {
            s.write(blob);
            self.requestTimeouts.push(utils_1.timestamp() + deadline);
            if (self.commandTimeoutId === undefined) {
                self.commandTimeoutId = setTimeout(function () {
                    timeoutHandler(self, s);
                }, deadline);
            }
        });
    }
    writeSASL(blob) {
        this.sock(true, function (s) {
            s.write(blob);
        });
    }
    close() {
        if (this._socket) {
            // TODO: this should probably be destroy() in at least some, if not all,
            // cases.
            this._socket.end();
        }
    }
    toString() {
        return "<Server " + this.host + ":" + this.port + ">";
    }
    hostportString() {
        return this.host + ":" + this.port;
    }
}
exports.Server = Server;
// We handle tracking timeouts with an array of deadlines (requestTimeouts), as
// node doesn't like us setting up lots of timers, and using just one is more
// efficient anyway.
const timeoutHandler = function (server, sock) {
    if (server.requestTimeouts.length === 0) {
        // nothing active
        server.commandTimeoutId = undefined;
        return;
    }
    // some requests outstanding, check if any have timed-out
    const now = utils_1.timestamp();
    const soonestTimeout = server.requestTimeouts[0];
    if (soonestTimeout <= now) {
        // timeout occurred!
        server.error(new Error("socket timed out waiting on response."));
    }
    else {
        // no timeout! Setup next one.
        const deadline = soonestTimeout - now;
        server.commandTimeoutId = setTimeout(function () {
            timeoutHandler(server, sock);
        }, deadline);
    }
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL21lbWpzL3NlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSw4Q0FBc0I7QUFDdEIsb0RBQTRCO0FBQzVCLG1DQU1pQjtBQTBCakIsTUFBYSxNQUFPLFNBQVEsZ0JBQU0sQ0FBQyxZQUFZO0lBaUI3QyxZQUNFLElBQVk7SUFDWixnR0FBZ0c7SUFDaEcsSUFBc0IsRUFDdEIsUUFBaUIsRUFDakIsUUFBaUIsRUFDakIsT0FBZ0M7UUFFaEMsS0FBSyxFQUFFLENBQUM7UUFDUixJQUFJLENBQUMsY0FBYyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDdEMsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7UUFDakIsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7UUFDakIsSUFBSSxDQUFDLFNBQVMsR0FBRyxLQUFLLENBQUM7UUFDdkIsSUFBSSxDQUFDLG9CQUFvQixHQUFHLEtBQUssQ0FBQztRQUNsQyxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsU0FBUyxDQUFDO1FBQ2xDLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxFQUFFLENBQUM7UUFDM0IsSUFBSSxDQUFDLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztRQUM1QixJQUFJLENBQUMsZUFBZSxHQUFHLEVBQUUsQ0FBQztRQUMxQixJQUFJLENBQUMsY0FBYyxHQUFHLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsT0FBTyxHQUFHLGFBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxFQUFFO1lBQ2xDLE9BQU8sRUFBRSxHQUFHO1lBQ1osU0FBUyxFQUFFLEtBQUs7WUFDaEIsY0FBYyxFQUFFLEVBQUU7U0FDbkIsQ0FBa0IsQ0FBQztRQUNwQixJQUNFLElBQUksQ0FBQyxPQUFPLENBQUMsV0FBVyxLQUFLLFNBQVM7WUFDdEMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxXQUFXLEtBQUss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LENBQUMsQ0FBQztLQUNsRTtTQUFNO1FBQ0wsOEJBQThCO1FBQzlCLE1BQU0sUUFBUSxHQUFHLGNBQWMsR0FBRyxHQUFHLENBQUM7UUFDdEMsTUFBTSxDQUFDLGdCQUFnQixHQUFHLFVBQVUsQ0FBQztZQUNuQyxjQUFjLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQy9CLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQztLQUNkO0FBQ0gsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IG5ldCBmcm9tIFwibmV0XCI7XG5pbXBvcnQgZXZlbnRzIGZyb20gXCJldmVudHNcIjtcbmltcG9ydCB7XG4gIG1ha2VSZXF1ZXN0QnVmZmVyLFxuICBwYXJzZU1lc3NhZ2UsXG4gIG1lcmdlLFxuICB0aW1lc3RhbXAsXG4gIE1lc3NhZ2UsXG59IGZyb20gXCIuL3V0aWxzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2VydmVyT3B0aW9ucyB7XG4gIHRpbWVvdXQ6IG51bWJlcjtcbiAga2VlcEFsaXZlOiBib29sZWFuO1xuICBrZWVwQWxpdmVEZWxheTogbnVtYmVyO1xuICBjb25udGltZW91dDogbnVtYmVyO1xuICB1c2VybmFtZT86IHN0cmluZztcbiAgcGFzc3dvcmQ/OiBzdHJpbmc7XG59XG5cbnR5cGUgU2VxID0gbnVtYmVyO1xuXG5leHBvcnQgaW50ZXJmYWNlIE9uQ29ubmVjdENhbGxiYWNrIHtcbiAgKHNvY2tldDogbmV0LlNvY2tldCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT25SZXNwb25zZUNhbGxiYWNrIHtcbiAgKG1lc3NhZ2U6IE1lc3NhZ2UpOiB2b2lkO1xuICBxdWlldD86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT25FcnJvckNhbGxiYWNrIHtcbiAgKGVycm9yOiBFcnJvcik6IHZvaWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBTZXJ2ZXIgZXh0ZW5kcyBldmVudHMuRXZlbnRFbWl0dGVyIHtcbiAgcmVzcG9uc2VCdWZmZXI6IEJ1ZmZlcjtcbiAgaG9zdDogc3RyaW5nO1xuICBwb3J0OiBzdHJpbmcgfCBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIGNvbm5lY3RlZDogYm9vbGVhbjtcbiAgY29ubmVjdGlvblRpbWVvdXRTZXQ6IGJvb2xlYW47XG4gIGNvbW1hbmRUaW1lb3V0SWQ6IE5vZGVKUy5UaW1lb3V0IHwgdW5kZWZpbmVkO1xuICBjb25uZWN0Q2FsbGJhY2tzOiBPbkNvbm5lY3RDYWxsYmFja1tdO1xuICByZXNwb25zZUNhbGxiYWNrczogeyBbc2VxOiBzdHJpbmddOiBPblJlc3BvbnNlQ2FsbGJhY2sgfTtcbiAgcmVxdWVzdFRpbWVvdXRzOiBudW1iZXJbXTtcbiAgZXJyb3JDYWxsYmFja3M6IHsgW3NlcTogc3RyaW5nXTogT25FcnJvckNhbGxiYWNrIH07XG4gIG9wdGlvbnM6IFNlcnZlck9wdGlvbnM7XG4gIHVzZXJuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIHBhc3N3b3JkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbiAgX3NvY2tldDogbmV0LlNvY2tldCB8IHVuZGVmaW5lZDtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBob3N0OiBzdHJpbmcsXG4gICAgLyogVE9ETzogYWxsb3dpbmcgcG9ydCB0byBiZSBzdHJpbmcgb3IgdW5kZWZpbmVkIGlzIHVzZWQgYnkgdGhlIHRlc3RzLCBidXQgc2VlbXMgYmFkIG92ZXJhbGwuICovXG4gICAgcG9ydD86IHN0cmluZyB8IG51bWJlcixcbiAgICB1c2VybmFtZT86IHN0cmluZyxcbiAgICBwYXNzd29yZD86IHN0cmluZyxcbiAgICBvcHRpb25zPzogUGFydGlhbDxTZXJ2ZXJPcHRpb25zPlxuICApIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucmVzcG9uc2VCdWZmZXIgPSBCdWZmZXIuZnJvbShbXSk7XG4gICAgdGhpcy5ob3N0ID0gaG9zdDtcbiAgICB0aGlzLnBvcnQgPSBwb3J0O1xuICAgIHRoaXMuY29ubmVjdGVkID0gZmFsc2U7XG4gICAgdGhpcy5jb25uZWN0aW9uVGltZW91dFNldCA9IGZhbHNlO1xuICAgIHRoaXMuY29tbWFuZFRpbWVvdXRJZCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmNvbm5lY3RDYWxsYmFja3MgPSBbXTtcbiAgICB0aGlzLnJlc3BvbnNlQ2FsbGJhY2tzID0ge307XG4gICAgdGhpcy5yZXF1ZXN0VGltZW91dHMgPSBbXTtcbiAgICB0aGlzLmVycm9yQ2FsbGJhY2tzID0ge307XG4gICAgdGhpcy5vcHRpb25zID0gbWVyZ2Uob3B0aW9ucyB8fCB7fSwge1xuICAgICAgdGltZW91dDogMC41LFxuICAgICAga2VlcEFsaXZlOiBmYWxzZSxcbiAgICAgIGtlZXBBbGl2ZURlbGF5OiAzMCxcbiAgICB9KSBhcyBTZXJ2ZXJPcHRpb25zO1xuICAgIGlmIChcbiAgICAgIHRoaXMub3B0aW9ucy5jb25udGltZW91dCA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICB0aGlzLm9wdGlvbnMuY29ubnRpbWVvdXQgPT09IG51bGxcbiAgICApIHtcbiAgICAgIHRoaXMub3B0aW9ucy5jb25udGltZW91dCA9IDIgKiB0aGlzLm9wdGlvbnMudGltZW91dDtcbiAgICB9XG4gICAgdGhpcy51c2VybmFtZSA9XG4gICAgICB1c2VybmFtZSB8fFxuICAgICAgdGhpcy5vcHRpb25zLnVzZXJuYW1lIHx8XG4gICAgICBwcm9jZXNzLmVudi5NRU1DQUNISUVSX1VTRVJOQU1FIHx8XG4gICAgICBwcm9jZXNzLmVudi5NRU1DQUNIRV9VU0VSTkFNRTtcbiAgICB0aGlzLnBhc3N3b3JkID1cbiAgICAgIHBhc3N3b3JkIHx8XG4gICAgICB0aGlzLm9wdGlvbnMucGFzc3dvcmQgfHxcbiAgICAgIHByb2Nlc3MuZW52Lk1FTUNBQ0hJRVJfUEFTU1dPUkQgfHxcbiAgICAgIHByb2Nlc3MuZW52Lk1FTUNBQ0hFX1BBU1NXT1JEO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgb25Db25uZWN0KGZ1bmM6IE9uQ29ubmVjdENhbGxiYWNrKSB7XG4gICAgdGhpcy5jb25uZWN0Q2FsbGJhY2tzLnB1c2goZnVuYyk7XG4gIH1cblxuICBvblJlc3BvbnNlKHNlcTogU2VxLCBmdW5jOiBPblJlc3BvbnNlQ2FsbGJhY2spIHtcbiAgICB0aGlzLnJlc3BvbnNlQ2FsbGJhY2tzW3NlcV0gPSBmdW5jO1xuICB9XG5cbiAgcmVzcG9uZChyZXNwb25zZTogTWVzc2FnZSkge1xuICAgIGNvbnN0IGNhbGxiYWNrID0gdGhpcy5yZXNwb25zZUNhbGxiYWNrc1tyZXNwb25zZS5oZWFkZXIub3BhcXVlXTtcbiAgICBpZiAoIWNhbGxiYWNrKSB7XG4gICAgICAvLyBpbiBjYXNlIG9mIGF1dGhlbnRpY2F0aW9uLCBubyBjYWxsYmFjayBpcyByZWdpc3RlcmVkXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKHJlc3BvbnNlKTtcbiAgICBpZiAoIWNhbGxiYWNrLnF1aWV0IHx8IHJlc3BvbnNlLmhlYWRlci50b3RhbEJvZHlMZW5ndGggPT09IDApIHtcbiAgICAgIGRlbGV0ZSB0aGlzLnJlc3BvbnNlQ2FsbGJhY2tzW3Jlc3BvbnNlLmhlYWRlci5vcGFxdWVdO1xuICAgICAgdGhpcy5yZXF1ZXN0VGltZW91dHMuc2hpZnQoKTtcbiAgICAgIGRlbGV0ZSB0aGlzLmVycm9yQ2FsbGJhY2tzW3Jlc3BvbnNlLmhlYWRlci5vcGFxdWVdO1xuICAgIH1cbiAgfVxuXG4gIG9uRXJyb3Ioc2VxOiBTZXEsIGZ1bmM6IE9uRXJyb3JDYWxsYmFjaykge1xuICAgIHRoaXMuZXJyb3JDYWxsYmFja3Nbc2VxXSA9IGZ1bmM7XG4gIH1cblxuICBlcnJvcihlcnI6IEVycm9yKSB7XG4gICAgY29uc3QgZXJyY2FsbHMgPSB0aGlzLmVycm9yQ2FsbGJhY2tzO1xuICAgIC8vIHJlc2V0IGFsbCBzdGF0ZXMgZXhjZXB0IGhvc3QsIHBvcnQsIG9wdGlvbnMsIHVzZXJuYW1lLCBwYXNzd29yZFxuICAgIHRoaXMucmVzcG9uc2VCdWZmZXIgPSBCdWZmZXIuZnJvbShbXSk7XG4gICAgdGhpcy5jb25uZWN0ZWQgPSBmYWxzZTtcbiAgICB0aGlzLmNvbm5lY3Rpb25UaW1lb3V0U2V0ID0gZmFsc2U7XG4gICAgdGhpcy5jb21tYW5kVGltZW91dElkID0gdW5kZWZpbmVkO1xuICAgIHRoaXMuY29ubmVjdENhbGxiYWNrcyA9IFtdO1xuICAgIHRoaXMucmVzcG9uc2VDYWxsYmFja3MgPSB7fTtcbiAgICB0aGlzLnJlcXVlc3RUaW1lb3V0cyA9IFtdO1xuICAgIHRoaXMuZXJyb3JDYWxsYmFja3MgPSB7fTtcbiAgICBpZiAodGhpcy5fc29ja2V0KSB7XG4gICAgICB0aGlzLl9zb2NrZXQuZGVzdHJveSgpO1xuICAgICAgZGVsZXRlIHRoaXMuX3NvY2tldDtcbiAgICB9XG4gICAgZm9yIChsZXQgZXJyY2FsbCBvZiBPYmplY3QudmFsdWVzKGVycmNhbGxzKSkge1xuICAgICAgZXJyY2FsbChlcnIpO1xuICAgIH1cbiAgfVxuXG4gIGxpc3RTYXNsKCkge1xuICAgIGNvbnN0IGJ1ZiA9IG1ha2VSZXF1ZXN0QnVmZmVyKDB4MjAsIFwiXCIsIFwiXCIsIFwiXCIpO1xuICAgIHRoaXMud3JpdGVTQVNMKGJ1Zik7XG4gIH1cblxuICBzYXNsQXV0aCgpIHtcbiAgICBjb25zdCBhdXRoU3RyID0gXCJcXHgwMFwiICsgdGhpcy51c2VybmFtZSArIFwiXFx4MDBcIiArIHRoaXMucGFzc3dvcmQ7XG4gICAgY29uc3QgYnVmID0gbWFrZVJlcXVlc3RCdWZmZXIoMHgyMSwgXCJQTEFJTlwiLCBcIlwiLCBhdXRoU3RyKTtcbiAgICB0aGlzLndyaXRlU0FTTChidWYpO1xuICB9XG5cbiAgYXBwZW5kVG9CdWZmZXIoZGF0YUJ1ZjogQnVmZmVyKSB7XG4gICAgY29uc3Qgb2xkID0gdGhpcy5yZXNwb25zZUJ1ZmZlcjtcbiAgICB0aGlzLnJlc3BvbnNlQnVmZmVyID0gQnVmZmVyLmFsbG9jKG9sZC5sZW5ndGggKyBkYXRhQnVmLmxlbmd0aCk7XG4gICAgb2xkLmNvcHkodGhpcy5yZXNwb25zZUJ1ZmZlciwgMCk7XG4gICAgZGF0YUJ1Zi5jb3B5KHRoaXMucmVzcG9uc2VCdWZmZXIsIG9sZC5sZW5ndGgpO1xuICAgIHJldHVybiB0aGlzLnJlc3BvbnNlQnVmZmVyO1xuICB9XG4gIHJlc3BvbnNlSGFuZGxlcihkYXRhQnVmOiBCdWZmZXIpIHtcbiAgICBsZXQgcmVzcG9uc2U6IE1lc3NhZ2UgfCBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgcmVzcG9uc2UgPSBwYXJzZU1lc3NhZ2UodGhpcy5hcHBlbmRUb0J1ZmZlcihkYXRhQnVmKSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgdGhpcy5lcnJvcihlIGFzIEVycm9yKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsZXQgcmVzcExlbmd0aDogbnVtYmVyO1xuICAgIHdoaWxlIChyZXNwb25zZSkge1xuICAgICAgaWYgKHJlc3BvbnNlLmhlYWRlci5vcGNvZGUgPT09IDB4MjApIHtcbiAgICAgICAgdGhpcy5zYXNsQXV0aCgpO1xuICAgICAgfSBlbHNlIGlmIChyZXNwb25zZS5oZWFkZXIuc3RhdHVzID09PSAoMHgyMCBhcyBhbnkpIC8qIFRPRE86IHd0Zj8gKi8pIHtcbiAgICAgICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJNZW1jYWNoZWQgc2VydmVyIGF1dGhlbnRpY2F0aW9uIGZhaWxlZCFcIikpO1xuICAgICAgfSBlbHNlIGlmIChyZXNwb25zZS5oZWFkZXIub3Bjb2RlID09PSAweDIxKSB7XG4gICAgICAgIHRoaXMuZW1pdChcImF1dGhlbnRpY2F0ZWRcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnJlc3BvbmQocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgcmVzcExlbmd0aCA9IHJlc3BvbnNlLmhlYWRlci50b3RhbEJvZHlMZW5ndGggKyAyNDtcbiAgICAgIHRoaXMucmVzcG9uc2VCdWZmZXIgPSB0aGlzLnJlc3BvbnNlQnVmZmVyLnNsaWNlKHJlc3BMZW5ndGgpO1xuICAgICAgcmVzcG9uc2UgPSBwYXJzZU1lc3NhZ2UodGhpcy5yZXNwb25zZUJ1ZmZlcik7XG4gICAgfVxuICB9XG4gIHNvY2soc2FzbDogYm9vbGVhbiwgZ286IE9uQ29ubmVjdENhbGxiYWNrKSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG5cbiAgICBpZiAoIXNlbGYuX3NvY2tldCkge1xuICAgICAgLy8gQ0FTRSAxOiBjb21wbGV0ZWx5IG5ldyBzb2NrZXRcbiAgICAgIHNlbGYuY29ubmVjdGVkID0gZmFsc2U7XG4gICAgICBzZWxmLnJlc3BvbnNlQnVmZmVyID0gQnVmZmVyLmZyb20oW10pO1xuICAgICAgc2VsZi5fc29ja2V0ID0gbmV0LmNvbm5lY3QoXG4gICAgICAgIC8qIFRPRE86IGFsbG93aW5nIHBvcnQgdG8gYmUgc3RyaW5nIG9yIHVuZGVmaW5lZCBpcyB1c2VkIGJ5IHRoZSB0ZXN0cywgYnV0IHNlZW1zIGJhZCBvdmVyYWxsLiAqL1xuICAgICAgICB0eXBlb2YgdGhpcy5wb3J0ID09PSBcInN0cmluZ1wiXG4gICAgICAgICAgPyBwYXJzZUludCh0aGlzLnBvcnQsIDEwKVxuICAgICAgICAgIDogdGhpcy5wb3J0IHx8IDExMjExLFxuICAgICAgICB0aGlzLmhvc3QsXG4gICAgICAgIGZ1bmN0aW9uICh0aGlzOiBuZXQuU29ja2V0KSB7XG4gICAgICAgICAgLy8gU0FTTCBhdXRoZW50aWNhdGlvbiBoYW5kbGVyXG4gICAgICAgICAgc2VsZi5vbmNlKFwiYXV0aGVudGljYXRlZFwiLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAoc2VsZi5fc29ja2V0KSB7XG4gICAgICAgICAgICAgIGNvbnN0IHNvY2tldCA9IHNlbGYuX3NvY2tldDtcbiAgICAgICAgICAgICAgc2VsZi5jb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAvLyBjYW5jZWwgY29ubmVjdGlvbiB0aW1lb3V0XG4gICAgICAgICAgICAgIHNlbGYuX3NvY2tldC5zZXRUaW1lb3V0KDApO1xuICAgICAgICAgICAgICBzZWxmLmNvbm5lY3Rpb25UaW1lb3V0U2V0ID0gZmFsc2U7XG4gICAgICAgICAgICAgIC8vIHJ1biBhY3R1YWwgcmVxdWVzdChzKVxuICAgICAgICAgICAgICBnbyhzZWxmLl9zb2NrZXQpO1xuICAgICAgICAgICAgICBzZWxmLmNvbm5lY3RDYWxsYmFja3MuZm9yRWFjaChmdW5jdGlvbiAoY2IpIHtcbiAgICAgICAgICAgICAgICBjYihzb2NrZXQpO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgc2VsZi5jb25uZWN0Q2FsbGJhY2tzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICAvLyBzZXR1cCByZXNwb25zZSBoYW5kbGVyXG4gICAgICAgICAgdGhpcy5vbihcImRhdGFcIiwgZnVuY3Rpb24gKGRhdGFCdWYpIHtcbiAgICAgICAgICAgIHNlbGYucmVzcG9uc2VIYW5kbGVyKGRhdGFCdWYpO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgLy8ga2ljayBvZiBTQVNMIGlmIG5lZWRlZFxuICAgICAgICAgIGlmIChzZWxmLnVzZXJuYW1lICYmIHNlbGYucGFzc3dvcmQpIHtcbiAgICAgICAgICAgIHNlbGYubGlzdFNhc2woKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2VsZi5lbWl0KFwiYXV0aGVudGljYXRlZFwiKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICk7XG5cbiAgICAgIC8vIHNldHVwIGVycm9yIGhhbmRsZXJcbiAgICAgIHNlbGYuX3NvY2tldC5vbihcImVycm9yXCIsIGZ1bmN0aW9uIChlcnJvcikge1xuICAgICAgICBzZWxmLmVycm9yKGVycm9yKTtcbiAgICAgIH0pO1xuXG4gICAgICBzZWxmLl9zb2NrZXQub24oXCJjbG9zZVwiLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmIChPYmplY3Qua2V5cyhzZWxmLmVycm9yQ2FsbGJhY2tzKS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgc2VsZi5lcnJvcihuZXcgRXJyb3IoXCJzb2NrZXQgY2xvc2VkIHVuZXhwZWN0ZWRseS5cIikpO1xuICAgICAgICB9XG4gICAgICAgIHNlbGYuY29ubmVjdGVkID0gZmFsc2U7XG4gICAgICAgIHNlbGYucmVzcG9uc2VCdWZmZXIgPSBCdWZmZXIuZnJvbShbXSk7XG4gICAgICAgIGlmIChzZWxmLmNvbm5lY3Rpb25UaW1lb3V0U2V0KSB7XG4gICAgICAgICAgc2VsZi5fc29ja2V0Py5zZXRUaW1lb3V0KDApO1xuICAgICAgICAgIHNlbGYuY29ubmVjdGlvblRpbWVvdXRTZXQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2VsZi5jb21tYW5kVGltZW91dElkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjbGVhclRpbWVvdXQoc2VsZi5jb21tYW5kVGltZW91dElkKTtcbiAgICAgICAgICBzZWxmLmNvbW1hbmRUaW1lb3V0SWQgPSB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgc2VsZi5fc29ja2V0ID0gdW5kZWZpbmVkO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIHNldHVwIGNvbm5lY3Rpb24gdGltZW91dCBoYW5kbGVyXG4gICAgICBzZWxmLmNvbm5lY3Rpb25UaW1lb3V0U2V0ID0gdHJ1ZTtcbiAgICAgIHNlbGYuX3NvY2tldC5zZXRUaW1lb3V0KFxuICAgICAgICBzZWxmLm9wdGlvbnMuY29ubnRpbWVvdXQgKiAxMDAwLFxuICAgICAgICBmdW5jdGlvbiAodGhpczogbmV0LlNvY2tldCkge1xuICAgICAgICAgIHNlbGYuY29ubmVjdGlvblRpbWVvdXRTZXQgPSBmYWxzZTtcbiAgICAgICAgICBpZiAoIXNlbGYuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICB0aGlzLmVuZCgpO1xuICAgICAgICAgICAgc2VsZi5fc29ja2V0ID0gdW5kZWZpbmVkO1xuICAgICAgICAgICAgc2VsZi5lcnJvcihuZXcgRXJyb3IoXCJzb2NrZXQgdGltZWQgb3V0IGNvbm5lY3RpbmcgdG8gc2VydmVyLlwiKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICApO1xuXG4gICAgICAvLyB1c2UgVENQIGtlZXAtYWxpdmVcbiAgICAgIHNlbGYuX3NvY2tldC5zZXRLZWVwQWxpdmUoXG4gICAgICAgIHNlbGYub3B0aW9ucy5rZWVwQWxpdmUsXG4gICAgICAgIHNlbGYub3B0aW9ucy5rZWVwQWxpdmVEZWxheSAqIDEwMDBcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmICghc2VsZi5jb25uZWN0ZWQgJiYgIXNhc2wpIHtcbiAgICAgIC8vIENBU0UgMjogc29ja2V0IGV4aXN0cywgYnV0IHN0aWxsIGNvbm5lY3RpbmcgLyBhdXRoZW50aWNhdGluZ1xuICAgICAgc2VsZi5vbkNvbm5lY3QoZ28pO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBDQVNFIDM6IHNvY2tldCBleGlzdHMgYW5kIGNvbm5lY3RlZCAvIHJlYWR5IHRvIHVzZVxuICAgICAgZ28oc2VsZi5fc29ja2V0KTtcbiAgICB9XG4gIH1cblxuICB3cml0ZShibG9iOiBCdWZmZXIpIHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBjb25zdCBkZWFkbGluZSA9IE1hdGgucm91bmQoc2VsZi5vcHRpb25zLnRpbWVvdXQgKiAxMDAwKTtcbiAgICB0aGlzLnNvY2soZmFsc2UsIGZ1bmN0aW9uIChzKSB7XG4gICAgICBzLndyaXRlKGJsb2IpO1xuICAgICAgc2VsZi5yZXF1ZXN0VGltZW91dHMucHVzaCh0aW1lc3RhbXAoKSArIGRlYWRsaW5lKTtcbiAgICAgIGlmIChzZWxmLmNvbW1hbmRUaW1lb3V0SWQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBzZWxmLmNvbW1hbmRUaW1lb3V0SWQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICB0aW1lb3V0SGFuZGxlcihzZWxmLCBzKTtcbiAgICAgICAgfSwgZGVhZGxpbmUpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgd3JpdGVTQVNMKGJsb2I6IEJ1ZmZlcikge1xuICAgIHRoaXMuc29jayh0cnVlLCBmdW5jdGlvbiAocykge1xuICAgICAgcy53cml0ZShibG9iKTtcbiAgICB9KTtcbiAgfVxuXG4gIGNsb3NlKCkge1xuICAgIGlmICh0aGlzLl9zb2NrZXQpIHtcbiAgICAgIC8vIFRPRE86IHRoaXMgc2hvdWxkIHByb2JhYmx5IGJlIGRlc3Ryb3koKSBpbiBhdCBsZWFzdCBzb21lLCBpZiBub3QgYWxsLFxuICAgICAgLy8gY2FzZXMuXG4gICAgICB0aGlzLl9zb2NrZXQuZW5kKCk7XG4gICAgfVxuICB9XG5cbiAgdG9TdHJpbmcoKSB7XG4gICAgcmV0dXJuIFwiPFNlcnZlciBcIiArIHRoaXMuaG9zdCArIFwiOlwiICsgdGhpcy5wb3J0ICsgXCI+XCI7XG4gIH1cblxuICBob3N0cG9ydFN0cmluZygpIHtcbiAgICByZXR1cm4gdGhpcy5ob3N0ICsgXCI6XCIgKyB0aGlzLnBvcnQ7XG4gIH1cbn1cblxuLy8gV2UgaGFuZGxlIHRyYWNraW5nIHRpbWVvdXRzIHdpdGggYW4gYXJyYXkgb2YgZGVhZGxpbmVzIChyZXF1ZXN0VGltZW91dHMpLCBhc1xuLy8gbm9kZSBkb2Vzbid0IGxpa2UgdXMgc2V0dGluZyB1cCBsb3RzIG9mIHRpbWVycywgYW5kIHVzaW5nIGp1c3Qgb25lIGlzIG1vcmVcbi8vIGVmZmljaWVudCBhbnl3YXkuXG5jb25zdCB0aW1lb3V0SGFuZGxlciA9IGZ1bmN0aW9uIChzZXJ2ZXI6IFNlcnZlciwgc29jazogbmV0LlNvY2tldCkge1xuICBpZiAoc2VydmVyLnJlcXVlc3RUaW1lb3V0cy5sZW5ndGggPT09IDApIHtcbiAgICAvLyBub3RoaW5nIGFjdGl2ZVxuICAgIHNlcnZlci5jb21tYW5kVGltZW91dElkID0gdW5kZWZpbmVkO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIHNvbWUgcmVxdWVzdHMgb3V0c3RhbmRpbmcsIGNoZWNrIGlmIGFueSBoYXZlIHRpbWVkLW91dFxuICBjb25zdCBub3cgPSB0aW1lc3RhbXAoKTtcbiAgY29uc3Qgc29vbmVzdFRpbWVvdXQgPSBzZXJ2ZXIucmVxdWVzdFRpbWVvdXRzWzBdO1xuXG4gIGlmIChzb29uZXN0VGltZW91dCA8PSBub3cpIHtcbiAgICAvLyB0aW1lb3V0IG9jY3VycmVkIVxuICAgIHNlcnZlci5lcnJvcihuZXcgRXJyb3IoXCJzb2NrZXQgdGltZWQgb3V0IHdhaXRpbmcgb24gcmVzcG9uc2UuXCIpKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBubyB0aW1lb3V0ISBTZXR1cCBuZXh0IG9uZS5cbiAgICBjb25zdCBkZWFkbGluZSA9IHNvb25lc3RUaW1lb3V0IC0gbm93O1xuICAgIHNlcnZlci5jb21tYW5kVGltZW91dElkID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICB0aW1lb3V0SGFuZGxlcihzZXJ2ZXIsIHNvY2spO1xuICAgIH0sIGRlYWRsaW5lKTtcbiAgfVxufTtcbiJdfQ==
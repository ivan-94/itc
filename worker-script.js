(function(window) {
  (function workerSource(events, scope) {
    var ItcWorkerImpl = /** @class */ (function() {
      function ItcWorkerImpl(scope) {
        this.ports = [];
        this.uid = 0;
        this.scope = scope;
        this.listen();
        this.heartbeat();
      }
      ItcWorkerImpl.prototype.checkMaster = function() {
        if (this.master == null && this.ports.length) {
          this.master = this.ports[0];
          this.master.postMessage({ type: events.BECOME_MASTER });
          this.broadcast({
            type: events.UPDATE_MASTER,
            data: { id: this.master.id, name: this.master.name }
          });
        }
      };
      ItcWorkerImpl.prototype.removePort = function(port) {
        var index = this.ports.indexOf(port);
        if (index !== -1) {
          this.ports.splice(index, 1);
        }
        if (this.master === port) {
          this.master = undefined;
        }
        this.updatePeer();
        this.checkMaster();
      };
      ItcWorkerImpl.prototype.getPeers = function(port) {
        return this.ports
          .filter(function(p) {
            return p.id !== port.id;
          })
          .map(function(p) {
            return { id: p.id, name: p.name };
          });
      };
      /**
       * sync peers
       */
      ItcWorkerImpl.prototype.updatePeer = function(currentPort) {
        var _this = this;
        this.ports
          .filter(function(p) {
            return p !== currentPort;
          })
          .forEach(function(port) {
            var peers = _this.getPeers(port);
            port.postMessage({ type: events.UPDATE_PEERS, data: peers });
          });
      };
      ItcWorkerImpl.prototype.broadcast = function(data, source) {
        this.ports
          .filter(function(p) {
            return p !== source;
          })
          .forEach(function(port) {
            return port.postMessage(data);
          });
      };
      ItcWorkerImpl.prototype.postMessage = function(data, source) {
        if (data.target == null || data.target === "*") {
          this.broadcast(data, source);
          return;
        }
        if (data.target === -1) {
          return;
        }
        var idx = this.ports.findIndex(function(i) {
          return i.id === data.target;
        });
        if (idx !== -1) {
          this.ports[idx].postMessage(data);
        }
      };
      ItcWorkerImpl.prototype.heartbeat = function() {
        var _this = this;
        setTimeout(function() {
          var i = _this.ports.length;
          while (i--) {
            var port = _this.ports[i];
            if (port.zoombie) {
              _this.removePort(port);
            } else {
              port.zoombie = true;
              port.postMessage({ type: events.PING });
            }
          }
          _this.heartbeat();
        }, 500);
      };
      ItcWorkerImpl.prototype.listen = function() {
        var _this = this;
        this.scope.addEventListener("connect", function(event) {
          var port = event.ports[0];
          port.id = _this.uid++;
          port.addEventListener("message", function(evt) {
            // reconnect
            if (_this.ports.indexOf(port) === -1) {
              _this.ports.push(port);
              _this.checkMaster();
              _this.updatePeer();
              // force update master
              _this.postMessage({
                target: port.id,
                type: events.UPDATE_MASTER,
                data: { id: _this.master.id, name: _this.master.name }
              });
            }
            var message = evt.data;
            switch (message.type) {
              case events.PONG:
                port.zoombie = false;
                break;
              case events.MESSAGE:
                // forward to other ports
                _this.postMessage(message, port);
                break;
              case events.DESTROY:
                _this.removePort(port);
                break;
              case events.INITIAL:
                var name_1 = message.data.name;
                port.name = name_1;
                _this.updatePeer(port);
                break;
              default:
                // forward to other ports
                _this.postMessage(message, port);
                break;
            }
          });
          _this.ports.push(port);
          port.start();
          var currentMaster = _this.master || port;
          var initialState = {
            id: port.id,
            peers: _this.getPeers(port),
            master: { name: currentMaster.name, id: currentMaster.id }
          };
          port.postMessage({
            type: events.CONNECTED,
            data: initialState
          });
          _this.checkMaster();
        });
      };
      return ItcWorkerImpl;
    })();
    return new ItcWorkerImpl(scope);
  })(
    {
      CONNECTED: "CONNECTED",
      INITIAL: "INITIAL",
      PONG: "PONG",
      PING: "PING",
      BECOME_MASTER: "BECOME_MASTER",
      DESTROY: "DESTROY",
      MESSAGE: "MESSAGE",
      UPDATE_PEERS: "UPDATE_PEERS",
      UPDATE_MASTER: "UPDATE_MASTER",
      CALL: "CALL",
      CALL_RESPONSE: "CALL_RESPONSE"
    },
    window
  );
})(this);

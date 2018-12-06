;(function workerSource(events) {
  var ports = []
  var master
  var uid = 0
  function checkMaster() {
    if (master == null && ports.length) {
      master = ports[0]
      master.postMessage({ type: events.BECOME_MASTER })
      broadcast({ type: events.UPDATE_MASTER, data: { id: master.id, name: master.name } })
    }
  }
  function removePort(port) {
    var index = ports.indexOf(port)
    if (index !== -1) {
      ports.splice(index, 1)
    }
    if (master === port) {
      master = undefined
    }
    updatePeer()
  }
  /**
   * sync peers
   */
  function updatePeer() {
    ports.forEach(function(port) {
      var peers = ports
        .filter(function(p) {
          return p !== port
        })
        .map(function(p) {
          return { id: p.id, name: p.name }
        })
      port.postMessage({ type: events.UPDATE_PEERS, data: peers })
    })
  }
  function broadcast(data) {
    ports.forEach(function(port) {
      return port.postMessage(data)
    })
  }
  function heartbeat() {
    setTimeout(function() {
      var i = ports.length
      while (i--) {
        var port = ports[i]
        if (port.zoombie) {
          removePort(port)
        } else {
          port.zoombie = true
          port.postMessage({ type: events.PING })
        }
      }
      checkMaster()
      heartbeat()
    }, 500)
  }
  this.addEventListener('connect', function(event) {
    var port = event.ports[0]
    port.id = uid++
    port.addEventListener('message', function(evt) {
      var message = evt.data
      switch (message.type) {
        case events.PONG:
          port.zoombie = false
          break
        case events.MESSAGE:
          // forward to other ports
          broadcast(message)
          break
        case events.DESTORY:
          removePort(port)
          checkMaster()
          break
        case events.SETNAME:
          port.name = message.data
          updatePeer()
          break
        case events.GET_PEERS:
          port.postMessage({
            type: events.GET_PEERS,
            data: ports
              .filter(function(p) {
                return p !== port
              })
              .map(function(p) {
                return { id: p.id, name: p.name }
              }),
          })
          break
        case events.GET_MASTER:
          port.postMessage({
            type: events.GET_MASTER,
            data: { id: master.id, name: master.name },
          })
          break
        default:
          // forward to other ports
          broadcast(message)
          break
      }
    })
    ports.push(port)
    port.start()
    port.postMessage(events.CONNECTED)
    checkMaster()
    updatePeer()
  })
  heartbeat()
})({
  CONNECTED: 'CONNECTED',
  PONG: 'PONG',
  PING: 'PING',
  BECOME_MASTER: 'BECOME_MASTER',
  DESTORY: 'DESTROY',
  MESSAGE: 'MESSAGE',
  SETNAME: 'SET_NAME',
  GET_PEERS: 'GET_PEERS',
  GET_MASTER: 'GET_MASTER',
  UPDATE_PEERS: 'UPDATE_PEERS',
  UPDATE_MASTER: 'UPDATE_MASTER',
  SYNC: 'SYNC',
})

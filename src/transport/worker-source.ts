import { EVENTS, MesssagePayload } from './transport'

export default function workerSource(this: SharedWorker.SharedWorkerGlobalScope, events: typeof EVENTS) {
  type ExtendedPort = MessagePort & { zoombie: boolean; id: number; name?: string }
  const ports: ExtendedPort[] = []
  let master: ExtendedPort | undefined
  let uid: number = 0

  function checkMaster() {
    if (master == null && ports.length) {
      master = ports[0]
      master.postMessage({ type: events.BECOME_MASTER })
      broadcast({ type: events.UPDATE_MASTER, data: { id: master.id, name: master.name } })
    }
  }

  function removePort(port: ExtendedPort) {
    const index = ports.indexOf(port)
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
    ports.forEach(port => {
      const peers = ports.filter(p => p !== port).map(p => ({ id: p.id, name: p.name }))
      port.postMessage({ type: events.UPDATE_PEERS, data: peers })
    })
  }

  function broadcast(data: MesssagePayload) {
    ports.forEach(port => port.postMessage(data))
  }

  function heartbeat() {
    setTimeout(() => {
      let i = ports.length
      while (i--) {
        const port = ports[i]
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

  this.addEventListener('connect', function(event: Event) {
    const port = (event as MessageEvent).ports[0] as ExtendedPort
    port.id = uid++

    port.addEventListener('message', function(evt: MessageEvent) {
      const message = evt.data as MesssagePayload
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
            data: ports.filter(p => p !== port).map(p => ({ id: p.id, name: p.name })),
          })
          break
        case events.GET_MASTER:
          port.postMessage({
            type: events.GET_MASTER,
            data: { id: master!.id, name: master!.name },
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
}

import { Transport, MesssagePayload } from './transport'
import EventEmitter from './EventEmitter'

const EVENT_CONNECTED = 'CONNECTED'
const EVENT_PONG = 'PONG'
const EVENT_PING = 'PING'
const EVENT_BECOME_MASTER = 'BECOME_MASTER'
const EVENT_DESTORY = 'DESTROY'
const EVENT_MESSAGE = 'MESSAGE'

export default class WorkerTransport extends EventEmitter implements Transport {
  public worker?: SharedWorker.SharedWorker
  public ready: boolean = false
  private pendingQueue: any[] = []

  constructor() {
    super()
    this.worker = new SharedWorker(this.genSource())
    this.worker.port.addEventListener('message', this.onMessage)
    this.worker.port.start()
    window.addEventListener('unload', () => {
      this.destroy()
    })
  }

  send(data: any) {
    if (this.ready) {
      this.worker!.port.postMessage({ type: EVENT_MESSAGE, data })
    } else {
      this.pendingQueue.push(data)
    }
  }

  destroy() {
    window.removeEventListener('unload', this.destroy)
    this.ready = false
    if (this.worker) {
      this.worker.port.removeEventListener('message', this.onMessage)
      this.worker.port.postMessage({ type: EVENT_DESTORY })
      this.worker = undefined
    }
  }

  private onMessage = (evt: MessageEvent) => {
    const message = evt.data as MesssagePayload
    const port = this.worker!.port
    switch (message.type) {
      case EVENT_PING:
        port.postMessage({ type: EVENT_PONG })
        break
      case EVENT_BECOME_MASTER:
        this.emit('master')
        break
      case EVENT_CONNECTED:
        this.ready = true
        this.emit('ready')
        this.flushPendingQueue()
        break
      default:
        this.emit('message', message.data)
        break
    }
  }

  private flushPendingQueue() {
    const queue = this.pendingQueue
    this.pendingQueue = []
    queue.forEach(data => {
      this.send(data)
    })
  }

  private genSource() {
    const source = workerSource.toString()
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  }
}

function workerSource(this: SharedWorker.SharedWorkerGlobalScope) {
  const EVENT_CONNECTED = 'CONNECTED'
  const EVENT_PONG = 'PONG'
  const EVENT_PING = 'PING'
  const EVENT_BECOME_MASTER = 'BECOME_MASTER'
  const EVENT_DESTORY = 'DESTROY'
  const ports: MessagePort[] = []
  let master: MessagePort | undefined

  function checkMaster() {
    if (master == null && ports.length) {
      master = ports[0]
      master.postMessage({ type: EVENT_BECOME_MASTER })
    }
  }

  function removePort(port: MessagePort) {
    const index = ports.indexOf(port)
    if (index !== -1) {
      ports.splice(index, 1)
    }

    if (master === port) {
      master = undefined
    }
  }

  function broadcast(data: MesssagePayload) {
    ports.forEach(port => port.postMessage(data))
  }

  function heartbeat() {
    setTimeout(() => {
      let i = ports.length
      while (i--) {
        const port = ports[i]
        // @ts-ignore
        if (port.zoombie) {
          removePort(port)
        } else {
          // @ts-ignore
          port.zoombie = true
          port.postMessage({ type: EVENT_PING })
        }
      }
      checkMaster()
      heartbeat()
    }, 500)
  }

  this.onconnect = function(evt) {
    const port = evt.ports[0]
    port.onmessage = function(evt) {
      const message = evt.data as MesssagePayload
      switch (message.type) {
        case EVENT_PONG:
          // @ts-ignore
          port.zoombie = false
          break
        case EVENT_DESTORY:
          removePort(port)
          checkMaster()
          break
        default:
          // forward to other ports
          broadcast(message)
      }
    }

    ports.push(port)
    port.start()
    port.postMessage(EVENT_CONNECTED)
    checkMaster()
  }

  heartbeat()
}

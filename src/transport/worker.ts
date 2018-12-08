/**
 * TODO: 处理因调试断开
 */
import EventEmitter from './event-emitter'
import { hash } from '../utils'
import { Transport, MesssagePayload, Peer, EVENTS } from './transport'

interface WorkerPayload extends MesssagePayload {
  target: string | number
  source: Peer
}

const WorkerPeer = {
  id: -1,
  name: 'worker',
}

const MAX_TRY_TIME = 4

export default class WorkerTransport extends EventEmitter implements Transport {
  private tryTimes: number = 0
  private id: number = 0
  private peers?: Peer[]
  private worker?: SharedWorker.SharedWorker
  private cmds: {
    [cmd: string]: Array<(data: any) => void>
  } = {}

  private get current() {
    return {
      id: this.id,
      name: this.name,
    }
  }

  constructor(name: string) {
    super(name)
    this.initializeWorker()
    window.addEventListener('unload', this.destroy)
  }

  async getPeers() {
    this.checkWorkerAvailable()
    if (this.peers == null) {
      return new Promise<Peer[]>(res => {
        this.callWorker(EVENTS.GET_PEERS, undefined, res)
      })
    }
    return this.peers
  }

  async getMaster() {
    this.checkWorkerAvailable()
    return new Promise<Peer>(res => {
      this.callWorker(EVENTS.GET_MASTER, undefined, res)
    })
  }

  destroy = () => {
    if (this.destroyed) {
      return
    }

    window.removeEventListener('unload', this.destroy)
    this.emit('destroy')

    if (this.worker) {
      this.worker.port.removeEventListener('message', this.onMessage)
      this.postMessage(WorkerPeer, { type: EVENTS.DESTORY })
      this.worker = undefined
    }
  }

  /**
   * rpc 调用workers 方法
   */
  private callWorker(name: string, data: any, callback: (data: any) => void) {
    this.checkWorkerAvailable()
    if (this.cmds[name]) {
      this.cmds[name].push(callback)
    } else {
      this.cmds[name] = [callback]
    }

    this.postMessage(WorkerPeer, { type: name, data })
  }

  private responseWorker(name: string, data: any) {
    if (this.cmds[name] && this.cmds[name].length) {
      const queue = this.cmds[name]
      this.cmds[name] = []
      queue.forEach(cb => cb(data))
    }
  }

  private initializeWorker = () => {
    if (this.tryTimes >= MAX_TRY_TIME) {
      return
    }

    this.tryTimes++

    try {
      this.worker = new SharedWorker(this.genSource())
    } catch (err) {
      console.warn('[itc] SharedWorker Error: ', err)
      this.initializeWorker()
      return
    }

    this.worker.onerror = this.handleWorkerError
    this.worker.port.addEventListener('message', this.onMessage)
    this.worker.port.start()
  }

  private handleWorkerError = (evt: ErrorEvent) => {
    const { filename, lineno, colno, message } = evt
    console.warn(`[itc] SharedWorker Error in ${filename}(${lineno}:${colno}): ${message}`)
    delete this.worker!.onerror
    this.worker = undefined
    this.initializeWorker()
  }

  private onMessage = (evt: MessageEvent) => {
    const message = evt.data as WorkerPayload
    const { target, source, type, data } = message
    switch (type) {
      case EVENTS.PING:
        this.postMessage(WorkerPeer, { type: EVENTS.PONG })
        break
      case EVENTS.BECOME_MASTER:
        this.emit('master')
        break
      case EVENTS.CONNECTED:
        this.id = data
        this.postMessage(WorkerPeer, { type: EVENTS.SETNAME, data: this.name })
        this.emit('ready')
        break
      case EVENTS.MESSAGE:
        this.emit('message', data)
        break
      case EVENTS.CALL:
        this.responseInternal(source, data)
        break
      case EVENTS.CALL_RESPONSE:
        this.callReturn(source, data.data)
        break
      case EVENTS.UPDATE_PEERS:
        this.peers = data
        this.emit('peerupdate', this.peers)
        break
      case EVENTS.UPDATE_MASTER:
        const master = data
        this.emit('masterupdate', master)
        break
      default:
        this.responseWorker(type, data)
        break
    }
  }

  protected postMessage(peer: Peer, data: MesssagePayload) {
    const payload: WorkerPayload = {
      target: peer.id,
      source: this.current,
      ...data,
    }
    this.worker!.port.postMessage(payload)
  }

  private genSource() {
    const source = `(${workerSource.toString()})(${JSON.stringify(EVENTS)})`
    const sourceHash = hash(source)
    const key = `itc-sw-${sourceHash}`
    let cachedUrl = window.localStorage.getItem(key)
    if (cachedUrl) {
      return cachedUrl
    } else {
      const cachedUrl = `data:text/javascript;base64,${btoa(source)}`
      window.localStorage.setItem(key, cachedUrl)
      return cachedUrl
    }
  }
}

export function workerSource(this: SharedWorker.SharedWorkerGlobalScope, events: typeof EVENTS) {
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
      // TODO:
      const peers = ports.filter(p => p !== port).map(p => ({ id: p.id, name: p.name }))
      port.postMessage({ type: events.UPDATE_PEERS, data: peers })
    })
  }

  function broadcast(data: MesssagePayload) {
    ports.forEach(port => port.postMessage(data))
  }

  function postMessage(data: WorkerPayload) {
    if (data.target == null || data.target === '*') {
      broadcast(data)
      return
    }

    if (data.target === -1) {
      return
    }

    const idx = ports.findIndex(i => i.id === data.target)
    if (idx !== -1) {
      ports[idx].postMessage(data)
    }
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
      const message = evt.data as WorkerPayload
      switch (message.type) {
        case events.PONG:
          port.zoombie = false
          break
        case events.MESSAGE:
          // forward to other ports
          postMessage(message)
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
          postMessage(message)
          break
      }
    })

    ports.push(port)
    port.start()
    port.postMessage({ type: events.CONNECTED, data: port.id })
    checkMaster()
    updatePeer()
  })
  heartbeat()
}

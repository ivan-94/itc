import EventEmitter from './event-emitter'
import { hash } from '../utils'
import { Transport, MesssagePayload, Peer, EVENTS } from './transport'
import workerSource from './worker-source'

const MAX_TRY_TIME = 4

export default class WorkerTransport extends EventEmitter implements Transport {
  name?: string
  ready: boolean = false
  destroyed: boolean = false
  private url?: string
  private tryTimes: number = 0
  private peers?: Peer[]
  private worker?: SharedWorker.SharedWorker
  private pendingQueue: any[] = []
  private cmds: {
    [cmd: string]: Array<(data: any) => void>
  } = {}

  constructor(url?: string) {
    super()
    this.url = url
    this.initializeWorker()
    window.addEventListener('unload', this.destroy)
  }

  async getPeers() {
    this.checkWorkerAvailable()
    if (this.peers == null) {
      return new Promise<Peer[]>(res => {
        this.call(EVENTS.GET_PEERS, undefined, res)
      })
    }
    return this.peers
  }

  async getMaster() {
    this.checkWorkerAvailable()
    return new Promise<Peer>(res => {
      this.call(EVENTS.GET_MASTER, undefined, res)
    })
  }

  setName(name: string) {
    this.checkWorkerAvailable()
    this.name = name
    this.worker!.port.postMessage({ type: EVENTS.SETNAME, data: name })
  }

  getName() {
    return this.name
  }

  send(data: any) {
    this.checkWorkerAvailable()
    if (this.ready && this.worker != null) {
      this.worker.port.postMessage({ type: EVENTS.MESSAGE, data })
    } else {
      this.pendingQueue.push(data)
    }
  }

  destroy = () => {
    if (this.destroyed) {
      return
    }

    window.removeEventListener('unload', this.destroy)
    this.ready = false
    this.destroyed = true

    if (this.worker) {
      this.worker.port.removeEventListener('message', this.onMessage)
      this.worker.port.postMessage({ type: EVENTS.DESTORY })
      this.worker = undefined
    }
  }

  private checkWorkerAvailable() {
    if (this.destroyed) {
      throw new Error('itc: cannot send message. current worker was destroyed.')
    }
  }

  /**
   * rpc 调用workers 方法
   */
  private call(name: string, data: any, callback: (data: any) => void) {
    this.checkWorkerAvailable()
    if (this.cmds[name]) {
      this.cmds[name].push(callback)
    } else {
      this.cmds[name] = [callback]
    }

    this.worker!.port.postMessage({ type: name, data })
  }

  private response(name: string, data: any) {
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
    const message = evt.data as MesssagePayload
    const port = this.worker!.port
    switch (message.type) {
      case EVENTS.PING:
        port.postMessage({ type: EVENTS.PONG })
        break
      case EVENTS.BECOME_MASTER:
        this.emit('master')
        break
      case EVENTS.CONNECTED:
        this.ready = true
        this.emit('ready')
        this.flushPendingQueue()
        break
      case EVENTS.MESSAGE:
        this.emit('message', message.data)
        break
      case EVENTS.UPDATE_PEERS:
        this.peers = message.data
        this.emit('peerupdate', this.peers)
        break
      case EVENTS.UPDATE_MASTER:
        const master = message.data
        this.emit('masterupdate', master)
        break
      default:
        this.response(message.type, message.data)
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
    if (this.url) {
      return this.url
    }
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

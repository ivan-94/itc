import { Peer, BroadcastPeer, MessagePayload, EVENTS, ERRORS } from './transport'

export type Handler = (data: any) => void
type CallHandler = (peer: Peer, ...args: any[]) => Promise<any>
export interface CallPayload {
  name: string
  id: number
  args: any[]
}

export interface CallResponse {
  name: string
  id: number
  data?: any
  error?: string
}

let uid = 0

export default abstract class EventEmitter {
  id: string | number = 0
  name: string
  ready: boolean = false
  destroyed: boolean = false
  get current(): Peer {
    return { id: this.id, name: this.name }
  }

  private queue: { [name: string]: Array<Handler> } = {}
  private defaultTimeout: number = 3000
  private callbacks: {
    [id: string]: { args: any[]; name: string; resolver: (data: any) => void; rejecter: (err: Error) => void }
  } = {}
  private handlers: {
    [name: string]: CallHandler
  } = {}
  private pendingQueue: Array<{ peer: Peer; data: any }> = []
  private watchingReady: Array<() => void> = []

  constructor(name: string) {
    this.name = name
    this.on('ready', () => {
      this.ready = true
      this.flushPendingQueue()
    })

    this.on('destroy', () => {
      this.ready = false
      this.destroyed = true
    })

    this.on('eventadded', (desc: { event: string; handle: Handler }) => {
      switch (desc.event) {
        case 'ready':
          this.ready && desc.handle(undefined)
          break
        case 'master':
          this.ready && this.isMaster().then(yes => yes && desc.handle(undefined))
          break
      }
    })
  }

  on(event: string, handle: Handler) {
    if (event in this.queue) {
      this.queue[event].push(handle)
    } else {
      this.queue[event] = [handle]
    }

    if (event !== 'eventadded') {
      this.emit('eventadded', { event, handle })
    }

    return () => {
      this.off(event, handle)
    }
  }

  off(event: string, handle: Handler) {
    if (event in this.queue) {
      const idx = this.queue[event].indexOf(handle)
      if (idx !== -1) {
        this.queue[event].splice(idx, 1)
      }
    }
  }

  emit(event: string, data?: any) {
    if (event in this.queue) {
      const handles = [...this.queue[event]]
      handles.forEach(h => h(data))
    }
  }

  setCallTimeout(time: number) {
    this.defaultTimeout = time
  }

  send(data: any, peer: Peer = BroadcastPeer) {
    this.checkWorkerAvailable()
    if (!this.ready) {
      this.pendingQueue.push({ peer, data })
      return
    }

    this.postMessage(peer, { type: EVENTS.MESSAGE, data: { data, source: this.current } })
  }

  /**
   * rpc call
   */
  call(peer: Peer, name: string, ...args: any[]): Promise<any> {
    this.checkWorkerAvailable()
    return this.waitReady().then(() => {
      return this.callInternal(peer, name, args, this.defaultTimeout)
    })
  }

  /**
   * response call
   */
  response(name: string, handler: CallHandler) {
    if (name in this.handlers) {
      throw new Error(`handler for ${name} was existed`)
    }
    this.handlers[name] = handler
  }

  abstract isMaster(): Promise<boolean>
  protected abstract postMessage(peer: Peer, message: MessagePayload): void

  protected waitReady() {
    return new Promise(res => {
      if (this.ready) {
        res()
      } else {
        this.watchingReady.push(res)
      }
    })
  }

  protected callInternal(peer: Peer, name: string, args: any[], timeout?: number): Promise<any> {
    return new Promise((res, rej) => {
      let fullfilled = false
      let id = uid++
      let timer: number

      const resolver = (data: any) => {
        if (fullfilled) {
          return
        }
        fullfilled = true
        if (timer) {
          clearTimeout(timer)
        }
        delete this.callbacks[id]
        res(data)
      }

      const rejecter = (err: Error) => {
        if (fullfilled) {
          return
        }
        fullfilled = true
        delete this.callbacks[id]
        rej(err)
      }

      this.callbacks[id] = {
        resolver,
        rejecter,
        name,
        args,
      }

      const payload: MessagePayload<CallPayload> = {
        type: EVENTS.CALL,
        data: {
          name,
          id,
          args,
        },
      }

      this.postMessage(peer, payload)

      if (timeout != null) {
        timer = window.setTimeout(() => {
          rejecter(new Error('timeout'))
        }, timeout)
      }
    })
  }

  /**
   * call 返回
   */
  protected callReturn(peer: Peer, response: CallResponse) {
    const { id, data, error, name } = response
    if (this.callbacks[id]) {
      const { resolver, rejecter } = this.callbacks[id]
      if (error != null) {
        rejecter(new Error(error))
      } else {
        resolver(data)
      }
    } else {
      console.warn(`callbacks[${name}] for id(${id}) not found!`)
    }
  }

  /**
   * 接收到call, 做出响应
   */
  protected responseInternal(peer: Peer, message: CallPayload) {
    const { id, name, args } = message
    const payload: MessagePayload<CallResponse> = {
      type: EVENTS.CALL_RESPONSE,
      data: { id, name },
    }

    if (this.handlers[name]) {
      this.handlers[name](peer, ...args)
        .then(data => {
          payload.data!.data = data
          this.postMessage(peer, payload)
        })
        .catch(error => {
          payload.data!.error = error.message
          this.postMessage(peer, payload)
        })
    } else {
      // not found
      payload.data!.error = ERRORS.NOT_FOUND
      this.postMessage(peer, payload)
    }
  }

  protected checkWorkerAvailable() {
    if (this.destroyed) {
      throw new Error('[itc]: current worker was destroyed.')
    }
  }

  private flushPendingQueue() {
    const queue = this.pendingQueue
    this.pendingQueue = []
    queue.forEach(q => this.send(q.data, q.peer))

    const watchingReady = this.watchingReady
    this.watchingReady = []
    watchingReady.forEach(q => q())
  }
}

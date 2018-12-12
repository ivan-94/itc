import WorkerTransport, { workerSource, ItcWorker, MAX_TRY_TIME } from '../worker'
import { EVENTS, Peer } from '../transport'
import { CallPayload } from '../event-emitter'

import { delay } from './helper'

declare global {
  namespace NodeJS {
    interface Global {
      SharedWorker: SharedWorker.SharedWorker
    }
  }
}

const noop: (...args: any[]) => any = () => {}
const peer1 = { id: 1, name: 'peer1' }
const peer2 = { id: 2, name: 'peer2' }
const peer3 = { id: 3, name: 'peer3' }

class MockPort implements MessagePort {
  id?: number
  name?: string
  zoombie?: boolean
  postedMessage: any[] = []
  started: boolean = false
  closed: boolean = false
  messageHandle?: (evt: MessageEvent) => void

  onmessage: ((this: MessagePort, ev: MessageEvent) => any) | null = null
  onmessageerror: ((this: MessagePort, ev: MessageEvent) => any) | null = null
  close() {
    this.closed = true
  }
  postMessage(message: any) {
    this.postedMessage.push(message)
  }
  start() {
    this.started = true
  }
  addEventListener(event: 'message', handle: any) {
    this.messageHandle = handle
  }

  removeEventListener(event: 'message', handle: any) {
    this.messageHandle = undefined
  }

  dispatchEvent = noop

  initial(name: string) {
    this.mockResponse({ type: EVENTS.INITIAL, data: { name } })
  }

  connected() {
    this.mockResponse({ type: EVENTS.CONNECTED, data: { id: 1, peers: [], master: { id: 1 } } })
  }

  pong() {
    this.mockResponse({ type: EVENTS.PONG })
  }

  ping() {
    this.mockResponse({ type: EVENTS.PING })
  }

  destroy() {
    this.mockResponse({ type: EVENTS.DESTORY })
  }

  mockResponse(data: any) {
    const evt = new Event('message') as MessageEvent
    // @ts-ignore
    evt.data = data
    this.messageHandle!(evt)
  }

  clearMessages() {
    this.postedMessage = []
  }

  lastMessage() {
    return this.postedMessage[this.postedMessage.length - 1]
  }
}

class MockSharedWorkerScope {
  connectHandler?: (event: Event) => void
  addEventListener(event: 'connect', handler: any) {
    this.connectHandler = handler
  }

  addNewConnect(port: MockPort) {
    const event = new Event('connect') as MessageEvent
    // @ts-ignore
    event.ports = [port]
    this.connectHandler!(event)
  }
}

class MockSharedWorker {
  src: string
  port = new MockPort()
  errorHandler?: (evt: ErrorEvent) => void
  constructor(src: string) {
    this.src = src
  }
  addEventListener(event: 'error', handler: any) {
    this.errorHandler = handler
  }
  removeEventListener(event: 'error', handle: any) {
    this.errorHandler = undefined
  }
  mockError(error: Error) {
    const event = new Event('error') as ErrorEvent
    // @ts-ignore
    event.filename = 'test'
    // @ts-ignore
    event.lineno = 11
    // @ts-ignore
    event.colno = 10
    // @ts-ignore
    event.message = 'mock error'
    if (this.errorHandler) {
      this.errorHandler(event)
    }
  }
}

beforeAll(() => {
  jest.useFakeTimers()
})
afterAll(() => {
  jest.useRealTimers()
})

describe('test worker source', () => {
  let workerScope: MockSharedWorkerScope
  let itcWorker: ItcWorker

  function initialPort(name: string) {
    const p = new MockPort()
    workerScope.addNewConnect(p)
    p.initial(name)
    p.clearMessages()
    return p
  }

  beforeEach(() => {
    workerScope = new MockSharedWorkerScope()
    // @ts-ignore
    itcWorker = workerSource(EVENTS, workerScope as SharedWorker.SharedWorkerGlobalScope)
  })

  it('should add connect listener', () => {
    expect(workerScope.connectHandler).toBeDefined()
  })

  it('port connect and initial', () => {
    const port1 = new MockPort()
    workerScope.addNewConnect(port1)
    expect(port1).toHaveProperty('id', itcWorker.uid - 1)
    expect(port1.started).toBeTruthy()
    expect(port1.postedMessage[0]).toMatchObject({
      type: EVENTS.CONNECTED,
      data: { id: port1.id, peers: [], master: { name: port1.name, id: port1.id } },
    })
    expect(port1.postedMessage[1]).toMatchObject({
      type: EVENTS.BECOME_MASTER,
    })
    expect(port1.postedMessage[2]).toMatchObject({
      type: EVENTS.UPDATE_MASTER,
    })
    expect(port1.messageHandle).toBeDefined()
    expect(itcWorker.ports).toContain(port1)
    expect(itcWorker.master).toBe(port1)

    // initial
    port1.initial('foo')
    expect(port1.name).toBe('foo')
  })

  it('port join', () => {
    const port1 = new MockPort()
    const port2 = new MockPort()
    workerScope.addNewConnect(port1)
    port1.initial('foo')
    port1.clearMessages()

    workerScope.addNewConnect(port2)
    expect(itcWorker.ports).toContain(port2)
    expect(itcWorker.master).toBe(port1)
    expect(port2.postedMessage[0]).toMatchObject({
      type: EVENTS.CONNECTED,
      data: { id: port2.id, peers: [{ name: port1.name, id: port1.id }], master: { name: port1.name, id: port1.id } },
    })
    port2.initial('bar')
    expect(port1.postedMessage[0]).toMatchObject({
      type: EVENTS.UPDATE_PEERS,
      data: [{ name: port2.name, id: port2.id }],
    })
  })

  it('heartbeat', () => {
    const [port1, port2] = ['foo', 'bar'].map(initialPort)
    port1.clearMessages()
    port2.clearMessages()

    jest.advanceTimersByTime(500)
    ;[port1, port2].forEach(p => {
      expect(p.zoombie).toBeTruthy()
      expect(p.postedMessage[0]).toMatchObject({ type: EVENTS.PING })
      p.pong()
      expect(p.zoombie).toBeFalsy()
    })
    jest.advanceTimersByTime(500)
    port1.pong()
    port1.clearMessages()
    jest.advanceTimersByTime(500)
    expect(itcWorker.ports).toContain(port1)
    expect(itcWorker.ports).not.toContain(port2)
    expect(port1.postedMessage[0]).toMatchObject({ type: EVENTS.UPDATE_PEERS, data: [] })
  })

  it('port detroy', () => {
    const ports = ['foo', 'bar'].map(initialPort)
    ports.forEach(p => p.clearMessages())
    ports[1].destroy()

    expect(itcWorker.ports).toContain(ports[0])
    expect(itcWorker.ports).not.toContain(ports[1])
    expect(ports[0].postedMessage[0]).toMatchObject({ type: EVENTS.UPDATE_PEERS, data: [] })
  })

  it('master change', () => {
    const ports = ['foo', 'bar'].map<MockPort>(initialPort)
    expect(itcWorker.master).toBe(ports[0])
    ports[0].destroy()
    expect(ports[1].postedMessage[0]).toMatchObject({ type: EVENTS.UPDATE_PEERS, data: [] })
    expect(ports[1].postedMessage[1]).toMatchObject({ type: EVENTS.BECOME_MASTER })
    expect(ports[1].postedMessage[2]).toMatchObject({ type: EVENTS.UPDATE_MASTER })
    expect(itcWorker.master).toBe(ports[1])
  })

  it('port reconnect', () => {
    const ports = ['foo', 'bar'].map<MockPort>(initialPort)
    expect(itcWorker.ports.length).toBe(2)
    ports[0].destroy()
    expect(itcWorker.ports.length).toBe(1)
    ports.forEach(p => p.clearMessages())

    // reconnect
    ports[0].pong()
    expect(ports[0].postedMessage[0]).toMatchObject({ type: EVENTS.UPDATE_PEERS })
    expect(ports[1].postedMessage[0]).toMatchObject({ type: EVENTS.UPDATE_PEERS })
    expect(ports[0].postedMessage[1]).toMatchObject({ type: EVENTS.UPDATE_MASTER, data: { id: ports[1].id } })
    expect(ports[0].zoombie).toBe(false)
  })

  describe('port message', () => {
    it('broadcast', () => {
      const ports = ['foo', 'bar', 'baz'].map<MockPort>(initialPort)
      const [port1, port2, port3] = ports
      // target == null
      const message1 = { type: EVENTS.MESSAGE, data: 1 }
      port1.mockResponse(message1)
      ports.filter(p => p !== port1).forEach(p => expect(p.lastMessage()).toMatchObject(message1))
      expect(port1.lastMessage()).not.toMatchObject(message1)

      // target == *
      const message2 = { type: EVENTS.MESSAGE, data: 2 }
      port2.mockResponse(message2)
      ports.filter(p => p !== port2).forEach(p => expect(p.lastMessage()).toMatchObject(message2))

      // unknown message type
      const message3 = { type: 'UNKNOWN', data: 3 }
      port3.mockResponse(message3)
      ports.filter(p => p !== port3).forEach(p => expect(p.lastMessage()).toMatchObject(message3))
    })

    it('peer to peer', () => {
      const ports = ['foo', 'bar', 'baz'].map<MockPort>(initialPort)
      const [port1, port2, port3] = ports
      ports.forEach(p => p.clearMessages())

      const message1 = { target: port2.id, type: EVENTS.MESSAGE, data: 1 }
      port1.mockResponse(message1)
      expect(port2.lastMessage()).toMatchObject(message1)
      expect(port3.lastMessage()).toBeUndefined()
      expect(port1.lastMessage()).toBeUndefined()
    })
  })
})

describe('test worker peer', () => {
  it('should retry after constructor throw error', () => {
    // @ts-ignore
    const fn = (global.SharedWorker = jest.fn(() => {
      throw new Error('MockError')
    }))
    const t = new WorkerTransport('name')
    expect(fn).toBeCalledTimes(MAX_TRY_TIME)
  })

  it('should retry after onerror throw error', () => {
    let worker: MockSharedWorker
    // @ts-ignore
    const fn = (global.SharedWorker = jest.fn(arg => {
      return (worker = new MockSharedWorker(arg))
    }))
    const t = new WorkerTransport('name')
    expect(fn).toBeCalled()
    worker!.mockError(new Error('test'))
    expect(fn).toBeCalledTimes(2)
  })

  describe('flows after constructor', () => {
    let worker: MockSharedWorker
    let fn: jest.Mock
    let transport: WorkerTransport

    beforeEach(() => {
      // @ts-ignore
      fn = global.SharedWorker = jest.fn(arg => {
        return (worker = new MockSharedWorker(arg))
      })
      transport = new WorkerTransport(peer1.name)
    })

    it('match source snapshot', () => {
      expect(worker.src).toMatchSnapshot()
    })

    it('should start port', () => {
      expect(worker.port.started).toBeTruthy()
      expect(worker.port.messageHandle).toBeDefined()
      expect(worker.errorHandler).toBeDefined()
    })

    it('connected', () => {
      const id = 1
      const peers = [peer1, peer2]
      const master = [peer1]
      const readyHandle = jest.fn()
      const readyHandle2 = jest.fn()
      transport.on('ready', readyHandle)
      worker.port.mockResponse({
        type: EVENTS.CONNECTED,
        data: {
          id,
          peers,
          master,
        },
      })

      // @ts-ignore
      expect(transport.peers).toBe(peers)
      // @ts-ignore
      expect(transport.currentMaster).toBe(master)
      // @ts-ignore
      expect(transport.id).toBe(id)
      expect(transport.ready).toBeTruthy()
      expect(worker.port.lastMessage()).toMatchObject({
        type: EVENTS.INITIAL,
        data: {
          name: peer1.name,
        },
      })

      expect(readyHandle).toBeCalled()
      // immediately fire
      transport.on('ready', readyHandle2)
      expect(readyHandle2).toBeCalled()
    })

    it('ping', () => {
      worker.port.ping()
      expect(worker.port.lastMessage()).toMatchObject({ type: EVENTS.PONG })
    })

    it('master & master change', async () => {
      const masterHandler = jest.fn()
      const masterHandler2 = jest.fn()
      const masterUpdateHandler = jest.fn()
      const masterLoseHandler = jest.fn()
      worker.port.connected()
      expect(transport.ready).toBeTruthy()
      transport.on('master', masterHandler)

      worker.port.mockResponse({ type: EVENTS.BECOME_MASTER })
      expect(masterHandler).toBeCalled()

      // immediately fire
      transport.on('master', masterHandler2)
      await delay()
      expect(masterHandler2).toBeCalled()

      // master update
      transport.on('masterupdate', masterUpdateHandler)
      transport.on('masterlose', masterLoseHandler)
      // @ts-ignore
      let newMaster = { id: transport.id, name: transport.name }
      worker.port.mockResponse({ type: EVENTS.UPDATE_MASTER, data: newMaster })
      expect(masterUpdateHandler).toBeCalledWith(newMaster)
      expect(masterLoseHandler).not.toBeCalled()

      // master lose
      newMaster = { id: 2, name: 'another' }
      worker.port.mockResponse({ type: EVENTS.UPDATE_MASTER, data: newMaster })
      expect(masterUpdateHandler).toBeCalledTimes(2)
      expect(masterLoseHandler).toBeCalled()
    })

    it('peer & peer change', async () => {
      worker.port.connected()
      const peerHandle = jest.fn()
      transport.on('peerupdate', peerHandle)
      let peers = await transport.getPeers()
      expect(peers).toEqual([])

      const newPeers = [{ id: 2, name: 'foo' }, { id: 3, name: 'bar' }]
      worker.port.mockResponse({ type: EVENTS.UPDATE_PEERS, data: newPeers })
      expect(peerHandle).toBeCalledWith(newPeers)
      peers = await transport.getPeers()
      expect(peers).toEqual(newPeers)
    })

    it('call send', async () => {
      worker.port.connected()
      // call self, will be ignore
      transport.call(peer1, 'name')
      await Promise.resolve()
      expect(worker.port.lastMessage()).not.toMatchObject({ type: EVENTS.CALL })

      transport.call(peer2, 'name', 1, '2', true, [], {})
      await Promise.resolve()
      expect(worker.port.lastMessage()).toMatchObject({
        type: EVENTS.CALL,
        target: peer2.id,
        source: { id: transport.id, name: transport.name },
        data: {
          name: 'name',
          args: [1, '2', true, [], {}],
        },
      })

      transport.response('foo', async (peer: Peer, count: number) => {
        expect(count).toBe(5)
        expect(peer).toMatchObject(peer2)
        return count + 1
      })

      worker.port.mockResponse({
        type: EVENTS.CALL,
        data: {
          id: 5,
          name: 'foo',
          args: [5],
        },
        source: peer2,
      })
      await Promise.resolve()
      expect(worker.port.lastMessage()).toMatchObject({
        type: EVENTS.CALL_RESPONSE,
        target: peer2.id,
        source: peer1,
        data: {
          id: 5,
          name: 'foo',
          data: 6,
        },
      })

      // reponse error
      transport.response('bar', async () => {
        throw new Error('testError')
      })
      worker.port.mockResponse({
        type: EVENTS.CALL,
        data: {
          id: 5,
          name: 'bar',
          args: [5],
        },
        source: peer2,
      })
      await delay()
      expect(worker.port.lastMessage()).toMatchObject({
        type: EVENTS.CALL_RESPONSE,
        target: peer2.id,
        source: peer1,
        data: {
          id: 5,
          name: 'bar',
          error: 'testError',
        },
      })
    })

    it('call response', async () => {
      worker.port.connected()
      const res = jest.fn()
      const rej = jest.fn()
      transport.call(peer2, 'foo', 1, '2', true).then(res)
      await delay()
      let data = worker.port.lastMessage().data as CallPayload
      const returnData = { a: 1, b: '2', c: {}, d: [] }
      worker.port.mockResponse({
        type: EVENTS.CALL_RESPONSE,
        target: peer1.id,
        source: peer2,
        data: {
          name: 'foo',
          id: data.id,
          data: returnData,
        },
      })
      await delay()
      expect(res).toBeCalledWith(returnData)

      // test reject
      transport.call(peer2, 'bar', 1, '2', true).catch(rej)
      await Promise.resolve()
      data = worker.port.lastMessage().data as CallPayload
      const returnError = 'testError'
      worker.port.mockResponse({
        type: EVENTS.CALL_RESPONSE,
        target: peer1.id,
        source: peer2,
        data: {
          name: 'bar',
          id: data.id,
          error: returnError,
        },
      })
      await delay()
      expect(rej.mock.calls[0]).toMatchObject([{ message: returnError }])
    })

    it('message receive', () => {
      const port = worker.port
      const messageHandler = jest.fn()
      transport.on('message', messageHandler)
      port.connected()

      // same source
      port.mockResponse({ type: EVENTS.MESSAGE, data: 1, source: peer1 })
      expect(messageHandler).not.toBeCalled()
      ;[1, '2', true, { a: 1 }, []].forEach(d => {
        port.mockResponse({ type: EVENTS.MESSAGE, data: d, source: peer2 })
        expect(messageHandler).toBeCalledWith(d)
      })
    })

    it('message send', () => {
      const port = worker.port
      port.connected()
      // same source
      transport.send(1, peer1)
      expect(port.lastMessage()).not.toMatchObject({ type: EVENTS.MESSAGE })

      // broadcast
      transport.send(2)
      expect(port.lastMessage()).toMatchObject({ type: EVENTS.MESSAGE, data: 2, target: '*', source: peer1 })
      ;[1, '2', true, { a: 1 }, []].forEach(d => {
        transport.send(d, peer2)
        expect(port.lastMessage()).toMatchObject({
          type: EVENTS.MESSAGE,
          data: d,
          source: peer1,
        })
      })
    })

    it('destroy', () => {
      const destroyHandle = jest.fn()
      transport.on('destroy', destroyHandle)
      transport.destroy()
      expect(destroyHandle).toBeCalled()
      expect(worker.port.messageHandle).toBeUndefined()
      expect(worker.port.lastMessage()).toMatchObject({ type: EVENTS.DESTORY })
      ;['getPeers', 'getMaster', 'isMaster', 'send', 'call'].forEach(name => {
        expect(() => {
          // @ts-ignore
          transport[name]()
        }).toThrow()
      })
    })
  })
})

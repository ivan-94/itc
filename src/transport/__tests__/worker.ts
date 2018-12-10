import { workerSource, ItcWorker } from '../worker'
import { EVENTS } from '../transport'

const noop: (...args: any[]) => any = () => {}

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
  removeEventListener = noop
  dispatchEvent = noop

  initial(name: string) {
    this.mockResponse({ type: EVENTS.INITIAL, data: { name } })
  }

  pong() {
    this.mockResponse({ type: EVENTS.PONG })
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

class MockSharedWorker {
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

describe('test worker source', () => {
  let worker: MockSharedWorker
  let itcWorker: ItcWorker

  function initialPort(name: string) {
    const p = new MockPort()
    worker.addNewConnect(p)
    p.initial(name)
    p.clearMessages()
    return p
  }

  beforeAll(() => {
    jest.useFakeTimers()
  })

  beforeEach(() => {
    worker = new MockSharedWorker()
    // @ts-ignore
    itcWorker = workerSource(EVENTS, worker as SharedWorker.SharedWorkerGlobalScope)
  })

  it('should add connect listener', () => {
    expect(worker.connectHandler).toBeDefined()
  })

  it('port connect and initial', () => {
    const port1 = new MockPort()
    worker.addNewConnect(port1)
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
    worker.addNewConnect(port1)
    port1.initial('foo')
    port1.clearMessages()

    worker.addNewConnect(port2)
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

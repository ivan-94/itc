import EventEmitter, { CallPayload, CallResponse } from '../event-emitter'
import { Peer, MesssagePayload, EVENTS, ERRORS } from '../transport'
import { delay } from './helper'

const peer1 = { id: 1, name: 'peer1' }
const peer2 = { id: 2, name: 'peer2' }
const peer3 = { id: 3, name: 'peer3' }
const h1 = jest.fn()
const h2 = jest.fn()
const h3 = jest.fn()
const msg1 = { type: 'MSG1', data: 1 }
const msg2 = { type: 'MSG2', data: [] }
const msg3 = { type: 'MSG3', data: { a: 1, b: 'b' } }

beforeEach(() => {
  h1.mockClear()
  h2.mockClear()
  h3.mockClear()
})

describe('test event listener', () => {
  class Sub extends EventEmitter {
    postMessage(peer: any, message: any) {}
    isMaster() {
      return Promise.resolve(true)
    }
  }
  let foo: Sub

  beforeEach(() => {
    foo = new Sub('test')
  })

  it('should add to queue', () => {
    foo.on('one', h1)
    foo.on('two', h2)
    foo.on('two', h3)

    foo.emit('one')
    expect(h1).toBeCalled()
    expect(h2).not.toBeCalled()

    foo.emit('two')
    expect(h2).toBeCalled()
    expect(h2).toBeCalled()
  })

  it('should not be call after off', () => {
    foo.on('one', h1)
    const h2Disposer = foo.on('one', h2)

    foo.emit('one')
    expect(h1).toBeCalledTimes(1)
    expect(h2).toBeCalledTimes(1)

    foo.off('one', h1)
    foo.emit('one')
    expect(h1).toBeCalledTimes(1)
    expect(h2).toBeCalledTimes(2)

    h2Disposer()
    foo.emit('one')
    expect(h1).toBeCalledTimes(1)
    expect(h2).toBeCalledTimes(2)
  })

  it('should emit eventadded after custom handle added', () => {
    const eventaddedHandler = jest.fn()
    foo.on('eventadded', eventaddedHandler)
    foo.on('foo', h1)
    expect(eventaddedHandler).lastCalledWith({ event: 'foo', handle: h1 })

    foo.on('bar', h2)
    expect(eventaddedHandler).lastCalledWith({ event: 'bar', handle: h2 })
  })

  it('should receive data pass by emit()', () => {
    foo.on('foo', h1)
    foo.emit('foo', 'hello')
    expect(h1).lastCalledWith('hello')

    foo.emit('foo', [])
    expect(h1).lastCalledWith([])

    foo.emit('foo')
    expect(h1).lastCalledWith(undefined)
  })
})

describe('test ready and detroy', () => {
  class TestReady extends EventEmitter {
    messages: Array<{ peer: Peer; message: MesssagePayload }> = []
    postMessage(peer: Peer, message: MesssagePayload) {
      this.messages.push({ peer, message })
    }
    isMaster() {
      return Promise.resolve(true)
    }
  }

  let instance: TestReady
  beforeEach(() => {
    instance = new TestReady('name')
  })

  it('should set #ready to true', () => {
    instance.emit('ready')
    expect(instance.ready).toBeTruthy()
  })

  it('should call event handle immediately when #ready == true', () => {
    instance.on('ready', h1)
    instance.emit('ready')
    expect(h1).toBeCalled()
    instance.on('ready', h2)
    expect(h2).toBeCalled()
  })

  it('should push to pending queue when not ready', () => {
    instance.send(msg1, peer1)
    instance.send(msg2, peer2)
    expect(instance.messages.length).toBe(0)
    instance.emit('ready')
    expect(instance.messages.length).toBe(2)

    // send immediately
    instance.send(msg2, peer2)
    expect(instance.messages.length).toBe(3)
  })

  it('should fullfilled waitReady after ready', async () => {
    // @ts-ignore
    const promise = instance.waitReady()
    setTimeout(() => {
      // @ts-ignore
      expect(instance.watchingReady.length).toBe(1)
      instance.emit('ready')
      // @ts-ignore
      expect(instance.watchingReady.length).toBe(0)
    })

    return expect(promise).resolves.toBeUndefined()
  })

  it('should fullfilled immediately when ready', async () => {
    instance.emit('ready')
    // @ts-ignore
    return expect(instance.waitReady()).resolves.toBeUndefined()
  })

  it('should set #destroyed to true', () => {
    instance.emit('destroy')
    expect(instance.ready).toBeFalsy()
    expect(instance.destroyed).toBeTruthy()
  })

  it('should throw error when send() & call() after destroyed', () => {
    instance.emit('destroy')
    expect(() => {
      instance.send('xxx')
    }).toThrowError()
    expect(() => {
      instance.call(peer1, 'foo')
    }).toThrowError()
  })
})

describe('test call', () => {
  class TestCall extends EventEmitter {
    mockTransport: jest.Mock = jest.fn()
    constructor(name: string) {
      super(name)
    }

    postMessage(peer: Peer, message: MesssagePayload) {
      this.mockTransport(peer, message)
    }

    mockCallReturn(peer: Peer, response: CallResponse) {
      this.callReturn(peer, response)
    }

    mockReponse(peer: Peer, message: CallPayload) {
      this.responseInternal(peer, message)
    }

    isMaster() {
      return Promise.resolve(true)
    }
  }

  beforeEach(() => {
    jest.useRealTimers()
  })

  it('should pending when not ready', async () => {
    const instance = new TestCall('name')
    const promise = instance.call(peer1, 'foo')
    await Promise.resolve()
    expect(instance.mockTransport).not.toBeCalled()
    instance.emit('ready')
    await Promise.resolve()
    expect(instance.mockTransport).toBeCalled()
  })

  it('should timeout when peer not response', async () => {
    const instance = new TestCall('name')
    instance.emit('ready')
    expect(instance.ready).toBeTruthy()

    jest.useFakeTimers()
    const catcher = jest.fn()
    const promise = instance.call(peer1, 'foo').catch(catcher)
    await delay()
    jest.advanceTimersByTime(3000)
    await delay()
    expect(instance.mockTransport).toBeCalled()
    expect(catcher).toBeCalled()
    expect(catcher.mock.calls[0]).toMatchObject([{ message: 'timeout' }])
  })

  describe('should call postMessage', () => {
    it.each`
      peer     | name       | args
      ${peer1} | ${'one'}   | ${[1, 2, 3]}
      ${peer2} | ${'two'}   | ${['one', 'two']}
      ${peer3} | ${'three'} | ${[{}]}
    `('call($peer, $name, ...$args)', async ({ peer, name, args }) => {
      const instance = new TestCall('name')
      instance.emit('ready')
      instance.call(peer, name, ...args)
      await Promise.resolve()
      const [callPeer, payload] = instance.mockTransport.mock.calls[0]
      expect(callPeer).toBe(peer)
      expect(payload).toMatchObject({ type: EVENTS.CALL, data: { name, args } })
    })
  })

  describe('callReturn from peer', () => {
    it.each`
      peer     | name       | data              | error
      ${peer1} | ${'one'}   | ${1}              | ${undefined}
      ${peer2} | ${'two'}   | ${{ a: 1, b: 2 }} | ${undefined}
      ${peer3} | ${'three'} | ${undefined}      | ${'customError'}
    `('callReturn($peer, {error: $error, data: $data})', async ({ peer, name, data, error }) => {
      const instance = new TestCall('name')
      instance.emit('ready')
      const res = jest.fn()
      const rej = jest.fn()
      const promise = instance.call(peer, name, []).then(res, rej)
      await Promise.resolve()
      expect(instance.mockTransport).toBeCalled()
      const [callPeer, payload] = instance.mockTransport.mock.calls[0]
      const response = {
        id: payload.data.id,
        name: payload.data.name,
        data,
        error,
      }
      instance.mockCallReturn(callPeer, response)
      return promise.then(() => {
        if (data) {
          expect(res).toBeCalledWith(data)
          expect(rej).not.toBeCalled()
        } else {
          expect(rej.mock.calls[0]).toMatchObject([{ message: error }])
          expect(res).not.toBeCalled()
        }
      })
    })
  })

  describe('test response', () => {
    it('should response data', async () => {
      const instance = new TestCall('name')
      const data = ['TEST']
      const h = jest.fn(() => Promise.resolve(data))
      instance.response('foo', h)
      instance.mockReponse(peer1, { id: 1, name: 'foo', args: [1, 2] })
      expect(h).toBeCalledWith(peer1, 1, 2)
      await Promise.resolve()
      expect(instance.mockTransport).toBeCalledWith(peer1, {
        type: EVENTS.CALL_RESPONSE,
        data: { id: 1, name: 'foo', data },
      })
    })

    it('should response error', async () => {
      const instance = new TestCall('name')
      jest.useFakeTimers()
      const error = 'TEST'
      const h = jest.fn(() => Promise.reject(new Error(error)))
      instance.response('foo', h)
      instance.mockReponse(peer1, { id: 1, name: 'foo', args: [1, 2] })
      expect(h).toBeCalledWith(peer1, 1, 2)
      await delay()
      expect(instance.mockTransport).toBeCalledWith(peer1, {
        type: EVENTS.CALL_RESPONSE,
        data: { id: 1, name: 'foo', data: undefined, error },
      })
    })

    it('should response not found error when not handler found', () => {
      const instance = new TestCall('name')
      instance.mockReponse(peer1, { id: 1, name: 'foo', args: [1, 2] })
      expect(instance.mockTransport).toBeCalledWith(peer1, {
        type: EVENTS.CALL_RESPONSE,
        data: { id: 1, name: 'foo', data: undefined, error: ERRORS.NOT_FOUND },
      })
    })
  })
})

import * as utils from '../../utils'
import StorageTransport, { StoragePayload, PeerInfo } from '../storage'
import { EVENTS, Peer, INNER_CALL } from '../transport'
import { CallResponse, CallPayload } from '../event-emitter'
import { delay } from './helper'

jest.mock('../../utils')

const mockAddListener = jest.spyOn(window, 'addEventListener')
const mockRemoveListener = jest.spyOn(window, 'removeEventListener')

const peer1 = { id: '1', name: 'peer1' }
const peer2 = { id: '2', name: 'peer2' }
const peer3 = { id: '3', name: 'peer3' }

beforeAll(() => {
  jest.useFakeTimers()
})

afterAll(() => {
  jest.useRealTimers()
})

describe('storage transport', () => {
  let transport: StorageTransport
  let storageHandler: undefined | ((evt: StorageEvent) => void)
  let unloadHandler: undefined | (() => void)
  let readyHandle = jest.fn()
  let masterHandle = jest.fn()
  let destroyHandle = jest.fn()
  let masterupdateHandle = jest.fn()
  let masterloseHandle = jest.fn()
  let peerupdateHandle = jest.fn()
  let postedMessage: Array<{ key: string; value: any }> = []
  // @ts-ignore
  const mockStorage = {
    getItem: jest.fn((key: string) => {
      return window.localStorage.getItem(key)
    }),
    setItem: jest.fn((key: string, value: string) => {
      postedMessage.push({ key, value: JSON.parse(value) })
      window.localStorage.setItem(key, value)
    }),
  } as Storage

  mockAddListener.mockImplementation((event: string, handle) => {
    switch (event) {
      case 'storage':
        storageHandler = handle
        break
      case 'unload':
        unloadHandler = handle
        break
    }
  })

  mockRemoveListener.mockImplementation((event: string) => {
    switch (event) {
      case 'storage':
        storageHandler = undefined
        break
      case 'unload':
        unloadHandler = undefined
        break
    }
  })

  function mockStorageEvent(key: string, value: any) {
    const _key = key && `_ITC_.${key}`
    const _value = value && JSON.stringify(value)
    const evt = {
      key: _key,
      newValue: _value,
    } as StorageEvent
    if (_key) {
      window.localStorage.setItem(_key!, _value)
    }
    return storageHandler!(evt)
  }

  function mockStorageMessage(target: Peer, source: Peer, type: string, data: any) {
    return mockStorageEvent('message', { target: target.id, source, data: { type, data } })
  }

  function getLastMessage() {
    return postedMessage[postedMessage.length - 1]
  }

  function clearMessage() {
    postedMessage = []
  }

  beforeEach(() => {
    storageHandler = undefined
    unloadHandler = undefined
    readyHandle.mockClear()
    masterHandle.mockClear()
    destroyHandle.mockClear()
    masterupdateHandle.mockClear()
    masterloseHandle.mockClear()
    peerupdateHandle.mockClear()
    postedMessage = []
    window.localStorage.clear()
    transport = new StorageTransport(peer1.name, mockStorage)
  })

  afterEach(() => {
    transport.destroy()
  })

  it('start & destroy', async () => {
    transport.on('ready', readyHandle)
    transport.on('master', masterHandle)
    transport.on('destroy', destroyHandle)
    expect(storageHandler).toBeDefined()
    expect(unloadHandler).toBeDefined()
    expect(transport.id).toBe('1')
    expect(transport.name).toBe(peer1.name)

    // preempt master
    await delay()
    expect(getLastMessage()).toMatchObject({ key: '_ITC_.master', value: { id: transport.id, name: transport.name } })
    jest.advanceTimersByTime(100)
    await delay()
    expect(transport.ready).toBeTruthy()
    expect(readyHandle).toBeCalled()
    expect(masterHandle).toBeCalled()

    // first ping
    await delay()
    jest.advanceTimersByTime(1)
    expect(getLastMessage()).toMatchObject({
      key: '_ITC_.message',
      value: {
        data: { type: EVENTS.PING },
        target: '*',
        source: {
          id: transport.id,
          name: transport.name,
        },
      },
    })

    // destroy
    transport.destroy()
    expect(getLastMessage()).toMatchObject({
      key: '_ITC_.message',
      value: {
        target: '*',
        data: { type: EVENTS.DESTROY },
      },
    })
    expect(destroyHandle).toBeCalled()
    expect(storageHandler).toBeUndefined()
    expect(unloadHandler).toBeUndefined()
    ;['getPeers', 'getMaster', 'isMaster', 'send', 'call'].forEach(name => {
      expect(() => {
        // @ts-ignore
        transport[name]()
      }).toThrow()
    })
    // flush other async actions
    await delay()
  })

  describe('storage event handle', () => {
    it('should be ignore when key or value == null or', async () => {
      // @ts-ignore
      expect(mockStorageEvent(null, 1)).toBeFalsy()
      expect(mockStorageEvent('foo', null)).toBeFalsy()
      expect(mockStorageEvent('foo..x', 1)).toBeFalsy()
      expect(mockStorageEvent('unknown', 1)).toBeFalsy()
      // flush other async actions
      await delay()
    })

    it('is ok', async () => {
      expect(mockStorageEvent('master', 1)).toBeTruthy()
      expect(mockStorageEvent('message', { target: '*', source: { id: 8 }, data: { type: EVENTS.PING } })).toBeTruthy()
      // flush other async actions
      await delay()
    })

    describe('test message', () => {
      it.each`
        desc                    | target   | source   | type           | data    | expected
        ${`target not match`}   | ${peer2} | ${peer2} | ${EVENTS.PING} | ${null} | ${false}
        ${`same source`}        | ${peer1} | ${peer1} | ${EVENTS.PING} | ${null} | ${false}
        ${`unknown target`}     | ${-1}    | ${peer2} | ${EVENTS.PING} | ${null} | ${false}
        ${`unknown event type`} | ${peer1} | ${peer2} | ${'unknown'}   | ${null} | ${false}
      `(`should ignore when $desc`, async ({ target, source, type, data, expected }) => {
        expect(mockStorageMessage(target, source, type, data)).toBe(expected)
        // flush other async actions
        await delay()
      })

      it.each`
        desc                     | target   | source   | type                    | data                                         | expected
        ${`EVENTS.PING`}         | ${peer1} | ${peer2} | ${EVENTS.PING}          | ${null}                                      | ${true}
        ${`EVENTS.PONG`}         | ${peer1} | ${peer2} | ${EVENTS.PONG}          | ${peer2}                                     | ${true}
        ${`EVENTS.DESTROY`}      | ${peer1} | ${peer2} | ${EVENTS.DESTROY}       | ${peer2}                                     | ${true}
        ${`EVENTS.CALL`}         | ${peer1} | ${peer2} | ${EVENTS.CALL}          | ${{ data: { id: 1, name: 'foo' } }}          | ${true}
        ${`EVENTS.CALL_REPONSE`} | ${peer1} | ${peer2} | ${EVENTS.CALL_RESPONSE} | ${{ data: { id: 1, name: 'foo', data: 1 } }} | ${true}
        ${`EVENTS.MESSAGE`}      | ${peer1} | ${peer2} | ${EVENTS.MESSAGE}       | ${1}                                         | ${true}
      `(`valid events: $desc`, async ({ target, source, type, data, expected }) => {
        expect(mockStorageMessage(target, source, type, data)).toBe(expected)
        // flush other async actions
        await delay()
      })
    })
  })

  describe('master preempt', () => {
    it('master not alive and not race', async () => {
      transport.on('master', masterHandle)
      transport.on('masterupdate', masterupdateHandle)
      await delay()
      expect(getLastMessage()).toMatchObject({ key: '_ITC_.master', value: { id: transport.id, name: transport.name } })
      // not other tab preempt. exhaust time
      jest.advanceTimersByTime(100)
      expect(masterHandle).toBeCalled()
      expect(masterupdateHandle).toBeCalledWith(peer1)

      // flush other async actions
      await delay()
    })

    it('master preempt simultaneously', async () => {
      transport.on('masterupdate', masterupdateHandle)
      // peer1 set master first
      await delay()
      expect(getLastMessage()).toMatchObject({ key: '_ITC_.master', value: { id: transport.id, name: transport.name } })
      // mock peer2 preempt
      mockStorageEvent('master', peer2)
      // @ts-ignore
      expect(transport.currentMaster).toEqual(peer2)
      expect(masterupdateHandle).toBeCalledWith(peer2)

      // take peer2 as master
      const master = await transport.getMaster()
      expect(master).toEqual(peer2)

      // flush other async actions
      await delay()
    })

    it('master existed but not alive', async () => {
      // transport setItem to peer1, to mock master alreay existed
      await delay()
      // create peer2
      ;(utils.uuid as jest.Mock).mockReturnValueOnce(peer2.id)
      const transport2 = new StorageTransport(peer2.name, mockStorage)
      expect(transport2.id).toBe(peer2.id)
      await delay()
      expect(getLastMessage()).toMatchObject({
        value: {
          // check peer1 is alive
          target: peer1.id,
          source: peer2,
          data: { type: EVENTS.CALL, data: { name: INNER_CALL.CHECK_ALIVE } },
        },
      })

      // no response
      jest.advanceTimersByTime(1000)
      await delay()
      // retry preempt
      expect(getLastMessage()).toMatchObject({
        key: '_ITC_.master',
        value: { id: transport2.id, name: transport2.name },
      })

      // flush other async actions
      await delay()
    })

    it('master existed and alive', async () => {
      // transport setItem to peer1, to mock master alreay existed
      await delay()
      // create peer2
      ;(utils.uuid as jest.Mock).mockReturnValueOnce(peer2.id)
      const transport2 = new StorageTransport(peer2.name, mockStorage)
      await delay()
      const lastMessage = getLastMessage().value as StoragePayload<CallPayload>
      const callResponse: CallResponse = {
        name: INNER_CALL.CHECK_ALIVE,
        id: lastMessage.data.data!.id,
        data: {},
      }

      // mock reponse CHECK_ALIVE
      mockStorageMessage(peer2, peer1, EVENTS.CALL_RESPONSE, callResponse)
      await delay()
      // @ts-ignore
      expect(transport2.currentMaster).toEqual(peer1)

      // flush other async actions
      transport2.destroy()
      await delay()
    })

    it('use master heartbeat to detect master dead, and repreempt', async () => {
      const t = transport
      t.on('masterupdate', masterupdateHandle)
      t.on('ready', readyHandle)
      // mock peer2 preempt
      mockStorageEvent('master', peer2)
      await delay()
      expect(masterupdateHandle).toBeCalled()
      expect(await t.getMaster()).toEqual(peer2)
      expect(readyHandle).toBeCalled()

      // @ts-ignore mock master heartbeat
      const callInternal = jest.spyOn(t, 'callInternal')
      callInternal.mockImplementation(() => Promise.reject(new Error('timeout')))
      jest.advanceTimersByTime(1000)
      await delay()
      // retry 2 times
      expect(callInternal).toBeCalledTimes(2)
      expect(callInternal).toBeCalledWith(peer2, INNER_CALL.CHECK_ALIVE, [], 200)

      // re-preempt
      t.on('master', masterHandle)
      await delay()
      expect(getLastMessage()).toMatchObject({ key: '_ITC_.master', value: { id: transport.id } })
      jest.advanceTimersByTime(100)
      await delay()
      // become master
      expect(await t.isMaster()).toBeTruthy()
      expect(masterHandle).toBeCalled()
    })

    it('master lose & and become master', async () => {
      const t = transport
      await delay()
      jest.advanceTimersByTime(100)
      expect(await t.isMaster()).toBeTruthy()

      // @ts-ignore
      const masterHB = jest.spyOn(t, 'masterHeartBeat')
      t.on('masterlose', masterloseHandle)
      t.on('masterupdate', masterupdateHandle)

      // master update
      mockStorageEvent('master', peer2)
      expect(masterloseHandle).toBeCalled()
      expect(masterupdateHandle).toBeCalled()
      expect(masterHB).toBeCalled()
    })

    it('master auto correct', async () => {
      const t = transport
      await delay()
      mockStorageEvent('master', peer2)
      expect(await t.getMaster()).toEqual(peer2)

      // mock incorrect CHECK_ALIVE
      mockStorageMessage(peer1, peer2, EVENTS.CALL, { name: INNER_CALL.CHECK_ALIVE })
      await delay()
      expect(getLastMessage()).toMatchObject({
        value: {
          data: {
            type: EVENTS.CALL_RESPONSE,
            data: {
              name: INNER_CALL.CHECK_ALIVE,
              data: {
                status: 'correction',
              },
            },
          },
        },
      })
    })
  })

  describe('peer update', () => {
    it('updatePeers', () => {
      const t = transport
      t.on('peerupdate', peerupdateHandle)
      const now = 1544611676008
      const mockPeers: PeerInfo[] = [
        {
          ...peer2,
          lastUpdate: now,
        },
        {
          ...peer3,
          lastUpdate: now + 2000,
        },
      ]
      // @ts-ignore
      t.peers = mockPeers
      const mockNow = jest.spyOn(Date, 'now')
      mockNow.mockReturnValue(now + 2000)
      // @ts-ignore
      t.updatePeers()
      expect(peerupdateHandle).not.toBeCalled()

      // advance
      mockNow.mockReturnValue(now + 4001)
      // @ts-ignore
      t.updatePeers()
      expect(peerupdateHandle).toBeCalledWith([peer3])

      // advance
      mockNow.mockReturnValue(now + 6001)
      // @ts-ignore
      t.updatePeers()
      expect(peerupdateHandle).toHaveBeenLastCalledWith([])
    })

    it('peer join', async () => {
      const t = transport
      t.on('peerupdate', peerupdateHandle)
      // some source, will ignore
      expect(mockStorageMessage(peer1, peer1, EVENTS.PONG, undefined)).toBeFalsy()
      expect(mockStorageMessage(peer1, peer2, EVENTS.PONG, undefined)).toBeTruthy()
      // @ts-ignore
      expect(t.peers).toMatchObject([peer2])
      expect(peerupdateHandle).toBeCalled()

      expect(mockStorageMessage(peer1, peer3, EVENTS.PONG, undefined)).toBeTruthy()
      // @ts-ignore
      expect(t.peers).toMatchObject([peer2, peer3])
      expect(peerupdateHandle).toBeCalledTimes(2)
    })

    it('peer destroy', () => {
      const t = transport
      t.on('peerupdate', peerupdateHandle)
      // @ts-ignore
      t.peers = [peer2, peer3]
      // @ts-ignore
      const getPeers = () => t.peers

      mockStorageMessage(peer1, { id: 10, name: 'unknown' }, EVENTS.DESTROY, undefined)
      expect(peerupdateHandle).not.toBeCalled()
      expect(getPeers()).toMatchObject([peer2, peer3])

      mockStorageMessage(peer1, peer2, EVENTS.DESTROY, undefined)
      expect(peerupdateHandle).toBeCalled()
      expect(getPeers()).toMatchObject([peer3])
    })
  })

  describe('call & message', () => {
    beforeEach(() => {
      transport.ready = true
    })

    it('call send', async () => {
      // call self, will be ignore
      // @ts-ignore
      const call = (...args: any[]) => transport.callInternal(...args)
      call(peer1, 'name', [], 3000)
      await delay()
      expect(getLastMessage()).not.toMatchObject({ value: { data: { type: EVENTS.CALL } } })
      call(peer2, 'name', [1, '2', true, [], {}])
      await delay()
      expect(getLastMessage()).toMatchObject({
        value: {
          data: {
            type: EVENTS.CALL,
            data: {
              name: 'name',
              args: [1, '2', true, [], {}],
            },
          },
        },
      })

      transport.response('foo', async (peer: Peer, count: number) => {
        expect(count).toBe(5)
        expect(peer).toMatchObject(peer2)
        return count + 1
      })

      mockStorageMessage(peer1, peer2, EVENTS.CALL, { id: 5, name: 'foo', args: [5] })
      await delay()
      expect(getLastMessage()).toMatchObject({
        value: {
          data: { type: EVENTS.CALL_RESPONSE, data: { id: 5, name: 'foo', data: 6 } },
        },
      })

      // response error
      transport.response('bar', async () => {
        throw new Error('testError')
      })
      mockStorageMessage(peer1, peer2, EVENTS.CALL, {
        id: 5,
        name: 'bar',
        args: [5],
      })
      await delay()
      expect(getLastMessage()).toMatchObject({
        value: {
          data: {
            type: EVENTS.CALL_RESPONSE,
            data: {
              id: 5,
              name: 'bar',
              error: 'testError',
            },
          },
        },
      })
    })

    it('call reponse', async () => {
      const res = jest.fn()
      const rej = jest.fn()
      // @ts-ignore
      const call = (...args: any[]) => transport.callInternal(...args)
      call(peer2, 'foo', [1, '2', true], 1000).then(res)
      await delay()
      let data = getLastMessage().value.data.data as CallPayload
      const returnData = { a: 1, b: '2', c: {}, d: [] }
      mockStorageMessage(peer1, peer2, EVENTS.CALL_RESPONSE, {
        name: 'foo',
        id: data.id,
        data: returnData,
      })
      await delay()
      expect(res).toBeCalledWith(returnData)

      // test reject
      call(peer2, 'bar', [1, '2', true], 1000).catch(rej)
      await delay()
      data = getLastMessage().value.data.data as CallPayload
      const returnError = 'testError'
      mockStorageMessage(peer1, peer2, EVENTS.CALL_RESPONSE, {
        name: 'bar',
        id: data.id,
        error: returnError,
      })
      await delay()
      expect(rej.mock.calls[0]).toMatchObject([{ message: returnError }])
    })

    it('message send', () => {
      // same source
      transport.send(1, peer1)
      expect(getLastMessage()).not.toMatchObject({ value: { data: { type: EVENTS.MESSAGE } } })

      // broadcast
      transport.send(2)
      expect(getLastMessage()).toMatchObject({
        value: { data: { type: EVENTS.MESSAGE, data: { data: 2 } }, target: '*', source: peer1 },
      })
      ;[1, '2', true, { a: 1 }, []].forEach(d => {
        transport.send(d, peer2)
        expect(getLastMessage()).toMatchObject({
          value: {
            data: {
              type: EVENTS.MESSAGE,
              data: { data: d },
            },
            source: peer1,
          },
        })
      })
    })

    it('message receive', () => {
      const messageHandler = jest.fn()
      transport.on('message', messageHandler)

      // same source
      mockStorageMessage(peer1, peer1, EVENTS.MESSAGE, 1)
      expect(messageHandler).not.toBeCalled()
      ;[1, '2', true, { a: 1 }, []].forEach(d => {
        mockStorageMessage(peer1, peer2, EVENTS.MESSAGE, d)
        expect(messageHandler).toBeCalledWith(d)
      })
    })
  })
})

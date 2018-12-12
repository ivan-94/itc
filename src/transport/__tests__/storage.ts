import * as utils from '../../utils'
import StorageTransport, { StoragePayload } from '../storage'
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
        data: { type: EVENTS.DESTORY },
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
        ${`EVENTS.DESTORY`}      | ${peer1} | ${peer2} | ${EVENTS.DESTORY}       | ${peer2}                                     | ${true}
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
        data: true,
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
      expect(callInternal).toBeCalled()
    })

    it('master lose', () => {})
  })

  describe.skip('heartbeat', () => {})
  describe.skip('peer update', () => {})
  describe.skip('call', () => {})
  describe.skip('message', () => {})
})

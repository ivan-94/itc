/**
 * App entry
 */
import itc, { Transport, Peer } from '@carney520/itc'
import React, { useEffect, useRef, useState, useCallback } from 'react'
import ReactDOM from 'react-dom'

import './style.css'

function App() {
  const ref = useRef<{ worker?: Transport }>({})
  const [isMaster, setIsMaster] = useState(false)
  const [master, setMaster] = useState<Peer | undefined>(undefined)
  const [peers, setPeers] = useState<Peer[]>([])
  const [position, setPosition] = useState<[number, number]>([0, 0])
  const handleMouseMove = useCallback((evt: React.MouseEvent) => {
    const pos: [number, number] = [evt.clientX, evt.clientY]
    setPosition(pos)
    if (ref.current.worker) {
      ref.current.worker.send(pos)
    }
  }, [])

  useEffect(() => {
    const name = location.search.match(/name=(.*)$/)![1]
    const worker = (ref.current.worker = itc(name, { useStorage: true }))
    worker.on('master', () => {
      setIsMaster(true)
    })
    worker.on('masterlose', () => {
      setIsMaster(false)
    })
    worker.on('masterupdate', m => {
      setMaster(m)
    })
    worker.on('peerupdate', p => {
      setPeers(p)
    })
    worker.on('message', (data: [number, number]) => {
      setPosition(data)
    })
  }, [])

  return (
    <div className={`${isMaster ? 'master' : ''} peer`} onMouseMove={handleMouseMove}>
      <div>current master: {master && master.name}</div>
      <div>peers: [{peers.map(i => i.name).join(', ')}]</div>
      <div className="ball" style={{ left: position[0], top: position[1] }} />
    </div>
  )
}

ReactDOM.render(<App />, document.getElementById('root'))

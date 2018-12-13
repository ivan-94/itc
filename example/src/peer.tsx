/**
 * App entry
 */
import itc, { Transport } from '@carney520/itc'
import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'

import './style.css'

function App() {
  const ref = useRef<{ worker?: Transport }>({})
  const [isMaster, setIsMaster] = useState(false)
  useEffect(() => {
    const name = location.search.match(/name=(.*)$/)![1]
    const worker = (ref.current.worker = itc(name, { useStorage: true }))
    worker.on('master', () => {
      setIsMaster(true)
    })
    worker.on('masterlose', () => {
      setIsMaster(false)
    })
  }, [])

  return <div>isMaster: {JSON.stringify(isMaster)}</div>
}

ReactDOM.render(<App />, document.getElementById('root'))

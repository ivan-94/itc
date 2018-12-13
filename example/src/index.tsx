/**
 * App entry
 */
import React from 'react'
import ReactDOM from 'react-dom'

import './style.css'

const peers = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']
function App() {
  return (
    <div className="container">
      {peers.map(p => (
        <iframe key={p} className="peer-container" src={`peer.html?name=${p}`} />
      ))}
    </div>
  )
}

ReactDOM.render(<App />, document.getElementById('root'))

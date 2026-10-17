import FireMap from './components/FireMap'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Whoosh.zOS / IBM Z Datathon 2026</p>
          <h1>FireWatch<span className="brand-dot" aria-hidden="true">.</span></h1>
          <p className="subtitle">California wildfire intelligence</p>
        </div>
        <span className="prototype-badge">Frontend prototype</span>
      </header>
      <main>
        <FireMap />
      </main>
      <footer className="app-footer">
        Experimental prototype displaying historical satellite thermal observations, not live confirmed fires or wildfire perimeters. No risk predictions are displayed.
        This is not an official wildfire alert or evacuation service.
      </footer>
    </div>
  )
}

export default App

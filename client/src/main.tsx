import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

;(window as any).__REACT_ERRORS__ = [];
window.addEventListener('error', e => (window as any).__REACT_ERRORS__.push({msg: e.message, stack: e.error?.stack?.substring(0,500)}));
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

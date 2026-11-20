import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './pages/seez.css'
import SeezStore from './pages/SeezStore'

createRoot(document.getElementById('seez-root')!).render(
  <StrictMode>
    <SeezStore />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './pages/seez.css'
import SeezOrdersAdmin from './pages/SeezOrdersAdmin'

createRoot(document.getElementById('seez-admin-root')!).render(
  <StrictMode>
    <SeezOrdersAdmin />
  </StrictMode>,
)

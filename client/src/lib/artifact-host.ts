import { createContext } from 'react'
import type { ArtifactKind } from './artifacts'

// A host that shows artifacts (the Playground) provides this; the code block
// for a runnable fence then renders as a card that opens it instead of the
// raw source, which lives in the panel's Code tab. Without a host, blocks
// render as plain code everywhere else Markdown is used.
export interface ArtifactHost {
  open: (kind: ArtifactKind, language: string, code: string) => void
  /** The artifact currently open in the host, by its code, to mark the card active. */
  activeCode?: string | null
}
export const ArtifactHostContext = createContext<ArtifactHost | null>(null)

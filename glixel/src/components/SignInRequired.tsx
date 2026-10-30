import { IntelligenceCore } from './IntelligenceCore'

// Shown when there is no dashboard session (or it was rejected). GLIXEL never
// collects credentials itself; sign-in stays on the dashboard.
export function SignInRequired() {
  return (
    <main className="glx-shell flex min-h-dvh items-center justify-center px-4">
      <section className="glx-panel max-w-sm w-full text-center space-y-4">
        <IntelligenceCore />
        <h1 className="text-xl font-semibold tracking-wide">GLIXEL is locked</h1>
        <p className="text-sm text-glx-muted">
          Sign in on the FreeLLMAPI dashboard, then come back to <span className="font-mono">/glixel</span>.
          GLIXEL uses the same session and never asks for API keys.
        </p>
        <a className="glx-button" href="/">Open the dashboard sign-in</a>
      </section>
    </main>
  )
}

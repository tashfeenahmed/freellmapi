import { useEffect, useRef } from 'react'
import { barHeights, WAVE_BAR_COUNT } from '@/lib/waveform'

// Live level bars drawn inside the composer while the mic is open: an
// AnalyserNode on the recording stream, sampled once per frame onto a canvas
// so 31 bars never touch React state. The canvas paints in currentColor, so
// it follows the text colour in both themes. Everything is torn down on
// unmount — the analyser, the context, the frame loop.

export function DictationWave({ stream, className }: { stream: MediaStream; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof AudioContext === 'undefined') return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return
    const audio = new AudioContext()
    const source = audio.createMediaStreamSource(stream)
    const analyser = audio.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    let frame = 0

    const draw = () => {
      analyser.getByteFrequencyData(data)
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx2d.clearRect(0, 0, w, h)
      ctx2d.fillStyle = getComputedStyle(canvas).color
      // Thin bars at a fixed pitch, as many as fit (odd, so one is centred),
      // the row centred in the field; a wide field gets more bars, not fatter ones.
      const barW = 3
      const gap = 3
      const count = Math.max(WAVE_BAR_COUNT, Math.min(91, Math.floor(w / (barW + gap)) | 1))
      const heights = barHeights(data, count, 4, Math.max(8, h - 8))
      const offset = (w - (count * (barW + gap) - gap)) / 2
      heights.forEach((bh, i) => {
        const x = offset + i * (barW + gap)
        const y = (h - bh) / 2
        ctx2d.beginPath()
        ctx2d.roundRect(x, y, barW, bh, barW / 2)
        ctx2d.fill()
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(frame)
      source.disconnect()
      analyser.disconnect()
      void audio.close()
    }
  }, [stream])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}

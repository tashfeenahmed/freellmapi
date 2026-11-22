import { useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, RotateCcw } from 'lucide-react'
import cards from '@/data/spanish-verbs.json'
import './spanish-vocab.css'

export default function SpanishVocabPage() {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isFlipped, setIsFlipped] = useState(false)
  const card = cards[currentIndex]

  function moveCard(direction: -1 | 1) {
    setCurrentIndex((index) => index + direction)
    setIsFlipped(false)
  }

  return (
    <main className="vocab-page">
      <header className="vocab-header">
        <div className="vocab-brand">
          <span className="vocab-brand-icon" aria-hidden="true"><BookOpen size={19} /></span>
          <span>palabra</span>
        </div>
        <span className="vocab-level">THE 500 VERB DECK</span>
      </header>

      <section className="vocab-lesson" aria-label="Spanish vocabulary flash cards">
        <div className="vocab-intro">
          <p className="vocab-eyebrow">SPANISH VERB PRACTICE</p>
          <h1>Small steps, <span>big progress.</span></h1>
          <p className="vocab-subtitle">A simple way to grow your Spanish vocabulary.</p>
        </div>

        <div className="vocab-card-area">
          <div className={`vocab-flashcard${isFlipped ? ' is-flipped' : ''}`}>
            <button
              type="button"
              className="vocab-card-face"
              onClick={() => setIsFlipped((flipped) => !flipped)}
              aria-label={isFlipped ? `English: ${card.english}. Show Spanish` : `Spanish: ${card.spanish}. Reveal English translation`}
              aria-pressed={isFlipped}
            >
              <span className="vocab-card-topline">
                <span>{isFlipped ? 'ENGLISH' : 'SPANISH'}</span>
                <span className="vocab-card-count">{String(currentIndex + 1).padStart(2, '0')} / {cards.length}</span>
              </span>
              <span className="vocab-card-word">{isFlipped ? card.english : card.spanish}</span>
              <span className="vocab-card-hint">{isFlipped ? 'Spanish translation' : 'Think of the meaning, then tap to reveal'}</span>
              <span className="vocab-card-flip"><RotateCcw size={15} /> Tap to {isFlipped ? 'see Spanish' : 'reveal translation'}</span>
            </button>
          </div>
        </div>

        <div className="vocab-controls">
          <button
            type="button"
            className="vocab-nav-button"
            onClick={() => moveCard(-1)}
            disabled={currentIndex === 0}
            aria-label="Previous card"
          >
            <ArrowLeft size={18} />
            <span>Previous</span>
          </button>
          <div className="vocab-progress" aria-label={`Card ${currentIndex + 1} of ${cards.length}`}>
            <div className="vocab-progress-track">
              <div className="vocab-progress-value" style={{ width: `${((currentIndex + 1) / cards.length) * 100}%` }} />
            </div>
            <span>{currentIndex + 1} of {cards.length}</span>
          </div>
          <button
            type="button"
            className="vocab-nav-button vocab-next-button"
            onClick={() => moveCard(1)}
            disabled={currentIndex === cards.length - 1}
            aria-label="Next card"
          >
            <span>Next</span>
            <ArrowRight size={18} />
          </button>
        </div>

        <p className="vocab-footer-note">500 verbs. One at a time.</p>
      </section>
    </main>
  )
}

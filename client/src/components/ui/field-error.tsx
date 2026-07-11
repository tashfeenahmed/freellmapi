// Inline field-level error line, paired with aria-invalid on the input. The
// convention (from ModelDetailPage): errors appear after the field was
// touched or a submit was attempted, never on first paint.
export function FieldError({ error }: { error?: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  )
}

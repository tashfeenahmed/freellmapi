// Inline field-level error line, paired with aria-invalid on the input. The
// convention (from ModelDetailPage): errors appear after the field was
// touched or a submit was attempted, never on first paint.
// An `id` lets the field point at this line with aria-describedby, so the
// error is read as part of the input rather than only as a live announcement.
export function FieldError({ id, error }: { id?: string; error?: string | null }) {
  if (!error) return null
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {error}
    </p>
  )
}

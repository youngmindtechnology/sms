import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { describeError, fieldErrors } from './messages'

export interface PeriodValues {
  name: string
  sequence?: number
  startDate: string
  endDate: string
}

interface PeriodFormProps {
  title: string
  /** Terms have a number; academic years don't. */
  withSequence?: boolean
  initial?: PeriodValues
  submitLabel: string
  onSubmit: (values: PeriodValues) => Promise<void>
  onCancel: () => void
}

/** One form for creating or editing an academic year or a term. The server decides what is valid. */
export function PeriodForm({ title, withSequence = false, initial, submitLabel, onSubmit, onCancel }: PeriodFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [sequence, setSequence] = useState(initial?.sequence ? String(initial.sequence) : '')
  const [startDate, setStartDate] = useState(initial?.startDate ?? '')
  const [endDate, setEndDate] = useState(initial?.endDate ?? '')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const local: Record<string, string> = {}
    if (!name.trim()) local.name = 'Enter a name.'
    if (!startDate) local.startDate = 'Choose a start date.'
    if (!endDate) local.endDate = 'Choose an end date.'
    if (startDate && endDate && endDate <= startDate) local.endDate = 'The end date must be after the start date.'
    if (withSequence && sequence !== '' && !/^\d{1,2}$/.test(sequence)) local.sequence = 'Use a whole number from 1 to 12.'
    setErrors(local)
    setGeneral(null)
    if (Object.keys(local).length) return

    setBusy(true)
    try {
      await onSubmit({
        name: name.trim(),
        startDate,
        endDate,
        ...(withSequence && sequence !== '' ? { sequence: Number(sequence) } : {}),
      })
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeError(error))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label={title}>
      <h3>{title}</h3>
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="period-name">Name</label>
          <input id="period-name" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'period-name-error' : undefined} />
          {errors.name ? <p id="period-name-error" className="field-error">{errors.name}</p> : null}
        </div>
        {withSequence ? (
          <div className="field">
            <label htmlFor="period-seq">Term number (optional)</label>
            <input id="period-seq" inputMode="numeric" value={sequence} maxLength={2} onChange={(e) => setSequence(e.target.value)} aria-invalid={Boolean(errors.sequence)} />
            {errors.sequence ? <p className="field-error">{errors.sequence}</p> : null}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="period-start">Starts</label>
          <input id="period-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-invalid={Boolean(errors.startDate)} />
          {errors.startDate ? <p className="field-error">{errors.startDate}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="period-end">Ends</label>
          <input id="period-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-invalid={Boolean(errors.endDate)} />
          {errors.endDate ? <p className="field-error">{errors.endDate}</p> : null}
        </div>
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}

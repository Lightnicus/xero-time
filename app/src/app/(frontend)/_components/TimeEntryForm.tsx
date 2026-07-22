'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'

import type { ProjectOption } from '@/lib/member-app/data'
import { localDateTimeToISOString } from '@/lib/member-app/date-time'

import { PendingSubmitButton } from './PendingControls'
import {
  createTimeEntryAction,
  type TimeEntryActionState,
  type TimeEntryField,
  updateTimeEntryAction,
} from '../app/time/actions'

export type TimeEntryFormValues = {
  billable: boolean
  description: string
  endLocal: string
  enteredHours: number
  enteredMinutes: number
  inputMode: 'duration' | 'range'
  project: string
  startLocal: string
  timezone: string
  workDate: string
}

type TimezoneOption = {
  label: string
  value: string
}

type TimeEntryFormProps = {
  entryID?: string
  initialValues: TimeEntryFormValues
  mode: 'create' | 'edit'
  projects: ProjectOption[]
  requiresCorrectionReason?: boolean
  timezones: TimezoneOption[]
}

const initialActionState: TimeEntryActionState = { message: null }

function FieldError({ field, state }: { field: TimeEntryField; state: TimeEntryActionState }) {
  const message = state.fieldErrors?.[field]

  return message ? <small className="field-error">{message}</small> : null
}

export function TimeEntryForm({
  entryID,
  initialValues,
  mode,
  projects,
  requiresCorrectionReason = false,
  timezones,
}: TimeEntryFormProps) {
  const action = mode === 'create' ? createTimeEntryAction : updateTimeEntryAction
  const [state, formAction] = useActionState(action, initialActionState)
  const [inputMode, setInputMode] = useState(initialValues.inputMode)
  const [projectID, setProjectID] = useState(initialValues.project)
  const [billable, setBillable] = useState(initialValues.billable)
  const [description, setDescription] = useState(initialValues.description)
  const [workDate, setWorkDate] = useState(initialValues.workDate)
  const [enteredHours, setEnteredHours] = useState(String(initialValues.enteredHours))
  const [enteredMinutes, setEnteredMinutes] = useState(String(initialValues.enteredMinutes))
  const [startLocal, setStartLocal] = useState(initialValues.startLocal)
  const [endLocal, setEndLocal] = useState(initialValues.endLocal)
  const [timezone, setTimezone] = useState(initialValues.timezone)
  const hasProjects = projects.length > 0
  const startInstant = inputMode === 'range' ? localDateTimeToISOString(startLocal, timezone) : null
  const endInstant = inputMode === 'range' ? localDateTimeToISOString(endLocal, timezone) : null
  const calculatedSeconds =
    startInstant && endInstant
      ? (new Date(endInstant).getTime() - new Date(startInstant).getTime()) / 1_000
      : null
  const offsetLabel = startInstant
    ? new Intl.DateTimeFormat(undefined, {
        timeZone: timezone,
        timeZoneName: 'longOffset',
      })
        .formatToParts(new Date(startInstant))
        .find((part) => part.type === 'timeZoneName')?.value
    : null

  const selectProject = (nextProjectID: string) => {
    setProjectID(nextProjectID)
    const nextProject = projects.find((project) => project.id === nextProjectID)
    setBillable(nextProject?.billableByDefault !== false)
  }

  return (
    <form action={formAction} className="time-entry-form">
      {entryID && <input name="entryID" type="hidden" value={entryID} />}

      {!hasProjects && (
        <div className="notice notice-warning">
          There are no active projects available. Ask an administrator to create or activate one.
        </div>
      )}

      <div aria-live="polite" className="form-message form-message-error" role="status">
        {state.message}
      </div>
      {state.overlapWarning && (
        <label className="confirmation-field notice notice-warning">
          <input name="confirmOverlap" required type="checkbox" value="yes" />
          <span>I reviewed the overlap and want to save this range.</span>
        </label>
      )}

      <section aria-label="Time entry details" className="time-form-surface">
        <div className="time-form-fields">
          <label className="field" htmlFor="project">
            <span>Project</span>
            <select
              aria-invalid={Boolean(state.fieldErrors?.project)}
              disabled={!hasProjects}
              id="project"
              name="project"
              onChange={(event) => selectProject(event.target.value)}
              required
              value={projectID}
            >
              {!projectID && <option value="">Select a project</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} — {project.name}
                </option>
              ))}
            </select>
            <FieldError field="project" state={state} />
          </label>

          <label className="field" htmlFor="description">
            <span>Description</span>
            <textarea
              aria-invalid={Boolean(state.fieldErrors?.description)}
              id="description"
              maxLength={2_000}
              name="description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What did you work on?"
              required
              rows={3}
              value={description}
            />
            <small>Describe the completed work clearly enough for the customer invoice.</small>
            <FieldError field="description" state={state} />
          </label>

          <fieldset className="time-mode-fieldset">
            <legend>Entry method</legend>
            <div className="time-mode-options">
              <label
                className={
                  inputMode === 'duration' ? 'time-mode-option selected' : 'time-mode-option'
                }
              >
                <input
                  checked={inputMode === 'duration'}
                  name="inputMode"
                  onChange={() => setInputMode('duration')}
                  type="radio"
                  value="duration"
                />
                <span>
                  <strong>Hours and minutes</strong>
                  <small>Enter the total worked.</small>
                </span>
              </label>
              <label
                className={inputMode === 'range' ? 'time-mode-option selected' : 'time-mode-option'}
              >
                <input
                  checked={inputMode === 'range'}
                  name="inputMode"
                  onChange={() => setInputMode('range')}
                  type="radio"
                  value="range"
                />
                <span>
                  <strong>Start and finish</strong>
                  <small>Calculate from exact times.</small>
                </span>
              </label>
            </div>
            <FieldError field="inputMode" state={state} />
          </fieldset>

          {inputMode === 'duration' ? (
            <div className="time-duration-grid">
              <label className="field time-work-date" htmlFor="workDate">
                <span>Work date</span>
                <input
                  aria-invalid={Boolean(state.fieldErrors?.workDate)}
                  id="workDate"
                  name="workDate"
                  onChange={(event) => setWorkDate(event.target.value)}
                  required
                  type="date"
                  value={workDate}
                />
                <FieldError field="workDate" state={state} />
              </label>

              <label className="field" htmlFor="enteredHours">
                <span>Hours</span>
                <input
                  aria-invalid={Boolean(state.fieldErrors?.enteredHours)}
                  id="enteredHours"
                  inputMode="numeric"
                  max={24}
                  min={0}
                  name="enteredHours"
                  onChange={(event) => setEnteredHours(event.target.value)}
                  required
                  step={1}
                  type="number"
                  value={enteredHours}
                />
                <FieldError field="enteredHours" state={state} />
              </label>

              <label className="field" htmlFor="enteredMinutes">
                <span>Minutes</span>
                <input
                  aria-invalid={Boolean(state.fieldErrors?.enteredMinutes)}
                  id="enteredMinutes"
                  inputMode="numeric"
                  max={59}
                  min={0}
                  name="enteredMinutes"
                  onChange={(event) => setEnteredMinutes(event.target.value)}
                  required
                  step={1}
                  type="number"
                  value={enteredMinutes}
                />
                <FieldError field="enteredMinutes" state={state} />
              </label>
            </div>
          ) : (
            <div className="time-range-grid">
              <label className="field" htmlFor="startLocal">
                <span>Start</span>
                <input
                  aria-invalid={Boolean(state.fieldErrors?.startLocal)}
                  id="startLocal"
                  name="startLocal"
                  onChange={(event) => setStartLocal(event.target.value)}
                  required
                  step={60}
                  type="datetime-local"
                  value={startLocal}
                />
                <FieldError field="startLocal" state={state} />
              </label>

              <label className="field" htmlFor="endLocal">
                <span>Finish</span>
                <input
                  aria-invalid={Boolean(state.fieldErrors?.endLocal)}
                  id="endLocal"
                  name="endLocal"
                  onChange={(event) => setEndLocal(event.target.value)}
                  required
                  step={60}
                  type="datetime-local"
                  value={endLocal}
                />
                <FieldError field="endLocal" state={state} />
              </label>
            </div>
          )}

          {inputMode === 'range' && calculatedSeconds !== null && calculatedSeconds > 0 && (
            <div className="time-calculated-duration" aria-live="polite">
              Calculated duration: {Math.floor(calculatedSeconds / 3_600)}h{' '}
              {Math.floor((calculatedSeconds % 3_600) / 60)}m
            </div>
          )}

          <label className="checkbox-field time-billable-field">
            <input
              checked={billable}
              name="billable"
              onChange={(event) => setBillable(event.target.checked)}
              type="checkbox"
              value="true"
            />
            <span>
              <strong>Billable time</strong>
              <small>Include this work when preparing the customer invoice.</small>
            </span>
          </label>

          <div className="time-timezone-context">
            <div>
              <span>Timezone</span>
              <strong>{timezone.replaceAll('_', ' ')}</strong>
              {offsetLabel && <small>{offsetLabel} at the selected start</small>}
            </div>
            <details
              className="time-timezone-disclosure"
              open={Boolean(state.fieldErrors?.timezone) || undefined}
            >
              <summary>Change timezone</summary>
              <label className="field" htmlFor="timezone">
                <span>Timezone</span>
                <input
                  aria-invalid={Boolean(state.fieldErrors?.timezone)}
                  autoComplete="off"
                  id="timezone"
                  list={`time-entry-timezone-options-${mode}`}
                  name="timezone"
                  onChange={(event) => setTimezone(event.target.value)}
                  placeholder="Search IANA timezones"
                  required
                  value={timezone}
                />
                <datalist id={`time-entry-timezone-options-${mode}`}>
                  {timezones.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </datalist>
                <small>Start and finish are interpreted in this timezone.</small>
                <FieldError field="timezone" state={state} />
              </label>
            </details>
          </div>

          {mode === 'edit' && requiresCorrectionReason && (
            <section className="time-correction-field" aria-labelledby="correction-reason-heading">
              <div>
                <h2 id="correction-reason-heading">Correction reason</h2>
                <p>Administrator corrections are recorded in the audit trail.</p>
              </div>
              <label className="field" htmlFor="privilegedCorrectionReason">
                <span>Reason</span>
                <textarea
                  aria-invalid={Boolean(state.fieldErrors?.privilegedCorrectionReason)}
                  id="privilegedCorrectionReason"
                  maxLength={1_000}
                  minLength={10}
                  name="privilegedCorrectionReason"
                  required
                  rows={3}
                />
                <FieldError field="privilegedCorrectionReason" state={state} />
              </label>
            </section>
          )}

          <div className="time-form-actions">
            <Link className="button button-secondary" href="/app">
              Cancel
            </Link>
            <PendingSubmitButton
              className="button button-primary"
              disabled={!hasProjects}
              pendingLabel="Saving…"
            >
              {mode === 'create' ? 'Add time' : 'Save changes'}
            </PendingSubmitButton>
          </div>
        </div>
      </section>
    </form>
  )
}

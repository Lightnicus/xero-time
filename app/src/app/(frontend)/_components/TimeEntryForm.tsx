'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ProjectOption } from '@/lib/member-app/data'
import { localDateTimeToISOString } from '@/lib/member-app/date-time'

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

function SaveButton({ disabled, mode }: { disabled: boolean; mode: 'create' | 'edit' }) {
  const { pending } = useFormStatus()

  return (
    <button className="button button-primary" disabled={disabled || pending} type="submit">
      {pending ? 'Saving…' : mode === 'create' ? 'Add time' : 'Save changes'}
    </button>
  )
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
    <form action={formAction} className="entry-form">
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

      <section className="form-section" aria-labelledby="work-details-heading">
        <div className="form-section-heading">
          <span>1</span>
          <div>
            <h2 id="work-details-heading">Work details</h2>
            <p>Choose the project and describe what you completed.</p>
          </div>
        </div>

        <div className="form-grid">
          <label className="field field-full" htmlFor="project">
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

          <label className="field field-full" htmlFor="description">
            <span>Description</span>
            <textarea
              aria-invalid={Boolean(state.fieldErrors?.description)}
              id="description"
              maxLength={2_000}
              name="description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What did you work on?"
              required
              rows={4}
              value={description}
            />
            <small>This will become the description for its mapped Xero invoice line.</small>
            <FieldError field="description" state={state} />
          </label>

          <label className="checkbox-field field-full">
            <input
              checked={billable}
              name="billable"
              onChange={(event) => setBillable(event.target.checked)}
              type="checkbox"
              value="true"
            />
            <span>
              <strong>Billable time</strong>
              <small>Include this entry when preparing billable time for Xero.</small>
            </span>
          </label>
        </div>
      </section>

      <section className="form-section" aria-labelledby="time-details-heading">
        <div className="form-section-heading">
          <span>2</span>
          <div>
            <h2 id="time-details-heading">Time</h2>
            <p>Enter a duration or a precise start and finish. There is no running timer.</p>
          </div>
        </div>

        <fieldset className="mode-fieldset">
          <legend>Entry method</legend>
          <div className="mode-options">
            <label className={inputMode === 'duration' ? 'mode-option selected' : 'mode-option'}>
              <input
                checked={inputMode === 'duration'}
                name="inputMode"
                onChange={() => setInputMode('duration')}
                type="radio"
                value="duration"
              />
              <span>
                <strong>Hours and minutes</strong>
                <small>Best when you already know the total.</small>
              </span>
            </label>
            <label className={inputMode === 'range' ? 'mode-option selected' : 'mode-option'}>
              <input
                checked={inputMode === 'range'}
                name="inputMode"
                onChange={() => setInputMode('range')}
                type="radio"
                value="range"
              />
              <span>
                <strong>Start and finish</strong>
                <small>The duration is calculated for you.</small>
              </span>
            </label>
          </div>
          <FieldError field="inputMode" state={state} />
        </fieldset>

        {inputMode === 'duration' ? (
          <div className="form-grid form-grid-time">
            <label className="field" htmlFor="workDate">
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
          <div className="form-grid">
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

        <label className="field timezone-field" htmlFor="timezone">
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
            {timezones.map((timezone) => (
              <option key={timezone.value} value={timezone.value}>
                {timezone.label}
              </option>
            ))}
          </datalist>
          <small>
            Start and finish are interpreted in this timezone
            {offsetLabel ? ` (${offsetLabel} at the selected start)` : ''}.
          </small>
          <FieldError field="timezone" state={state} />
        </label>
        {inputMode === 'range' && calculatedSeconds !== null && calculatedSeconds > 0 && (
          <div className="notice" aria-live="polite">
            Calculated duration: {Math.floor(calculatedSeconds / 3_600)}h{' '}
            {Math.floor((calculatedSeconds % 3_600) / 60)}m
          </div>
        )}
      </section>

      {mode === 'edit' && requiresCorrectionReason && (
        <section className="form-section" aria-labelledby="correction-reason-heading">
          <div className="form-section-heading">
            <span>3</span>
            <div>
              <h2 id="correction-reason-heading">Correction audit</h2>
              <p>Owner and administrator corrections are recorded in the audit trail.</p>
            </div>
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

      <div className="form-actions">
        <Link className="button button-secondary" href="/app">
          Cancel
        </Link>
        <SaveButton disabled={!hasProjects} mode={mode} />
      </div>
    </form>
  )
}

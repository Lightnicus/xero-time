'use client'

import { createContext, useContext, useEffect, useId, useState, useTransition } from 'react'
import { flushSync, useFormStatus } from 'react-dom'

import type { ComponentPropsWithoutRef, ReactNode } from 'react'

type NavigationFormPendingState = {
  pending: boolean
  submitterID: string | null
}

const idleNavigationFormState: NavigationFormPendingState = { pending: false, submitterID: null }
const NavigationFormPendingContext = createContext(idleNavigationFormState)

type PendingContentProps = {
  children?: ReactNode
  pending: boolean
  pendingLabel: string
}

function PendingContent({ children, pending, pendingLabel }: PendingContentProps) {
  return (
    <>
      {pending && <span aria-hidden="true" className="button-spinner" />}
      <span>{pending ? pendingLabel : children}</span>
    </>
  )
}

function PendingAnnouncement({
  pending,
  pendingLabel,
}: Pick<PendingContentProps, 'pending' | 'pendingLabel'>) {
  return (
    <span aria-live="polite" className="visually-hidden">
      {pending ? pendingLabel : ''}
    </span>
  )
}

type PendingSubmitButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'type'> & {
  children?: ReactNode
  pendingLabel: string
}

export function PendingSubmitButton({
  children,
  disabled = false,
  pendingLabel,
  ...props
}: PendingSubmitButtonProps) {
  const { pending: actionPending } = useFormStatus()
  const navigation = useContext(NavigationFormPendingContext)
  const submitID = useId()
  const ownsNavigationSubmission =
    navigation.pending && (navigation.submitterID === null || navigation.submitterID === submitID)
  const pending = actionPending || ownsNavigationSubmission

  return (
    <>
      <button
        {...props}
        aria-busy={pending || undefined}
        aria-disabled={navigation.pending ? true : props['aria-disabled']}
        data-pending-submit-id={submitID}
        data-pending={pending ? 'true' : undefined}
        disabled={disabled || actionPending}
        type="submit"
      >
        <PendingContent pending={pending} pendingLabel={pendingLabel}>
          {children}
        </PendingContent>
      </button>
      <PendingAnnouncement pending={pending} pendingLabel={pendingLabel} />
    </>
  )
}

type PendingNavigationFormProps = Omit<ComponentPropsWithoutRef<'form'>, 'action' | 'children'> & {
  action: string
  children?: ReactNode
}

/**
 * Adds immediate feedback to forms that navigate to a URL. React only exposes
 * pending status for function actions, so native GET/POST submissions need a
 * small local pending context while the browser waits for the next document.
 */
export function PendingNavigationForm({
  action,
  children,
  onSubmit,
  ...props
}: PendingNavigationFormProps) {
  const [state, setState] = useState(idleNavigationFormState)

  useEffect(() => {
    const restore = () => setState(idleNavigationFormState)
    window.addEventListener('pageshow', restore)
    return () => window.removeEventListener('pageshow', restore)
  }, [])

  const handleSubmit: NonNullable<ComponentPropsWithoutRef<'form'>['onSubmit']> = (event) => {
    if (state.pending) {
      event.preventDefault()
      return
    }
    onSubmit?.(event)
    if (event.defaultPrevented) return

    // Flush before native navigation begins so the user sees feedback even
    // when the response starts quickly. Keep the native submitter enabled so
    // its optional name/value remains part of the browser-built form data.
    // Invalid forms never emit submit.
    flushSync(() =>
      setState({
        pending: true,
        submitterID: event.nativeEvent.submitter?.dataset.pendingSubmitId ?? null,
      }),
    )
  }

  return (
    <NavigationFormPendingContext.Provider value={state}>
      <form {...props} action={action} onSubmit={handleSubmit}>
        {children}
      </form>
    </NavigationFormPendingContext.Provider>
  )
}

type PendingActionButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'children' | 'onClick' | 'type'
> & {
  action: () => Promise<void> | void
  children?: ReactNode
  pendingLabel: string
}

export function PendingActionButton({
  action,
  children,
  disabled = false,
  pendingLabel,
  ...props
}: PendingActionButtonProps) {
  const [pending, startTransition] = useTransition()

  const handleClick = () => {
    startTransition(async () => {
      await action()
    })
  }

  return (
    <>
      <button
        {...props}
        aria-busy={pending || undefined}
        data-pending={pending ? 'true' : undefined}
        disabled={disabled || pending}
        onClick={handleClick}
        type="button"
      >
        <PendingContent pending={pending} pendingLabel={pendingLabel}>
          {children}
        </PendingContent>
      </button>
      <PendingAnnouncement pending={pending} pendingLabel={pendingLabel} />
    </>
  )
}

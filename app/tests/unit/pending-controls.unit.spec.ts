import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PendingActionButton,
  PendingNavigationForm,
  PendingSubmitButton,
} from '@/app/(frontend)/_components/PendingControls'

afterEach(cleanup)

const submitButton = (): HTMLButtonElement => screen.getByRole('button') as HTMLButtonElement

describe('pending controls', () => {
  it('shows immediate feedback for a URL navigation form submission', () => {
    const { container } = render(
      createElement(
        PendingNavigationForm,
        { action: '/next', method: 'get' },
        createElement(
          PendingSubmitButton,
          {
            className: 'button',
            name: 'intent',
            pendingLabel: 'Applying…',
            value: 'apply',
          },
          'Apply filters',
        ),
      ),
    )
    const form = container.querySelector('form')
    if (!form) throw new Error('The navigation form did not render.')

    fireEvent.submit(form)

    expect(form.hasAttribute('aria-busy')).toBe(false)
    expect(submitButton().disabled).toBe(false)
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')
    expect(submitButton().getAttribute('aria-busy')).toBe('true')
    expect(submitButton().textContent).toContain('Applying…')
    expect(new FormData(form, submitButton()).get('intent')).toBe('apply')
    expect(fireEvent.submit(form)).toBe(false)

    fireEvent(window, new Event('pageshow'))
    expect(submitButton().disabled).toBe(false)
    expect(submitButton().hasAttribute('aria-disabled')).toBe(false)
    expect(submitButton().textContent).toBe('Apply filters')
  })

  it('tracks the native submitter while blocking duplicate submissions', () => {
    const { container } = render(
      createElement(
        PendingNavigationForm,
        { action: '/next', method: 'post' },
        createElement(
          PendingSubmitButton,
          {
            name: 'intent',
            pendingLabel: 'Saving primary…',
            value: 'primary',
          },
          'Save primary',
        ),
        createElement(
          PendingSubmitButton,
          {
            name: 'intent',
            pendingLabel: 'Saving secondary…',
            value: 'secondary',
          },
          'Save secondary',
        ),
      ),
    )
    const form = container.querySelector('form')
    if (!form) throw new Error('The navigation form did not render.')
    const [primary, secondary] = screen.getAllByRole('button') as HTMLButtonElement[]
    if (!primary || !secondary) throw new Error('Both submit controls must render.')

    const firstSubmission = new SubmitEvent('submit', {
      bubbles: true,
      cancelable: true,
      submitter: primary,
    })
    expect(fireEvent(form, firstSubmission)).toBe(true)

    expect(primary.textContent).toContain('Saving primary…')
    expect(primary.getAttribute('aria-busy')).toBe('true')
    expect(secondary.textContent).toBe('Save secondary')
    expect(secondary.hasAttribute('aria-busy')).toBe(false)
    expect(primary.getAttribute('aria-disabled')).toBe('true')
    expect(secondary.getAttribute('aria-disabled')).toBe('true')
    expect(new FormData(form, primary).get('intent')).toBe('primary')

    const duplicateSubmission = new SubmitEvent('submit', {
      bubbles: true,
      cancelable: true,
      submitter: secondary,
    })
    expect(fireEvent(form, duplicateSubmission)).toBe(false)
    expect(secondary.textContent).toBe('Save secondary')
  })

  it('preserves an existing disabled condition', () => {
    render(
      createElement(
        'form',
        null,
        createElement(PendingSubmitButton, { disabled: true, pendingLabel: 'Saving…' }, 'Save'),
      ),
    )

    expect(submitButton().disabled).toBe(true)
    expect(submitButton().textContent).toBe('Save')
    expect(submitButton().hasAttribute('aria-busy')).toBe(false)
  })

  it('does not show pending feedback when native validation blocks submission', () => {
    render(
      createElement(
        PendingNavigationForm,
        { action: '/next', method: 'post' },
        createElement('input', { 'aria-label': 'Required value', name: 'value', required: true }),
        createElement(PendingSubmitButton, { pendingLabel: 'Submitting…' }, 'Submit'),
      ),
    )

    fireEvent.click(submitButton())

    expect(submitButton().disabled).toBe(false)
    expect(submitButton().textContent).toBe('Submit')
    expect(submitButton().hasAttribute('aria-busy')).toBe(false)
  })

  it('tracks an asynchronous React form action', async () => {
    let finish: (() => void) | undefined
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const { container } = render(
      createElement(
        'form',
        { action },
        createElement(
          PendingSubmitButton,
          { className: 'button', pendingLabel: 'Saving…' },
          'Save',
        ),
      ),
    )
    const form = container.querySelector('form')
    if (!form) throw new Error('The action form did not render.')

    fireEvent.submit(form)

    await waitFor(() => expect(submitButton().textContent).toContain('Saving…'))
    expect(submitButton().disabled).toBe(true)
    expect(action).toHaveBeenCalledTimes(1)

    finish?.()
    await waitFor(() => expect(submitButton().textContent).toBe('Save'))
  })

  it('blocks repeated transition actions while they are pending', async () => {
    let finish: (() => void) | undefined
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(createElement(PendingActionButton, { action, pendingLabel: 'Retrying…' }, 'Try again'))

    fireEvent.click(submitButton())

    await waitFor(() => expect(submitButton().textContent).toContain('Retrying…'))
    expect(submitButton().disabled).toBe(true)
    expect(submitButton().getAttribute('aria-busy')).toBe('true')
    fireEvent.click(submitButton())
    expect(action).toHaveBeenCalledTimes(1)

    finish?.()
    await waitFor(() => expect(submitButton().textContent).toBe('Try again'))
  })
})

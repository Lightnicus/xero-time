'use client'

import {
  FieldDescription,
  FieldError,
  FieldLabel,
  RenderCustomComponent,
  fieldBaseClass,
  useField,
  useFormFields,
} from '@payloadcms/ui'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
} from 'react'

import {
  decimalAmountToScaled,
  formatScaledAmount,
  formatScaledDecimal,
  formatScaledDisplayDecimal,
} from '@/lib/domain/money'

import type { NumberFieldClientComponent, Validate } from 'payload'

const rateValidationMessage =
  'Enter a non-negative hourly rate with no more than four decimal places.'

const ScaledCurrencyField: NumberFieldClientComponent = ({
  field,
  onChange: onChangeFromProps,
  path: potentiallyStalePath,
  readOnly,
}) => {
  const {
    admin: {
      className,
      custom,
      description: schemaDescription,
      placeholder = '150.00',
      style,
      width,
    } = {},
    label,
    localized,
    max,
    min,
    required,
  } = field
  const description =
    typeof custom?.inputDescription === 'string' ? custom.inputDescription : schemaDescription
  const currencyField =
    typeof custom?.currencyField === 'string' ? custom.currencyField : 'currency'
  const currency = useFormFields(([fields]) => fields[currencyField]?.value)
  const notifyChange = onChangeFromProps as ((value: number | null) => void) | undefined
  const validateRate = useCallback<Validate>(
    (value) => {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (typeof min === 'number' && value < min) ||
        (typeof max === 'number' && value > max)
      ) {
        return rateValidationMessage
      }

      return true
    },
    [max, min],
  )
  const {
    customComponents: { AfterInput, BeforeInput, Description, Error, Label } = {},
    disabled,
    path,
    setValue,
    showError,
    value,
  } = useField<number | null>({
    potentiallyStalePath,
    validate: validateRate,
  })
  const [draft, setDraft] = useState<string | null>(null)
  const previousValue = useRef(value)
  const lastInputValue = useRef<number | null | undefined>(undefined)
  const isReadOnly = Boolean(readOnly || disabled)
  const valueToRender =
    draft ??
    (typeof value === 'number'
      ? ((isReadOnly
          ? typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
            ? formatScaledAmount(value, currency)
            : formatScaledDisplayDecimal(value)
          : formatScaledDecimal(value)) ?? '')
      : '')
  const fieldStyle = useMemo(
    () =>
      ({
        ...style,
        ...(width ? { '--field-width': width } : { flex: style?.flex ?? '1 1 auto' }),
      }) as CSSProperties,
    [style, width],
  )

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextDraft = event.target.value
      const nextValue = decimalAmountToScaled(nextDraft)
      lastInputValue.current = nextValue
      setDraft(nextDraft)
      setValue(nextValue)
      notifyChange?.(nextValue)
    },
    [notifyChange, setValue],
  )

  const handleBlur = useCallback(() => {
    if (decimalAmountToScaled(valueToRender) !== null) {
      lastInputValue.current = undefined
      setDraft(null)
    }
  }, [valueToRender])

  useEffect(() => {
    const valueChanged = !Object.is(previousValue.current, value)
    previousValue.current = value
    if (valueChanged && draft !== null && !Object.is(value, lastInputValue.current)) {
      lastInputValue.current = undefined
      setDraft(null)
    }
  }, [draft, value])

  return (
    <div
      className={[
        fieldBaseClass,
        'number',
        className,
        showError && 'error',
        isReadOnly && 'read-only',
      ]
        .filter(Boolean)
        .join(' ')}
      style={fieldStyle}
    >
      <RenderCustomComponent
        CustomComponent={Label}
        Fallback={
          <FieldLabel label={label} localized={localized} path={path} required={required} />
        }
      />
      <div className={`${fieldBaseClass}__wrap`}>
        <RenderCustomComponent
          CustomComponent={Error}
          Fallback={<FieldError path={path} showError={showError} />}
        />
        {BeforeInput}
        <div>
          <input
            aria-invalid={showError || undefined}
            autoComplete="off"
            disabled={isReadOnly}
            id={`field-${path.replace(/\./g, '__')}`}
            inputMode="decimal"
            maxLength={32}
            name={path}
            onBlur={handleBlur}
            onChange={handleChange}
            pattern="(?:[0-9]+(?:\.[0-9]{0,4})?|\.[0-9]{1,4})"
            placeholder={typeof placeholder === 'string' ? placeholder : '150.00'}
            type="text"
            value={valueToRender}
          />
        </div>
        {AfterInput}
        <RenderCustomComponent
          CustomComponent={Description}
          Fallback={<FieldDescription description={description} path={path} />}
        />
      </div>
    </div>
  )
}

export default ScaledCurrencyField

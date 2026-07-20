import { formatScaledAmount, formatScaledDecimal } from '@/lib/domain/money'

import type { DefaultServerCellComponentProps, NumberFieldClient } from 'payload'

const ScaledCurrencyCell = ({
  cellData,
  rowData,
}: DefaultServerCellComponentProps<NumberFieldClient, number>) => {
  if (!Number.isSafeInteger(cellData) || cellData < 0) return <span>Invalid rate</span>

  const currency = rowData.currency
  const formatted =
    typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
      ? formatScaledAmount(cellData, currency)
      : formatScaledDecimal(cellData)

  return <span>{formatted ?? 'Invalid rate'}</span>
}

export default ScaledCurrencyCell

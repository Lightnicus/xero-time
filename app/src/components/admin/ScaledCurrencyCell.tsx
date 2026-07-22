import { formatScaledAmount, formatScaledDisplayDecimal } from '@/lib/domain/money'

import type { DefaultServerCellComponentProps, NumberFieldClient } from 'payload'

const ScaledCurrencyCell = ({
  cellData,
  rowData,
}: DefaultServerCellComponentProps<NumberFieldClient, number>) => {
  if (!Number.isSafeInteger(cellData) || cellData < 0) return <span>Invalid amount</span>

  const currency = rowData.currency ?? rowData.currencySnapshot
  const formatted =
    typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
      ? formatScaledAmount(cellData, currency)
      : formatScaledDisplayDecimal(cellData)

  return <span>{formatted ?? 'Invalid amount'}</span>
}

export default ScaledCurrencyCell

/** Display formatting helpers. Kept out of components so they are reusable. */

const countFormatter = new Intl.NumberFormat('en-GH')

const currencyFormatter = new Intl.NumberFormat('en-GH', {
  style: 'currency',
  currency: 'GHS',
  maximumFractionDigits: 0,
})

export function formatCount(value: number): string {
  return countFormatter.format(value)
}

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-09-01" -> "1 Sep 2026". Plain text slicing, so no time zone can shift the day. */
export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  const index = Number(month) - 1
  if (!year || !day || index < 0 || index > 11) return isoDate
  return `${Number(day)} ${MONTHS[index]} ${year}`
}

import React from 'react'
import './styles.css'

export const metadata = {
  description: 'Record project time and prepare it for Xero invoicing.',
  title: 'Project Time',
}

export default async function RootLayout(props: { children: React.ReactNode }) {
  const { children } = props

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

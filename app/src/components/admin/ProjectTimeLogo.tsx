export default function ProjectTimeLogo() {
  return (
    <div
      aria-label="Project Time administration"
      style={{ alignItems: 'center', display: 'flex', gap: '10px' }}
    >
      <span
        aria-hidden="true"
        style={{
          alignItems: 'center',
          background: '#176b51',
          borderRadius: '10px',
          color: '#fff',
          display: 'inline-flex',
          fontSize: '14px',
          fontWeight: 800,
          height: '36px',
          justifyContent: 'center',
          letterSpacing: '0.04em',
          width: '36px',
        }}
      >
        PT
      </span>
      <span style={{ display: 'grid', lineHeight: 1.1 }}>
        <strong>Project Time</strong>
        <small style={{ opacity: 0.7 }}>Administration</small>
      </span>
    </div>
  )
}

import '../workflow-primitives.css'

type Metric = {
  label: string
  value: string
}

type MetricStripProps = {
  label: string
  metrics: Metric[]
}

export function MetricStrip({ label, metrics }: MetricStripProps) {
  return (
    <section aria-label={label} className="workflow-metric-strip">
      <dl>
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

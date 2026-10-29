import { Box, Text } from 'ink'
import { progressCount, type ProgressRow } from '../fetch-progress.js'
import { useSpinner } from '../hooks/useSpinner.js'
import { ScrollTarget } from './Viewport.js'

/**
 * Every line of a fetch while its projects are checked or their exports
 * downloaded: queued, in progress with a spinner, or how it ended. The line in
 * progress is the scroll target, so a list longer than the terminal keeps it
 * in view as the work moves down.
 */
export function ProjectProgress({ title, rows, working }: { title: string; rows: ProgressRow[]; working: string }) {
  const busy = rows.some((r) => r.state === 'working')
  const spinner = useSpinner(busy)
  const width = Math.max(0, ...rows.map((r) => r.input.length))
  const at = rows.findIndex((r) => r.state === 'working')
  return (
    <Box flexDirection="column">
      <Text>
        {title}: {progressCount(rows)}
      </Text>
      {rows.map((row, i) => (
        <ScrollTarget key={i} active={i === at}>
          <Text
            {...(row.state === 'queued' || row.dim ? { dimColor: true } : {})}
            {...(row.warn ? { color: 'yellow' } : {})}
          >
            {row.state === 'working' ? `${spinner} ` : '  '}
            {row.input.padEnd(width)}
            {'  '}
            {row.state === 'working' ? working : row.state === 'queued' ? 'queued' : row.detail}
          </Text>
        </ScrollTarget>
      ))}
    </Box>
  )
}

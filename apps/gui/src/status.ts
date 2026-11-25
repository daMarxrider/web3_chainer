/** What the job lamp in the status strip shows. */
export type JobState = 'idle' | 'working' | 'done' | 'failed'

interface JobInfo {
  state: JobState
  text: string
}

let job: JobInfo = { state: 'idle', text: 'No job running' }
const listeners = new Set<(j: JobInfo) => void>()

export const currentJob = () => job

export function setJob(state: JobState, text: string): void {
  job = { state, text }
  for (const l of listeners) l(job)
}

export function onJob(listener: (j: JobInfo) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

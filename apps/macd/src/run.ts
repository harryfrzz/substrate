type RunOptions = { stdin?: string; env?: Record<string, string>; timeoutMs?: number }

// Runs a command to completion and returns its output; throws with the end of
// its stderr if it fails. Secrets go in by stdin or env, never argv.
export async function run(argv: string[], { stdin, env, timeoutMs }: RunOptions = {}) {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) {
    const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-3).join(' ')
    throw new Error(`${argv.slice(0, 2).join(' ')} failed (${proc.signalCode ?? code})${detail ? `: ${detail}` : ''}`)
  }
  return stdout
}

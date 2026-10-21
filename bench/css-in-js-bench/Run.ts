/**
 * Runs the Zyzz lane of jantimon/css-in-js-bench against this checkout and
 * prints the results of every selected lane.
 * @module
 */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Url from 'node:url'

const commit =
  process.env.CSS_BENCH_COMMIT ?? 'bcaa3d316b1b6f897eed19da8545a9291197a66a'
const lanes = (
  process.env.CSS_BENCH_LANES ?? 'zyzz,vanilla,next-yak,stylex-layers,plumeria'
).split(',')
const measures = process.env.CSS_BENCH_MEASURES ?? 'microbench,payload'
const repository = 'https://github.com/jantimon/css-in-js-bench.git'

const here = Path.dirname(Url.fileURLToPath(import.meta.url))
const root = Path.resolve(here, '../..')
const directory = Path.join(root, 'bench/results/css-in-js-bench')

const run = (command: string, args: readonly string[], cwd = directory) =>
  ChildProcess.execFileSync(command, args, {
    cwd,
    env: { ...process.env, SKIP_VERIFY: '1' },
    stdio: 'inherit',
  })

// A fixed commit keeps every lane's workload identical between runs.
if (!Fs.existsSync(directory))
  run('git', ['clone', repository, directory], root)
run('git', ['fetch', 'origin', commit])
run('git', ['checkout', '--force', commit])
run('git', ['clean', '-fdq', '--', 'techs/zyzz', 'report', 'result'])
run('git', ['apply', Path.join(here, 'lane.patch')])

// The lane builds against this checkout unless a published version is requested.
const manifest = Path.join(directory, 'techs/zyzz/package.json')
const lane = JSON.parse(Fs.readFileSync(manifest, 'utf8'))
lane.dependencies.zyzz = process.env.CSS_BENCH_ZYZZ ?? `link:${root}`
Fs.writeFileSync(manifest, `${JSON.stringify(lane, null, 2)}\n`)

run('pnpm', ['install', '--no-frozen-lockfile'])

for (const name of lanes)
  run('pnpm', ['gen:samples', '--tech', name, `--measure=${measures}`])

if (process.env.CSS_BENCH_VERIFY) {
  // The upstream gate also requires WPD profiles, which this script does not record.
  const source = Fs.readFileSync(Path.join(directory, 'verify.ts'), 'utf8')
  const local = source.replace(
    'validateWpdResults(RESULT_DIR);',
    'if (!process.env.SKIP_WPD_GATE) validateWpdResults(RESULT_DIR);',
  )
  Fs.writeFileSync(Path.join(directory, 'verify.local.ts'), local)
  process.env.SKIP_WPD_GATE = '1'
  run('node', ['verify.local.ts'])
}

// The suite commits historical results, so only measures this run requested are read.
const requested = new Set(measures.split(','))

const read = (name: string): Record<string, unknown> | undefined => {
  if (!requested.has(name)) return undefined

  const file = Path.join(directory, 'result', `measurement-${name}.json`)
  return Fs.existsSync(file)
    ? JSON.parse(Fs.readFileSync(file, 'utf8'))
    : undefined
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

const samples = (value: unknown): readonly number[] => {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && 'samples' in value)
    return value.samples as number[]
  return []
}

const cases = [
  ...new Set(
    Fs.readdirSync(Path.join(directory, 'cases')).map((file) =>
      file.replace(/\.ts$/, ''),
    ),
  ),
].sort()

const payload = read('payload') as
  | Record<string, readonly { css: number; html: number; js: number }[]>
  | undefined

if (payload) {
  console.log('\nPage bytes, gzip (JS + CSS + HTML), lower is better')
  console.log(
    ['case'.padEnd(24), ...lanes.map((name) => name.padStart(14))].join(''),
  )

  for (const id of cases) {
    const cells = lanes.map((name) => {
      const sample = payload[`${id}/${name}`]?.[0]
      return (
        sample ? String(sample.js + sample.css + sample.html) : '-'
      ).padStart(14)
    })
    console.log([id.padEnd(24), ...cells].join(''))
  }
}

for (const name of ['microbench', 'hydrate', 'inp', 'mount']) {
  const data = read(name)
  if (!data) continue

  console.log(`\n${name}, median of this machine's samples`)
  console.log(
    ['case'.padEnd(24), ...lanes.map((lane) => lane.padStart(14))].join(''),
  )

  for (const id of cases) {
    const cells = lanes.map((lane) => {
      const values = samples(data[`${id}/${lane}`])
      return (values.length ? median(values).toPrecision(4) : '-').padStart(14)
    })
    console.log([id.padEnd(24), ...cells].join(''))
  }
}

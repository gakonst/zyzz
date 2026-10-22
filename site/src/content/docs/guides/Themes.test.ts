/** Verifies the Themes & Tokens guide's authored examples through the filesystem compiler. @module */
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import { expect, test } from 'vite-plus/test'
import { Host } from 'zyzz/node'

const document = await Fs.readFile(
  new URL('./themes.mdx', import.meta.url),
  'utf8',
)
// The bundler-free recipe runs `Css.compile` directly instead of passing through the host.
const examples = Array.from(
  document.matchAll(/```tsx? title="([^"]+)"\n([\s\S]*?)```/g),
).filter((example) => example[1] !== 'compile.ts')
const project = Path.resolve(import.meta.dirname, '../../../../..')

test('compiles every themes example with its documented imports', async () => {
  const root = await Fs.mkdtemp(Path.join(project, '.fixture-themes-guide-'))
  const filenames = new Map<string, string>()
  const output: string[] = []
  const sources = new Map<string, string>()

  try {
    await Fs.mkdir(Path.join(root, 'node_modules'))
    await Fs.symlink(project, Path.join(root, 'node_modules/zyzz'), 'dir')

    for (const [index, example] of examples.entries()) {
      const name = example[1]!
      const source = example[2]!
      filenames.set(Path.parse(name).name, name)
      sources.set(name, source)
      const directory = Path.join(root, String(index))
      await Fs.mkdir(directory)
      await Fs.writeFile(Path.join(directory, name), source)

      // Each example links against the latest earlier example with the imported name.
      for (const dependency of source.matchAll(/from '\.\/([^']+)\.js'/g)) {
        const filename = filenames.get(dependency[1]!)!
        await Fs.writeFile(
          Path.join(directory, filename),
          sources.get(filename)!,
        )
      }

      const outDir = Path.join(directory, 'dist')
      await using host = await Host.create({
        outDir,
        packageId: `guide-${index}`,
        root: directory,
      })

      await host.build()

      const css = await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8')
      output.push(`${name}: ${css.length > 0 ? 'compiled CSS' : 'empty CSS'}`)
    }

    expect(output).toMatchInlineSnapshot(`
      [
        "zyzz.config.ts: compiled CSS",
        "Card.tsx: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "Card.tsx: compiled CSS",
        "Document.tsx: compiled CSS",
        "Sidebar.tsx: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "ThemePreview.tsx: compiled CSS",
        "DarkPreview.tsx: compiled CSS",
        "AppearanceButton.tsx: compiled CSS",
        "Document.tsx: compiled CSS",
        "AccountCard.tsx: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "zyzz.config.ts: empty CSS",
        "Badge.tsx: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "Badge.tsx: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "Preview.tsx: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "Title.tsx: compiled CSS",
        "zyzz.config.ts: compiled CSS",
        "Panel.tsx: compiled CSS",
      ]
    `)
  } finally {
    await Fs.rm(root, { force: true, recursive: true })
  }
}, 60_000)

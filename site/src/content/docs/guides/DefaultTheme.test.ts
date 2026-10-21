/** Builds and type-checks the Default Theme guide's examples through the packed compiler contract. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Module from 'node:module'
import * as Path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { appearance, script, tokens, vars } from 'zyzz/default'
import { Host } from 'zyzz/node'

const project = Path.resolve(import.meta.dirname, '../../../../..')
const require = Module.createRequire(import.meta.url)
let root = ''

beforeAll(async () => {
  root = await Fs.mkdtemp(Path.join(project, '.fixture-default-theme-guide-'))
  await Fs.mkdir(Path.join(root, 'node_modules'))
  await Fs.symlink(project, Path.join(root, 'node_modules/zyzz'), 'dir')
  for (const name of ['@types', 'react-native'])
    await Fs.symlink(
      Path.join(project, 'node_modules', name),
      Path.join(root, 'node_modules', name),
      'dir',
    )
})

afterAll(async () => {
  if (root) await Fs.rm(root, { force: true, recursive: true })
})

/** Reads the guide's importing examples in order, optionally from one section. */
async function examples(heading?: string | undefined) {
  const document = await Fs.readFile(
    new URL('./default-theme.mdx', import.meta.url),
    'utf8',
  )
  const section =
    heading === undefined
      ? document
      : document
          .split(/^#{2,3} /m)
          .find((entry) => entry.startsWith(`${heading}\n`))
  if (section === undefined)
    throw new Error(`The guide has no ${heading} section.`)

  return Array.from(
    section.matchAll(/```tsx?([^\n]*)\n([\s\S]*?)```/g),
    (match) => ({
      name: match[1]!.match(/title="([^"]+)"/)?.[1],
      source: match[2]!,
    }),
  ).filter((example) => example.source.includes('import '))
}

/** Builds one example through the filesystem compiler and returns its rules, without the bundled variable and scheme blocks. */
async function build(options: build.Options) {
  const { example, name } = options
  const directory = Path.join(root, name)
  const file = Path.basename(example.name ?? 'Example.tsx')
  await Fs.mkdir(directory)
  // Module-level definitions emit only when exported or applied.
  await Fs.writeFile(
    Path.join(directory, file),
    example.source.replace(/^(const|namespace) /gm, 'export $1 '),
  )

  await using host = await Host.create({
    outDir: Path.join(directory, 'dist'),
    packageId: 'default-theme',
    root: directory,
  })
  await host.build()

  const css = await Fs.readFile(
    Path.join(directory, 'dist', `${file}.css`),
    'utf8',
  )
  return css
    .split('\n\n')
    .filter((block) => !/^\.(z-theme-|z_scheme-)/.test(block))
    .join('\n\n')
}

declare namespace build {
  type Options = {
    /** Example extracted from the guide. */
    example: { name?: string | undefined; source: string }
    /** Directory name, unique within the fixture root. */
    name: string
  }
}

describe('Default Theme guide', () => {
  test('exports runtime helpers and leaves authoring to the compiler', () => {
    // The published module, not the source alias this suite resolves.
    const published = ChildProcess.spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const entry = await import('zyzz/default'); console.log(typeof entry.style, typeof entry.variants)",
      ],
      { cwd: root, encoding: 'utf8', timeout: 30000 },
    )

    expect(published.stdout).toMatchInlineSnapshot(`
      "undefined undefined
      "
    `)
    expect(Object.keys(appearance)).toMatchInlineSnapshot(`
      [
        "get",
        "set",
      ]
    `)
    expect(
      script().includes('localStorage.getItem("zyzz")'),
    ).toMatchInlineSnapshot(`true`)
    expect(vars({ colorScheme: 'dark' })).toMatchInlineSnapshot(`
      {
        "className": "z-theme-default-theme z_scheme-dark",
        "style": {
          "colorScheme": "dark",
        },
      }
    `)
  })

  test('builds the overview and walkthrough styles', async () => {
    const [card] = await examples('Overview')
    const [account] = await examples('Style Elements')

    expect(await build({ example: card!, name: 'overview' }))
      .toMatchInlineSnapshot(`
        ".z_default-hZwzVo0 {
          border-radius: var(--z-default-radius-lg, .5rem);
        }

        .z_default-hZwzVo1 {
          color: var(--z-default-color-blue-700, #0072f5);
        }

        .z_default-hZwzVo2 {
          padding: var(--z-default-spacing-4, 1rem);
        }

        .z_default-hZwzVo3 {
          font-family: var(--z-default-typography-heading-20-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
        }

        .z_default-hZwzVo4 {
          font-size: var(--z-default-typography-heading-20-fontSize, 20px);
        }

        .z_default-hZwzVo5 {
          font-weight: var(--z-default-typography-heading-20-fontWeight, 600);
        }

        .z_default-hZwzVo6 {
          letter-spacing: var(--z-default-typography-heading-20-letterSpacing, -.4px);
        }

        .z_default-hZwzVo7 {
          line-height: var(--z-default-typography-heading-20-lineHeight, 26px);
        }
        "
      `)
    expect(await build({ example: account!, name: 'walkthrough' }))
      .toMatchInlineSnapshot(`
        ".z_default-Spuo_V0 {
          color: var(--z-default-color-gray-900, light-dark(#4d4d4d, #a1a1a1));
        }

        .z_default-Spuo_V1 {
          font-family: var(--z-default-typography-copy-14-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
        }

        .z_default-Spuo_V2 {
          font-size: var(--z-default-typography-copy-14-fontSize, 14px);
        }

        .z_default-Spuo_V3 {
          font-weight: var(--z-default-typography-copy-14-fontWeight, 400);
        }

        .z_default-Spuo_V4 {
          letter-spacing: var(--z-default-typography-copy-14-letterSpacing, 0px);
        }

        .z_default-Spuo_V5 {
          line-height: var(--z-default-typography-copy-14-lineHeight, 20px);
        }

        .z_default-Spuo_V6 {
          background-color: var(--z-default-color-background-surface, light-dark(#fff, #0a0a0a));
        }

        .z_default-Spuo_V7 {
          border-radius: var(--z-default-radius-md, .375rem);
        }

        .z_default-Spuo_V8 {
          box-shadow: var(--z-default-shadow-sm, 0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a);
        }

        .z_default-Spuo_V9 {
          color: var(--z-default-color-foreground, light-dark(#171717, #ededed));
        }

        .z_default-Spuo_Va {
          display: grid;
        }

        .z_default-Spuo_Vb {
          gap: var(--z-default-spacing-2, .5rem);
        }

        .z_default-Spuo_Vc {
          padding: var(--z-default-spacing-6, 1.5rem);
        }

        .z_default-Spuo_Vd {
          font-family: var(--z-default-typography-heading-20-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
        }

        .z_default-Spuo_Ve {
          font-size: var(--z-default-typography-heading-20-fontSize, 20px);
        }

        .z_default-Spuo_Vf {
          font-weight: var(--z-default-typography-heading-20-fontWeight, 600);
        }

        .z_default-Spuo_Vg {
          letter-spacing: var(--z-default-typography-heading-20-letterSpacing, -.4px);
        }

        .z_default-Spuo_Vh {
          line-height: var(--z-default-typography-heading-20-lineHeight, 26px);
        }
        "
      `)
  })

  test('builds the Use Colors recipe', async () => {
    const [example] = await examples('Use Colors')

    expect(await build({ example: example!, name: 'colors' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          background-color: var(--z-default-color-background-surface, light-dark(#fff, #0a0a0a));
        }

        .z_default-aTfGk41 {
          color: var(--z-default-color-foreground, light-dark(#171717, #ededed));
        }
        "
      `)
  })

  test('builds the Use Spacing recipe', async () => {
    const [example] = await examples('Use Spacing')

    expect(await build({ example: example!, name: 'spacing' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          gap: var(--z-default-spacing-px, 1px);
        }

        .z_default-aTfGk41 {
          padding: var(--z-default-spacing-4, 1rem);
        }

        .z_default-aTfGk42 {
          height: var(--z-default-spacing-3-5, .875rem);
        }

        .z_default-aTfGk43 {
          margin-top: 13px;
        }
        "
      `)
  })

  test('builds the Set Fonts recipe', async () => {
    const [example] = await examples('Set Fonts')

    expect(await build({ example: example!, name: 'fonts' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          font-family: var(--z-default-fontFamily-mono, "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
        }

        .z_default-aTfGk41 {
          font-size: var(--z-default-fontSize-sm, .875rem);
        }

        .z_default-aTfGk42 {
          font-weight: var(--z-default-fontWeight-medium, 500);
        }

        .z_default-aTfGk43 {
          line-height: var(--z-default-lineHeight-relaxed, 1.625);
        }
        "
      `)
  })

  test('builds the Size Elements recipe', async () => {
    const [example] = await examples('Size Elements')

    expect(await build({ example: example!, name: 'sizes' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          aspect-ratio: var(--z-default-aspect-video, 16 / 9);
        }

        .z_default-aTfGk41 {
          border-radius: var(--z-default-radius-xl, .75rem);
        }

        .z_default-aTfGk42 {
          max-width: var(--z-default-container-2xl, 42rem);
        }
        "
      `)
  })

  test('builds the Apply Effects recipe', async () => {
    const [example] = await examples('Apply Effects')

    expect(await build({ example: example!, name: 'effects' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          animation: var(--z-default-animate-spin, z-kid-zyzz_2d_spin 1s linear infinite);
        }

        .z_default-aTfGk41 {
          box-shadow: var(--z-default-shadow-md, 0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a);
        }
        "
      `)
  })

  test('builds the Reference Effects recipe', async () => {
    const [example] = await examples('Reference Effects')

    expect(await build({ example: example!, name: 'references' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          backdrop-filter: blur(var(--z-default-blur-md, 12px));
        }

        .z_default-aTfGk41 {
          box-shadow: var(--z-default-insetShadow-sm, inset 0 2px 4px #0000000d);
        }
        "
      `)
  })

  test('builds the Use Query Aliases recipe', async () => {
    const [example] = await examples('Use Query Aliases')

    expect(await build({ example: example!, name: 'queries' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          display: grid;
        }

        @media (width >= 48rem) {
          .z_default-aTfGk41 {
            grid-template-columns: 1fr 1fr;
          }
        }

        .z_default-aTfGk42 {
          @container (width >= 24rem) {
            gap: var(--z-default-spacing-4, 1rem);
          }
        }
        "
      `)
  })

  test('builds the Apply Typography recipe', async () => {
    const [example] = await examples('Apply Typography')

    expect(await build({ example: example!, name: 'typography' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          font-family: var(--z-default-typography-button-14-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
        }

        .z_default-aTfGk41 {
          font-size: var(--z-default-typography-button-14-fontSize, 14px);
        }

        .z_default-aTfGk42 {
          font-weight: var(--z-default-typography-button-14-fontWeight, 500);
        }

        .z_default-aTfGk43 {
          letter-spacing: var(--z-default-typography-button-14-letterSpacing, 0px);
        }

        .z_default-aTfGk44 {
          line-height: var(--z-default-typography-button-14-lineHeight, 20px);
        }
        "
      `)
  })

  test('builds the Use Set Variants recipe', async () => {
    const [example] = await examples('Use Set Variants')

    expect(await build({ example: example!, name: 'set-variants' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          font-family: var(--z-default-typography-label-14-mono-fontFamily, "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
        }

        .z_default-aTfGk41 {
          font-size: var(--z-default-typography-label-14-mono-fontSize, 14px);
        }

        .z_default-aTfGk42 {
          font-weight: var(--z-default-typography-label-14-mono-fontWeight, 400);
        }

        .z_default-aTfGk43 {
          letter-spacing: var(--z-default-typography-label-14-mono-letterSpacing, 0px);
        }

        .z_default-aTfGk44 {
          line-height: var(--z-default-typography-label-14-mono-lineHeight, 20px);
        }

        .z_default-aTfGk45 {
          font-family: var(--z-default-typography-copy-16-strong-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
        }

        .z_default-aTfGk46 {
          font-size: var(--z-default-typography-copy-16-strong-fontSize, 16px);
        }

        .z_default-aTfGk47 {
          font-weight: var(--z-default-typography-copy-16-strong-fontWeight, 550);
        }

        .z_default-aTfGk48 {
          letter-spacing: var(--z-default-typography-copy-16-strong-letterSpacing, 0px);
        }

        .z_default-aTfGk49 {
          line-height: var(--z-default-typography-copy-16-strong-lineHeight, 24px);
        }
        "
      `)
  })

  test('builds the Override Set Fields recipe', async () => {
    const [example] = await examples('Override Set Fields')

    expect(await build({ example: example!, name: 'overrides' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          font-weight: var(--z-default-fontWeight-medium, 500);
        }

        .z_default-aTfGk41 {
          font-family: var(--z-default-typography-copy-14-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
        }

        .z_default-aTfGk42 {
          font-size: var(--z-default-typography-copy-14-fontSize, 14px);
        }

        .z_default-aTfGk43 {
          letter-spacing: var(--z-default-typography-copy-14-letterSpacing, 0px);
        }

        .z_default-aTfGk44 {
          line-height: var(--z-default-typography-copy-14-lineHeight, 20px);
        }

        .z_default-aTfGk45 {
          font-family: var(--z-default-typography-label-13-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji") !important;
        }

        .z_default-aTfGk46 {
          font-size: var(--z-default-typography-label-13-fontSize, 13px) !important;
        }

        .z_default-aTfGk47 {
          font-weight: var(--z-default-typography-label-13-fontWeight, 400) !important;
        }

        .z_default-aTfGk48 {
          letter-spacing: var(--z-default-typography-label-13-letterSpacing, 0px) !important;
        }

        .z_default-aTfGk49 {
          line-height: var(--z-default-typography-label-13-lineHeight, 16px) !important;
        }
        "
      `)
  })

  test('builds the Switch Sets Conditionally recipe', async () => {
    const [example] = await examples('Switch Sets Conditionally')

    expect(await build({ example: example!, name: 'states' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          font-family: var(--z-default-typography-label-14-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
        }

        .z_default-aTfGk41 {
          font-size: var(--z-default-typography-label-14-fontSize, 14px);
        }

        .z_default-aTfGk42 {
          font-weight: var(--z-default-typography-label-14-fontWeight, 400);
        }

        .z_default-aTfGk43 {
          letter-spacing: var(--z-default-typography-label-14-letterSpacing, 0px);
        }

        .z_default-aTfGk44 {
          line-height: var(--z-default-typography-label-14-lineHeight, 20px);
        }

        .z_default-aTfGk45 {
          &:hover {
            font-family: var(--z-default-typography-label-14-strong-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
          }
        }

        .z_default-aTfGk46 {
          &:hover {
            font-size: var(--z-default-typography-label-14-strong-fontSize, 14px);
          }
        }

        .z_default-aTfGk47 {
          &:hover {
            font-weight: var(--z-default-typography-label-14-strong-fontWeight, 500);
          }
        }

        .z_default-aTfGk48 {
          &:hover {
            letter-spacing: var(--z-default-typography-label-14-strong-letterSpacing, 0px);
          }
        }

        .z_default-aTfGk49 {
          &:hover {
            line-height: var(--z-default-typography-label-14-strong-lineHeight, 20px);
          }
        }

        .z_default-aTfGk4a {
          &:where([data-size="lg"]) {
            font-family: var(--z-default-typography-copy-16-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
          }
        }

        .z_default-aTfGk4b {
          &:where([data-size="lg"]) {
            font-size: var(--z-default-typography-copy-16-fontSize, 16px);
          }
        }

        .z_default-aTfGk4c {
          &:where([data-size="lg"]) {
            font-weight: var(--z-default-typography-copy-16-fontWeight, 400);
          }
        }

        .z_default-aTfGk4d {
          &:where([data-size="lg"]) {
            letter-spacing: var(--z-default-typography-copy-16-letterSpacing, 0px);
          }
        }

        .z_default-aTfGk4e {
          &:where([data-size="lg"]) {
            line-height: var(--z-default-typography-copy-16-lineHeight, 24px);
          }
        }

        .z_default-aTfGk4f {
          &:where([data-size="sm"]) {
            font-family: var(--z-default-typography-copy-13-fontFamily, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");
          }
        }

        .z_default-aTfGk4g {
          &:where([data-size="sm"]) {
            font-size: var(--z-default-typography-copy-13-fontSize, 13px);
          }
        }

        .z_default-aTfGk4h {
          &:where([data-size="sm"]) {
            font-weight: var(--z-default-typography-copy-13-fontWeight, 400);
          }
        }

        .z_default-aTfGk4i {
          &:where([data-size="sm"]) {
            letter-spacing: var(--z-default-typography-copy-13-letterSpacing, 0px);
          }
        }

        .z_default-aTfGk4j {
          &:where([data-size="sm"]) {
            line-height: var(--z-default-typography-copy-13-lineHeight, 18px);
          }
        }
        "
      `)
  })

  test('builds the Reference Set Fields recipe', async () => {
    const [example] = await examples('Reference Set Fields')

    expect(await build({ example: example!, name: 'fields' }))
      .toMatchInlineSnapshot(`
        ".z_default-aTfGk40 {
          font-size: var(--z-default-typography-heading-32-fontSize, 32px);
        }
        "
      `)
  })

  test('builds the Load Geist Fonts recipe', async () => {
    const [font] = await examples('Load Geist Fonts')
    const directory = Path.join(root, 'font')
    await Fs.mkdir(directory)
    await Fs.writeFile(Path.join(directory, 'fonts.ts'), font!.source)
    await Fs.writeFile(Path.join(directory, 'Geist.woff2'), '')

    await using host = await Host.create({
      outDir: Path.join(directory, 'dist'),
      packageId: 'default-theme',
      root: directory,
    })
    await host.build()

    expect(await Fs.readFile(Path.join(directory, 'dist/zyzz.css'), 'utf8'))
      .toMatchInlineSnapshot(`
      "@font-face {
        font-display: swap;
        font-family: Geist;
        src: url("Geist.woff2") format("woff2");
      }
      "
    `)
  })

  test('lists the documented raw values', () => {
    expect(tokens.color.blue[700]).toMatchInlineSnapshot(`"#0072f5"`)
    expect(tokens.color.foreground).toMatchInlineSnapshot(`
      {
        "dark": "#ededed",
        "light": "#171717",
      }
    `)
    expect(tokens.color.gray[1000]).toMatchInlineSnapshot(`
      {
        "dark": "#ededed",
        "light": "#171717",
      }
    `)
    expect(tokens.color.black).toMatchInlineSnapshot(`"#000"`)
    expect(tokens.color.white).toMatchInlineSnapshot(`"#fff"`)
    expect(Object.keys(tokens.color)).toMatchInlineSnapshot(`
      [
        "amber",
        "background",
        "black",
        "blue",
        "foreground",
        "gray",
        "grayAlpha",
        "green",
        "pink",
        "purple",
        "red",
        "teal",
        "white",
      ]
    `)
    expect(Object.keys(tokens.color.blue)).toMatchInlineSnapshot(`
      [
        "100",
        "200",
        "300",
        "400",
        "500",
        "600",
        "700",
        "800",
        "900",
        "1000",
      ]
    `)
    expect(tokens.color.background).toMatchInlineSnapshot(`
      {
        "primary": {
          "dark": "#000",
          "light": "#fafafa",
        },
        "surface": {
          "dark": "#0a0a0a",
          "light": "#fff",
        },
      }
    `)
    expect(tokens.spacing).toMatchInlineSnapshot(`
      {
        "0": "0rem",
        "0.5": "0.125rem",
        "1": "0.25rem",
        "1.5": "0.375rem",
        "10": "2.5rem",
        "11": "2.75rem",
        "12": "3rem",
        "14": "3.5rem",
        "16": "4rem",
        "2": "0.5rem",
        "2.5": "0.625rem",
        "20": "5rem",
        "24": "6rem",
        "28": "7rem",
        "3": "0.75rem",
        "3.5": "0.875rem",
        "32": "8rem",
        "36": "9rem",
        "4": "1rem",
        "40": "10rem",
        "44": "11rem",
        "48": "12rem",
        "5": "1.25rem",
        "52": "13rem",
        "56": "14rem",
        "6": "1.5rem",
        "60": "15rem",
        "64": "16rem",
        "7": "1.75rem",
        "72": "18rem",
        "8": "2rem",
        "80": "20rem",
        "9": "2.25rem",
        "96": "24rem",
        "px": "1px",
      }
    `)
    expect(tokens.fontFamily).toMatchInlineSnapshot(`
      {
        "mono": ""Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace",
        "sans": "Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"",
        "serif": "ui-serif, Georgia, Cambria, "Times New Roman", Times, serif",
      }
    `)
    expect(tokens.fontSize).toMatchInlineSnapshot(`
      {
        "2xl": "1.5rem",
        "3xl": "1.875rem",
        "4xl": "2.25rem",
        "5xl": "3rem",
        "6xl": "3.75rem",
        "7xl": "4.5rem",
        "8xl": "6rem",
        "9xl": "8rem",
        "base": "1rem",
        "lg": "1.125rem",
        "sm": "0.875rem",
        "xl": "1.25rem",
        "xs": "0.75rem",
      }
    `)
    expect(tokens.fontWeight).toMatchInlineSnapshot(`
      {
        "black": 900,
        "bold": 700,
        "extrabold": 800,
        "extralight": 200,
        "light": 300,
        "medium": 500,
        "normal": 400,
        "semibold": 600,
        "thin": 100,
      }
    `)
    expect(Object.keys(tokens.letterSpacing)).toMatchInlineSnapshot(`
      [
        "tighter",
        "tight",
        "normal",
        "wide",
        "wider",
        "widest",
      ]
    `)
    expect(tokens.lineHeight).toMatchInlineSnapshot(`
      {
        "loose": 2,
        "normal": 1.5,
        "relaxed": 1.625,
        "snug": 1.375,
        "tight": 1.25,
      }
    `)
    expect(tokens.radius).toMatchInlineSnapshot(`
      {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
        "lg": "0.5rem",
        "md": "0.375rem",
        "sm": "0.25rem",
        "xl": "0.75rem",
        "xs": "0.125rem",
      }
    `)
    expect(tokens.container).toMatchInlineSnapshot(`
      {
        "2xl": "42rem",
        "2xs": "18rem",
        "3xl": "48rem",
        "3xs": "16rem",
        "4xl": "56rem",
        "5xl": "64rem",
        "6xl": "72rem",
        "7xl": "80rem",
        "lg": "32rem",
        "md": "28rem",
        "sm": "24rem",
        "xl": "36rem",
        "xs": "20rem",
      }
    `)
    expect(tokens.aspect).toMatchInlineSnapshot(`
      {
        "video": "16 / 9",
      }
    `)
    expect(Object.keys(tokens.shadow)).toMatchInlineSnapshot(`
      [
        "2xs",
        "xs",
        "sm",
        "md",
        "lg",
        "xl",
        "2xl",
        "inner",
      ]
    `)
    expect(Object.keys(tokens.textShadow)).toMatchInlineSnapshot(`
      [
        "2xs",
        "xs",
        "sm",
        "md",
        "lg",
      ]
    `)
    expect(Object.keys(tokens.perspective)).toMatchInlineSnapshot(`
      [
        "dramatic",
        "near",
        "normal",
        "midrange",
        "distant",
      ]
    `)
    expect(Object.keys(tokens.ease)).toMatchInlineSnapshot(`
      [
        "in",
        "out",
        "in-out",
      ]
    `)
    expect(Object.keys(tokens.animate)).toMatchInlineSnapshot(`
      [
        "spin",
        "ping",
        "pulse",
        "bounce",
      ]
    `)
    expect(tokens.blur).toMatchInlineSnapshot(`
      {
        "2xl": "40px",
        "3xl": "64px",
        "lg": "16px",
        "md": "12px",
        "sm": "8px",
        "xl": "24px",
        "xs": "4px",
      }
    `)
    expect(Object.keys(tokens.dropShadow)).toMatchInlineSnapshot(`
      [
        "xs",
        "sm",
        "md",
        "lg",
        "xl",
        "2xl",
      ]
    `)
    expect(Object.keys(tokens.insetShadow)).toMatchInlineSnapshot(`
      [
        "2xs",
        "xs",
        "sm",
      ]
    `)
    expect(tokens.breakpoint).toMatchInlineSnapshot(`
      {
        "2xl": "96rem",
        "lg": "64rem",
        "md": "48rem",
        "sm": "40rem",
        "xl": "80rem",
      }
    `)
  })

  test('lists the documented set sizes and variants', () => {
    const sets = Object.fromEntries(
      Object.entries(tokens.typography).map((entry) => [
        entry[0],
        Object.entries(entry[1]).map((size) =>
          [
            size[0],
            size[1].fontWeight,
            ...['mono', 'strong', 'subtle'].flatMap((variant) =>
              variant in size[1]
                ? [
                    `${variant} ${(size[1] as Record<string, { fontWeight: number }>)[variant]!.fontWeight}`,
                  ]
                : [],
            ),
          ].join(' '),
        ),
      ]),
    )

    expect(sets.button).toMatchInlineSnapshot(`
      [
        "12 500",
        "14 500",
        "16 500",
      ]
    `)
    expect(sets.copy).toMatchInlineSnapshot(`
      [
        "13 400 mono 400",
        "14 400 strong 550",
        "16 400 strong 550",
        "18 400 strong 550",
        "20 400 strong 550",
        "24 400 strong 550",
      ]
    `)
    expect(sets.heading).toMatchInlineSnapshot(`
      [
        "14 600",
        "16 600 subtle 500",
        "20 600 subtle 500",
        "24 600 subtle 500",
        "32 600 subtle 500",
        "40 600",
        "48 600",
        "56 600",
        "64 600",
        "72 600",
      ]
    `)
    expect(sets.label).toMatchInlineSnapshot(`
      [
        "12 400 mono 400 strong 500",
        "13 400 mono 400 strong 500",
        "14 400 mono 400 strong 500",
        "16 400 strong 500",
        "18 400",
        "20 400",
      ]
    `)
    expect(tokens.typography.heading[32]).toMatchInlineSnapshot(`
      {
        "fontFamily": "Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"",
        "fontSize": "32px",
        "fontWeight": 600,
        "letterSpacing": "-1.28px",
        "lineHeight": "40px",
        "subtle": {
          "fontFamily": "Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"",
          "fontSize": "32px",
          "fontWeight": 500,
          "letterSpacing": "-1.28px",
          "lineHeight": "40px",
        },
      }
    `)
    expect(tokens.typography.label[14].mono.fontFamily).toMatchInlineSnapshot(
      `""Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace"`,
    )
  })

  test('type-checks every example against the published declarations', async () => {
    const files = await Promise.all(
      (await examples())
        // Twoslash blocks that declare expected errors are checked by the site build.
        .filter((example) => !example.source.includes('// @errors'))
        .map(async (example, index) => {
          const directory = Path.join(root, 'types', String(index))
          const file = Path.join(
            directory,
            Path.basename(example.name ?? 'Example.tsx'),
          )
          await Fs.mkdir(directory, { recursive: true })
          await Fs.writeFile(file, example.source)
          return file
        }),
    )

    const checked = ChildProcess.spawnSync(
      process.execPath,
      [
        Path.join(
          Path.dirname(require.resolve('typescript/package.json')),
          'bin/tsc',
        ),
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--exactOptionalPropertyTypes',
        '--noUncheckedIndexedAccess',
        '--skipLibCheck',
        '--jsx',
        'react-jsx',
        '--module',
        'preserve',
        '--moduleResolution',
        'bundler',
        '--customConditions',
        'react-native',
        '--target',
        'ESNext',
        ...files,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30000 },
    )

    expect(files).toHaveLength(18)
    expect(checked.status, checked.stdout + checked.stderr).toBe(0)
  }, 60_000)
})

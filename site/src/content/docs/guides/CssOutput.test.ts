/** Compiles the CSS Output guide's examples and verifies its documented output. @module */
import * as Fs from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Graph } from 'zyzz/compiler'

const source = Fs.readFileSync(
  new URL('./css-output.mdx', import.meta.url),
  'utf8',
)
const fences = [
  ...source.matchAll(/```tsx? title="([^"\n]+)"\n([\s\S]*?)```/g),
].map((match) => ({ code: match[2]!, title: match[1]! }))
// The guide shows the atomic config first and the grouped config second.
const [atomicConfig, groupedConfig] = fences
  .filter((fence) => fence.title === 'zyzz.config.ts')
  .map((fence) => fence.code)
const modules = Object.fromEntries(
  fences
    .filter((fence) => !fence.title.endsWith('.config.ts'))
    .map((fence) => [fence.title, fence.code]),
)

/** Compiles the guide's components against one of its configs. */
function compile(config: string) {
  return Graph.compile({ modules: { ...modules, 'zyzz.config.ts': config } })
}

/** Reads a titled CSS fence and lists its rules. */
function documented(title: string): readonly string[] {
  return rules(
    source.match(
      new RegExp('```css title="' + title + '"\\n([\\s\\S]*?)```'),
    )![1]!,
  )
}

/** Lists the rules in CSS without comments, whitespace, or final semicolons. */
function rules(css: string): readonly string[] {
  return (
    css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, '')
      .replaceAll(';}', '}')
      .match(/[^{};]+\{[^{}]*\}/g) ?? []
  )
}

describe('CSS Output examples', () => {
  test('compiles the documented atomic output', () => {
    const output = compile(atomicConfig!)
    const card = output.modules['Card.tsx']!

    expect(rules(card.css)).toMatchInlineSnapshot(`
      [
        ".z_X8T0-w0{color:red}",
        ".z_X8T0-w1{padding:8px}",
      ]
    `)
    expect(documented('atomic.css')).toMatchInlineSnapshot(`
      [
        ".z_X8T0-w0{color:red}",
        ".z_X8T0-w1{padding:8px}",
      ]
    `)
    expect(Object.values(card.classes)).toMatchInlineSnapshot(`
      [
        "z_X8T0-w0 z_X8T0-w1",
        "z_X8T0-w0",
      ]
    `)
    expect(
      Array.from(
        modules['Card.tsx']!.matchAll(/\/\/ Atomic classes: (.+)/g),
        (match) => match[1],
      ),
    ).toMatchInlineSnapshot(`
      [
        "z_X8T0-w0 z_X8T0-w1",
        "z_X8T0-w0",
      ]
    `)
    expect(
      output.modules['CompactCard.tsx']!.css.includes('padding:4px;'),
    ).toMatchInlineSnapshot('true')
  })

  test('compiles the documented grouped output', () => {
    const output = compile(groupedConfig!)
    const card = output.modules['Card.tsx']!

    expect(rules(card.css)).toMatchInlineSnapshot(`
      [
        ".z_X8T0-w0{color:red;padding:8px}",
        ".z_X8T0-w1{color:red}",
      ]
    `)
    expect(documented('grouped.css')).toMatchInlineSnapshot(`
      [
        ".z_X8T0-w0{color:red;padding:8px}",
        ".z_X8T0-w1{color:red}",
      ]
    `)
    expect(
      output.modules['CompactCard.tsx']!.code.includes('zyzz/runtime'),
    ).toMatchInlineSnapshot('true')
  })

  test('compiles the independent config example', () => {
    const config = fences.find((fence) => fence.title === 'admin.config.ts')!

    expect(
      Object.keys(
        Graph.compile({ modules: { [config.title]: config.code } }).modules,
      ),
    ).toMatchInlineSnapshot(`
      [
        "admin.config.ts",
      ]
    `)
  })

  test('renders the authored card in both modes', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const config of [atomicConfig!, groupedConfig!]) {
        const card = compile(config).modules['Card.tsx']!
        const classes = Object.values(card.classes)

        await page.setContent(
          `<style>${card.css}</style><article class="${classes[0]}"><span class="${classes[1]}">Account</span></article>`,
        )

        expect(
          await page
            .locator('article')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
        expect(
          await page
            .locator('article')
            .evaluate((element) => getComputedStyle(element).padding),
        ).toMatchInlineSnapshot('"8px"')
        expect(
          await page
            .locator('span')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      }
    } finally {
      await browser.close()
    }
  })
})
